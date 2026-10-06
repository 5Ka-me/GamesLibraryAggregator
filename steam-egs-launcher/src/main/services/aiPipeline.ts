import { normalizeTitle } from '@app/shared';
import { chatJson, jsonDefect, parseJson, type ChatMessage, type ChatResult } from './aiClient';
import { getSteamAccount } from './localData';
import { getRegions } from './regions';
import { usdRate } from './fxRates';
import { MODES, type Mode } from './enrichment';
import { findSteamAppId, itemsMeta, storeAbouts, storeSearch, tagNames, wishlistEntries, type StoreItem } from './steamStore';
import { epicStoreDetails, type EpicDetails } from './epicStore';
import { getFactCard, stripMarkup } from './gameFacts';
import { applyFind, factTags, hours1, libraryView, ownedSteamAppids, slug, type FindArgs, type LibGame } from './libraryIndex';
import { hiddenTitleKeys } from './collections';
import { resolveTagsWithin, scoreTexts, semanticSearch, type TagResolution } from './embeddings';
import { fitsPrice, ownedTitleKeys, ownsTitle, storeDiscover } from './similar';
// Types only: assistant.ts imports this module at runtime, so a value import back would be a cycle.
import type { ChatTurn, ContextGame } from './assistant';

// The pipeline for "what should I play" requests. The tool loop lets the model
// decide which tools to call, which costs three to four model rounds and lets a
// small model forget a hard constraint on the way. Here the model is asked for
// the parts only it can do:
//   1. parseIntent — one small JSON call turns the message (plus the earlier
//      turns, for follow-ups such as "more" or "something shorter") into a
//      structured Intent: hard constraints, a soft wish, references, the
//      defining kind when it is not a Steam tag (concept) with well-known
//      examples of it (exemplars), exclusions, and whose games the answer is
//      about (scope).
//   2. selectCandidates — deterministic: hard filters on the library view,
//      semantic ranking through the embedding index, owned exemplars, then the
//      wishlist and the stores (Steam, plus Epic for exemplars Steam does not
//      sell). No chat calls.
//   3. judgeCandidates — one small JSON call checks which candidates really
//      match the request: how many candidates there are says nothing about fit.
//      pickCandidates runs 2 and 3 and falls back to the store when no library
//      game fits.
//   4. explain — one streamed call picks from the CANDIDATES and writes the
//      answer in the shape the tool loop produces.
// Privacy is the same as the tool loop: only game facts and the conversation
// leave the machine — never the Steam id (used locally for the wishlist only).

const INTENT_TURNS = 6;
/** The intent carries a concept line and up to 8 exemplar titles on top of the constraints. */
const INTENT_MAX_TOKENS = 800;
const INTENT_TIMEOUT_MS = 45_000;
const INTENT_TURN_CHARS = 500;
const EXPLAIN_EARLIER_TURNS = 4;
const EXPLAIN_TURN_CHARS = 400;
const EXPLAIN_MAX_TOKENS = 1200;
/** Library games the semantic search returns before the relative floor cuts them down. */
const LIB_POOL_K = 24;
const LIB_MAX = 12;
const WISHLIST_SCAN = 100;
const WISHLIST_MAX = 8;
const STORE_MAX = 12;
/** A candidate scoring more than this below the best one is a worse fit than the list needs. */
const RELATIVE_FLOOR = 0.25;
const SEMANTIC_NOTE = 'semantic index unavailable';
/** Appended to the request when the first reply came back with repeated or empty keys (see jsonDefect). */
const MALFORMED_HINT =
  '\n\nYOUR PREVIOUS REPLY WAS MALFORMED (a key repeated inside one object). Write every key once: each game is one object with exactly one "title" and one "note".';
/** The intent's version of the hint: it has no game objects, and a generic hint made the model fall back to the
 *  default template. */
const INTENT_MALFORMED_HINT =
  '\n\nYOUR PREVIOUS REPLY REPEATED A KEY INSIDE ONE OBJECT. Answer again for the LATEST USER MESSAGE, filling the fields it asks for, with every key written exactly once.';

/** How much of a request an intent carries: the number of fields that differ from the defaults. Used to pick
 *  between a degenerate reply and its retry. */
function intentWeight(i: Intent): number {
  const h = i.hard;
  return [
    i.kind !== 'recommend',
    i.scope !== 'mine',
    !!i.soft,
    i.softTags.length > 0,
    !!i.concept,
    i.exemplars.length > 0,
    i.references.length > 0,
    h.steamTags.length > 0,
    h.modes.length > 0,
    h.maxLengthHours !== null || h.minLengthHours !== null,
    h.installed !== null || h.played !== null,
    h.onSaleOnly || h.maxPrice !== null,
    i.exclude.titles.length > 0 || i.exclude.tags.length > 0,
    i.sessionMinutes !== null,
  ].filter(Boolean).length;
}
/**
 * How long the hard-tag resolution may wait for the embedding pass (a first tag-index sync takes longer). Just
 * above the embedding module's 12 s chat-path request timeout: a stalled endpoint then fails that request with
 * AI_TIMEOUT, which opens its breaker, so the library ranking right after fails fast instead of stalling again.
 * A deadline abort below it would not count as a failure of the endpoint.
 */
const TAG_WAIT_MS = 13_000;
/** Reference and exemplar games whose Steam "More like this" lists the store search starts from. */
const MAX_ANCHORS = 6;
/** Exemplars Steam does not sell, looked up on the Epic store (in parallel, all within EPIC_WAIT_MS). */
const EPIC_LOOKUPS = 3;
const EPIC_WAIT_MS = 10_000;
/** Steam store/wishlist candidates that get a short description for the fit check (one batched, cached call). */
const ABOUT_IDS = 24;
const ABOUT_WAIT_MS = 8_000;
const ABOUT_CHARS = 200;
/** The fit check: one small JSON call that lists the candidates that fit. */
const JUDGE_MAX_TOKENS = 700;
const JUDGE_TIMEOUT_MS = 45_000;
const JUDGE_EARLIER_TURNS = 3;
/** Candidates per origin the fit check sees, best first; each costs about 100–190 prompt tokens. */
const JUDGE_QUOTA: Record<Candidate['origin'], number> = { library: 8, wishlist: 4, store: 10 };
/** A candidate's description as the fit check reads it. */
const JUDGE_ABOUT_CHARS = 160;

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Intent {
  kind: 'recommend' | 'other';
  /** mine: something the user owns (what to play, from my library, installed…); any: a general question about a
   *  kind of game ("what games are there in genre X", "games like X") — library fits AND store; buy: buying / new /
   *  not owned / in the store. Drives `sources` (kept for compatibility, derived in sanitizeIntent). */
  scope: 'mine' | 'any' | 'buy';
  /** Where to look, in order. Derived from `scope`: mine/any → ['library','wishlist','store'] (a library-only
   *  wish stays ['library']); buy → ['wishlist','store'] (or the narrower list the model gave). A narrowing the
   *  model gave decides a mine/any scope it contradicts: no library → buy, library only (with any) → mine. */
  sources: ('library' | 'wishlist' | 'store')[];
  hard: {
    steamTags: string[]; // phrases; resolved to exact Steam tags by the app (VR, Co-op, Steam Deck…)
    modes: Mode[]; // single | coop_local | coop_online | pvp | mmo
    maxLengthHours: number | null;
    minLengthHours: number | null;
    installed: boolean | null;
    played: 'never' | 'any_played' | null;
    onSaleOnly: boolean;
    maxPrice: number | null; // major units of the Steam store currency (converted when the user named another)
  };
  /** The price cap as the user stated it, when that was in another currency than the store's: hard.maxPrice
   *  is then this amount at the daily rate, or null when no rate was available. */
  priceAsked?: { amount: number; currency: string } | null;
  /** Wished feel/content in English, one or two sentences (used for semantic ranking). */
  soft: string;
  /** Tag-like words for the store side ("roguelike", "cozy"). */
  softTags: string[];
  /** The defining genre/mechanic/feel when it is NOT simply a Steam tag, one English line
   *  ("anomaly hunting: spot what changed in a looping place and turn back", "gacha: character-collecting with
   *  randomized summons, live-service, anime style"); null when tags/modes already say it. selectCandidates
   *  appends hard tag phrases no Steam tag matched. */
  concept: string | null;
  /** 0–8 well-known games that clearly belong to the concept or are closest to the references, from the model's
   *  knowledge, exact store titles, real released games only; never the references themselves. */
  exemplars: string[];
  sessionMinutes: number | null;
  /** Games the user named as references ("like Hades"). */
  references: string[];
  /** Titles and kinds to exclude ("Dark Souls", "horror"). */
  exclude: { titles: string[]; tags: string[] };
  count: number; // how many games the user wants (default 5, 1..8)
  confidence: number; // 0..1
  /** One clarifying question in the user's language — only when confidence < CLARIFY_BELOW. */
  question: string | null;
  /** 2–3 concrete readings of a vague request in the user's language, offered as replies under the
   *  question — only when confidence < CLARIFY_BELOW, else []. */
  readings?: string[];
  /** The reading the app acted on, one clause in the user's language. */
  assumption: string | null;
}

/** Below this confidence the assistant asks the intent's question instead of searching. */
export const CLARIFY_BELOW = 0.4;

const DEFAULT_SOURCES: Intent['sources'] = ['library', 'wishlist', 'store'];

// ---------- small helpers ----------

const trim = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const isCancel = (e: unknown): boolean => e instanceof Error && e.message === 'AI_CANCELLED';
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const debug = (msg: string): void => {
  if (process.env.LAUNCHER_AI_DEBUG) console.log(`[ai] ${msg}`);
};
const addNote = (notes: string[], note: string): void => {
  if (!notes.includes(note)) notes.push(note);
};
const checkAbort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new Error('AI_CANCELLED');
};
/** A reply that was billed but is unusable: the error carries its tokens, so the caller's fallback can
 *  still count them in the turn's usage. */
const billedError = (code: string, res: ChatResult): Error =>
  Object.assign(new Error(code), { promptTokens: res.promptTokens, completionTokens: res.completionTokens, model: res.model });

// Steam's regional store currencies by account country. Every other country is priced in US dollars
// (Steam's USD regions: CIS, LATAM, MENA, South Asia, Turkey, Argentina …).
const STEAM_CURRENCY: Record<string, string> = {
  GB: 'GBP', CH: 'CHF', LI: 'CHF', RU: 'RUB', PL: 'PLN', BR: 'BRL', JP: 'JPY', NO: 'NOK', ID: 'IDR', MY: 'MYR', PH: 'PHP',
  SG: 'SGD', TH: 'THB', VN: 'VND', KR: 'KRW', UA: 'UAH', MX: 'MXN', CA: 'CAD', AU: 'AUD', NZ: 'NZD', CN: 'CNY', IN: 'INR',
  CL: 'CLP', PE: 'PEN', CO: 'COP', ZA: 'ZAR', HK: 'HKD', TW: 'TWD', SA: 'SAR', AE: 'AED', IL: 'ILS', KZ: 'KZT', KW: 'KWD',
  QA: 'QAR', CR: 'CRC', UY: 'UYU',
};
/** Countries Steam prices in euros: the EU and the European countries without a Steam currency of their own. */
const STEAM_EURO = new Set('AD AL AT BA BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IS IT LT LU LV MC ME MK MT NL PT RO RS SE SI SK SM VA XK'.split(' '));

/** ISO code of the currency Steam store prices (GetItems, storeDiscover) are in for this account's region.
 *  Only this code reaches the model, never the country or anything else about the account. */
export function storeCurrency(): string {
  const cc = getRegions().steamCc;
  return STEAM_CURRENCY[cc] ?? (STEAM_EURO.has(cc) ? 'EUR' : 'USD');
}

/** Signs and words a model may write instead of an ISO currency code. */
const CURRENCY_SIGNS: Record<string, string> = { $: 'USD', US$: 'USD', DOLLAR: 'USD', DOLLARS: 'USD', '€': 'EUR', EURO: 'EUR', EUROS: 'EUR', '£': 'GBP', '₽': 'RUB', '₴': 'UAH', '₸': 'KZT', ZŁ: 'PLN' };

/** An ISO 4217 code from the model's currency field (or a sign next to a price), else null. */
function currencyCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  return CURRENCY_SIGNS[s] ?? null;
}

/** A price the model may write as a number or a string ("$10", "1,000", "9,99 USD"): the amount and any
 *  currency sign in it. Number("$10") would be NaN and silently drop the cap. */
function parsePrice(v: unknown): { amount: number | null; currency: string | null } {
  if (typeof v === 'number') return { amount: Number.isFinite(v) ? v : null, currency: null };
  if (typeof v !== 'string' || !v.trim()) return { amount: null, currency: null };
  const digits = v.replace(/[^\d.,]/g, '');
  // "1,000" is a thousands separator, "9,99" a decimal comma.
  const plain = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits) ? digits.replace(/,/g, '') : digits.replace(',', '.');
  const n = plain ? Number(plain) : NaN;
  return { amount: Number.isFinite(n) ? n : null, currency: currencyCode(v.replace(/[\d\s.,]/g, '')) };
}

/** A price cap in another currency → the store currency at the daily rate; null when a rate is unknown. */
async function convertPrice(p: { amount: number; currency: string }, to: string): Promise<number | null> {
  const [from, toRate] = await Promise.all([usdRate(p.currency).catch(() => null), usdRate(to).catch(() => null)]);
  if (!from || !toRate) return null;
  return Math.round((p.amount / from) * toRate * 100) / 100;
}

/**
 * A price cap as the user stated it (`currency`: ISO code or sign; null/unknown = the store currency) in
 * store-currency units, for the tool loop's store_discover; null when no exchange rate is known.
 */
export async function capInStoreCurrency(amount: number, currency: unknown): Promise<number | null> {
  const from = currencyCode(currency);
  const to = storeCurrency();
  if (!from || from === to || amount === 0) return amount;
  return convertPrice({ amount, currency: from }, to);
}

/** Games the assistant showed as cards in a turn; `games` is optional on ChatTurn (absent in old renderers). */
function turnGames(t: ChatTurn): string[] {
  const g = (t as { games?: unknown }).games;
  return Array.isArray(g) ? g.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 8) : [];
}

/**
 * Normalized titles the assistant already recommended in this conversation: the cards of earlier
 * assistant turns (`games`) plus the **bold** titles of their text. The caller passes these to
 * selectCandidates as `exclude`, so "more" means new games.
 */
export function shownTitleKeys(turns: ChatTurn[]): Set<string> {
  const out = new Set<string>();
  for (const t of turns) {
    if (t.role !== 'assistant') continue;
    for (const g of turnGames(t)) out.add(normalizeTitle(g));
    for (const m of String(t.content ?? '').matchAll(/\*\*([^*\n]{2,120})\*\*/g)) out.add(normalizeTitle(m[1]));
  }
  out.delete('');
  return out;
}

/**
 * The answer language as a word for the prompts. The rule is "the language of the latest message",
 * and naming it explicitly keeps small models from drifting to the UI language (profiles' pitches may
 * be written in it). The app speaks English and Russian; any other Latin-script language is left to
 * the model.
 */
function answerLanguage(text: string, lang: string): string {
  if (/[Ѐ-ӿ]/.test(text)) return 'Russian';
  if (/[A-Za-z]/.test(text)) return 'English (unless the latest message is clearly in another language)';
  return lang === 'ru' ? 'Russian' : 'English';
}

const originLabel = (o: ContextGame['origin']): string =>
  o === 'library' ? 'in their library' : o === 'wishlist' ? 'on their Steam wishlist' : 'from the Steam store, not owned';

function turnLine(t: ChatTurn, max: number): string {
  const games = t.role === 'assistant' ? turnGames(t) : [];
  return `${t.role === 'user' ? 'User' : 'Assistant'}: ${trim(oneLine(String(t.content ?? '')), max)}${games.length ? ` [games shown: ${games.join('; ')}]` : ''}`;
}

// ---------- pre-check ----------

// Requests for picks, in English and Russian. Russian stems are matched without \b: JavaScript's word
// boundary only knows ASCII letters.
const REC_STRONG_EN =
  /\b(recommend\w*|suggest\w*|similar|alike|what (should|can|could|shall|do|would) (i|we) play|what to play|something to play|(play|playing) (tonight|today|now|this (evening|weekend))|in the mood for|looking for (a |an |some )?(game|something)|find me|pick (me )?(a|an|one|some|something)|give me (a |an |some )?(game|something)|games? (like|similar)|something (like|similar)|anything (like|similar)|more like)\b/i;
const REC_STRONG_RU =
  /(посовет|порекоменд|рекоменд|подскаж\S* (игр|во что|что поиграть)|похож|наподобие|в духе|по типу|во что (бы )?(по)?играть|что (бы )?(по)?играть|поиграть|сыграть|на вечер|подбер|подобрать|выбери|найди\S* (мне )?(игр|что-нибудь|что-то)|хочу (игр|что-нибудь|что-то)|какую игру|какие игры)/i;
const GAME_NOUN = /\b(games?|something|anything)\b|игр|что-нибудь|что-то|что нибудь/i;
const DESCRIPTOR =
  /\b(vr|co-?op|coop|multiplayer|split.?screen|couch|short|quick|long|cozy|cosy|relax\w*|chill\w*|calm|horror|scary|rogue\w*|metroidvania|souls-?like|puzzle\w*|story|narrative|open.world|anime|pixel|indie|strategy|rpg|shooter|platformer|survival|farming|steam deck|deck|installed|unplayed|never (played|launched|started)|backlog|on sale|discount\w*|cheap\w*|free|under \$?\d+|tonight|weekend|evening|with (a )?friends?|for two)\b|кооп|вдво[её]м|для двоих|на одном экране|сплит|диван|с друг|коротк|быстр|длинн|долг|уютн|расслаб|спокойн|хоррор|ужас|страшн|рогалик|головолом|сюжет|аниме|пиксел|инди|стратег|шутер|выживан|ферм|деке|установлен|не запускал|не играл|бэклог|распродаж|скидк|дешев|бесплатн|до \d+|вечер|выходн/i;
// Clear signs of a question about stats, items or one named game — those stay with the tool loop.
// Deliberately not "hours" or "cards": "games under 5 hours" and "card games" are requests for picks.
const OTHER_TOPIC =
  /\b(how many|how much|in total|total (hours|playtime)|stat(s|istics)?|achievements?|inventory|items?|skins?|trading cards?|collections?|worth (buying|it|the price)|price of|reviews? (of|for)|release date|who (made|developed))\b|сколько|всего|статист|ачив|достижен|инвентар|предмет|скин|карточк|коллекц|стоит ли (покуп|брать|купить)|цена на|отзывы (о|на|про)|когда вышл|разработ/i;
const ATTACHED_REF = /\b(these|those|them|this one|such|like (this|that|it))\b|эти|этих|этим|таки|подобн|похож|аналог/i;
const FOLLOW_UP =
  /\b(more|another|others|something else|anything else|different( ones?)?|shorter|longer|cheaper|easier|harder|newer|older)\b|ещ[её]|други[ехм]|другое|другую|покороче|подлиннее|подольше|подешевле|попроще|посложнее|поновее|иначе/i;
/** A short message that only refines the earlier request ("more", "something shorter", in either language). */
const bareFollowUp = (s: string): boolean => s.trim().length <= 80 && FOLLOW_UP.test(s);
// Picking among the games already shown or attached ("which of these…", "which one of them…", in either
// language). The pipeline excludes exactly those games, so such a turn belongs to the tool loop, which has
// them as given. The Cyrillic lookbehind stands in for a word start in Russian (\b only knows ASCII), so a
// pronoun that ends a longer word ("nothing of these" spelled as one word) does not match.
const CHOOSE_AMONG_EN =
  /\b(which|what) one\b|\b(which|what|one|pick|choose|best|better)\s+(one\s+)?(of|from|among)\s+(these|those|them|the (games|ones|list|picks|options))\b|\b(among|between|out of)\s+(these|those|them)\b/i;
const CHOOSE_AMONG_RU =
  /(?<![а-яё])(как(ую|ая|ой|ое|ие|их|ого|им)|котор\S*|что|одн(у|а|ого))\s+из\s+(них|этих|тех|этого|того|списка|предложенн|перечисленн|вышеперечисленн)|(?<![а-яё])выбер\S*\s+(из|между)\s+(них|ними|этих|этими|тех|теми|списка)|(?<![а-яё])между\s+(ними|этими|теми)/i;
// A follow-up about one game already shown ("tell me more about the first one", in either language): "more"
// here is not "more games".
const ABOUT_ONE_EN = /\bthe (first|second|third|fourth|fifth|last|other) (one|game)\b|\babout (it|them|that one|this one|that game|this game)\b/i;
const ABOUT_ONE_RU = /(?<![а-яё])(про|о|об|насч[её]т)\s+(не[её]|него|них|эту|этой|перв\S*|втор\S*|трет\S*|четв[её]рт\S*|пят\S*|последн\S*)/i;
// Listing or counting the user's own games ("what VR games do I have", "which games do I have installed",
// in either language): the tool loop lists them all with a total; the pipeline would cut them to a handful
// of picks.
const LISTING_EN =
  /\b(do|did) i (have|own)\b|\bhave i got\b|\bgames i (have|own)\b|\b(show|list) (me )?(all )?(of )?my\b|\bwhich of my\b|\b(are|is) in my (library|collection)\b/i;
const LISTING_RU =
  /(?<![а-яё])(как(ие|ая|ой|ую|их)|что)\s+(\S+\s+){0,3}у меня (есть|установлен\S*|в библиотеке)|(?<![а-яё])(есть ли|имеются ли) у меня|(?<![а-яё])покажи\S*\s+(мне\s+)?(все|мои|моих)|(?<![а-яё])перечисли|(?<![а-яё])какие из моих/i;
/** Russian verbs of asking for a pick; a listing question that has one is a request for picks after all. */
const REC_VERB_RU = /(посовет|порекоменд|рекоменд|подскаж|подбер|подобрать|выбери|выбрать|поиграть|сыграть|на вечер|похож|наподобие|в духе|по типу)/i;
// A general question about a kind of game ("what games are there in genre X", in either language) wants
// picks too: fitting library games plus the store. Kept apart from REC_STRONG_*: the listing check above
// lets REC_STRONG_EN through, and "what roguelike genre games do I have" must stay a listing question.
// A kind named without the word for games ("what extraction shooters are there", in either language) is a genre
// question too.
const GENRE_EN = /\b(what|which) games (are there|exist)\b|\bgames in the .{1,40} genre\b|\b(what|which) (\S+\s+){1,3}(are there|exist)\b/i;
const GENRE_RU = /(?<![а-яё])какие\s+(есть\s+|бывают\s+)?игры|игр\S*\s+в\s+жанре|(?<![а-яё])в\s+жанре|(?<![а-яё])какие\s+(есть|бывают|существуют)\s+[а-яёa-z]/i;
/** The bare word "genre" counts only next to a game noun ("a genre of games", in either language). */
const GENRE_WORD = /\bgenres?\b|жанр/i;
/** Asking for one game's genre ("what genre is Hades", in either language) is a question about that game. */
const GENRE_OF_ONE = /\bwhat genre (is|are|does)\b|(?<![а-яё])(какой|какого|что за)\s+жанр/i;
/** Words that make it a question about the user's own games ("my", "I have", in either language). */
const OWN_WORDS = /\b(my|mine|i (have|own))\b|у меня|(?<![а-яё])мо(и|их|ей|ём|ем|ими)(?![а-яё])/i;
const genreQuestion = (s: string): boolean =>
  !OWN_WORDS.test(s) && !OTHER_TOPIC.test(s) && !GENRE_OF_ONE.test(s) && (GENRE_EN.test(s) || GENRE_RU.test(s) || (GENRE_WORD.test(s) && GAME_NOUN.test(s)));

/** Did the previous exchange end with game picks (so a bare "more" continues it)? */
function lastWasRecommendation(history: ChatTurn[]): boolean {
  let i = history.length - 1;
  while (i >= 0 && history[i].role !== 'assistant') i--;
  if (i < 0) return false;
  if (turnGames(history[i]).length) return true;
  let u = i - 1;
  while (u >= 0 && history[u].role !== 'user') u--;
  if (u < 0) return false;
  const prev = String(history[u].content ?? '');
  return REC_STRONG_EN.test(prev) || REC_STRONG_RU.test(prev) || genreQuestion(prev) || (GAME_NOUN.test(prev) && DESCRIPTOR.test(prev) && !OTHER_TOPIC.test(prev));
}

/** Cheap pre-check: does this turn look like a recommendation request at all? (regex over EN+RU words,
 *  general questions about a kind of game, attached games + "like these", follow-ups such as "more" in
 *  either language after a recommendation). Picking among the shown or attached games and listing the
 *  user's own games stay with the tool loop. */
export function looksLikeRecommendation(lastUser: string, history: ChatTurn[], context: ContextGame[]): boolean {
  const text = String(lastUser ?? '').trim();
  if (!text) return false;
  if ((CHOOSE_AMONG_EN.test(text) || CHOOSE_AMONG_RU.test(text)) && (context.length > 0 || shownTitleKeys(history).size > 0)) return false;
  if ((LISTING_EN.test(text) || LISTING_RU.test(text)) && !REC_STRONG_EN.test(text) && !REC_VERB_RU.test(text)) return false;
  if (REC_STRONG_EN.test(text) || REC_STRONG_RU.test(text) || genreQuestion(text)) return true;
  if (context.length && ATTACHED_REF.test(text)) return true;
  // A false positive only costs one small intent call (kind "other" → tool loop), so short follow-ups pass.
  if (bareFollowUp(text) && !ABOUT_ONE_EN.test(text) && !ABOUT_ONE_RU.test(text) && lastWasRecommendation(history)) return true;
  return GAME_NOUN.test(text) && DESCRIPTOR.test(text) && !OTHER_TOPIC.test(text);
}

// ---------- step 1: intent ----------

const INTENT_SYSTEM = `You read a chat inside a game-library app (Steam + Epic Games Store) and turn the user's LATEST message into a search intent. You do not pick games: the app searches the library, the Steam wishlist and the stores with your intent. Output JSON only, with every field present (these are the defaults):
{"kind":"recommend","scope":"mine","sources":["library","wishlist","store"],"hard":{"steamTags":[],"modes":[],"maxLengthHours":null,"minLengthHours":null,"installed":null,"played":null,"onSaleOnly":false,"maxPrice":null,"maxPriceCurrency":null},"soft":"","softTags":[],"concept":null,"exemplars":[],"sessionMinutes":null,"references":[],"exclude":{"titles":[],"tags":[]},"count":5,"confidence":0.8,"question":null,"readings":[],"assumption":null}

# kind
- "recommend": the user wants NEW game picks — what to play, games like X, a kind or mood of game, games for a situation, a general question about which games of a kind exist ("what games are there in genre X"), "more" / "others" after earlier picks.
- "other": anything else — statistics or hours, achievements, inventory / items / skins, the price or reviews of a named game, "is X worth buying", collections, facts about one game, chit-chat; choosing among or asking about the games already shown or attached ("which of these should I play first", "which of them is shorter", "tell me about the first one", in any language); listing or counting the user's own games ("what VR games do I have", "show my installed games", "which of my games are Deck verified", in any language) unless the user also asks for a pick. For "other" leave every other field at its default.

# Fields
- scope: whose games the answer is about (the words below in any language):
  - "mine": something the user owns — what to play ("what should I play tonight", "something for this evening", "what to play next"), "from my library", "that I have", "installed", "my backlog".
  - "any": a general question about a kind of game, not limited to what the user owns — "what games are there in genre X", "which games exist where you …", "games like X", "anything similar to X". The app shows the fitting library games AND store games.
  - "buy": buying, something new, not owned, in the store, on sale, under a price, from the wishlist ("what should I buy", "in the store", "that I don't have yet", "from my wishlist").
  - A message that asks what to play (now, tonight, next) is "mine" even when it also says "like X"; "any" is for questions about which games exist.
- sources: where to look, in order; the app derives it from scope. Change the default only to narrow it: only the store → ["store"]; only the wishlist → ["wishlist"]; only the user's library ("in my library", "that I own", "installed", "my backlog") → ["library"].
- hard: what EVERY game must satisfy — only what the user explicitly asked for; anything vaguer goes to soft.
  - steamTags: REAL Steam tags only, in English, for required features or kinds: VR → "VR" ("VR only" → "VR Only"); Steam Deck → "Steam Deck" ("Deck verified" → "Steam Deck Verified"); anime → "Anime"; roguelike → "Roguelike"; NSFW / adult / erotic → "Sexual Content"; pixel art → "Pixel Graphics"; also "Hidden Object", "Detective", "Metroidvania", "Souls-like", "Deckbuilding" and the like. Only when the kind is a requirement ("VR games", "anime games"); a flavour ("a bit like a roguelike") goes to softTags. A genre or mechanic that is NOT a Steam tag ("anomaly hunting", "gacha", "extraction shooter") never goes here: it goes to concept. Play modes (co-op, PvP, MMO, single-player, split screen) go to modes, never here.
  - modes: values from MODES ({{modes}}). co-op / with a friend / together → ["coop_online","coop_local"]; online co-op → ["coop_online"]; couch / split screen → ["coop_local"]; PvP / competitive → ["pvp"]; MMO → ["mmo"]; single-player → ["single"].
  - maxLengthHours / minLengthHours: hours to finish the game. "short" → max 6; "very short" / "in one evening" → max 3; "long" → min 30; "under 10 hours" → max 10.
  - installed: true for "installed / ready to play / no download"; false for "not installed"; else null.
  - played: "never" for never played / never launched / unplayed / backlog; "any_played" for played before / return to / revisit; else null.
  - onSaleOnly: true for on sale / discounted / a deal.
  - maxPrice: "under N", "cheaper than N", "up to N" → N as a plain number, exactly as the user said it (do not convert; the app does); "free" → 0; else null.
  - maxPriceCurrency: the ISO 4217 code of the currency the user named with the price ("$10", "10 dollars" → "USD"; "€" → "EUR"; rubles → "RUB"; hryvnias → "UAH"; tenge → "KZT"; "zł" → "PLN"; in any language); null when they named none — a bare number is in the STORE CURRENCY given in the message.
- soft: the wished feel and content in English, 1–2 sentences, for meaning-based ranking ("relaxed farming and crafting, no combat, fine in short sessions"). For "like X" describe what X is like (genre, mechanics, feel) from your knowledge. "" when the message names nothing beyond hard constraints.
- softTags: up to 5 English tag-like words for the store side ("roguelike", "cozy", "pixel graphics").
- concept: the defining genre, mechanic or feel when it is NOT simply a Steam tag — one English line naming it and how it plays: "anomaly hunting: spot what changed in a looping place and turn back"; "gacha: character collecting with randomized summons, live-service, anime style". For "like X", the trait that sets X apart from its broad genre, when it is not a tag (Genshin Impact → gacha, not "open-world RPG"). null when steamTags / modes already say it, or when the request names no kind.
- exemplars: 0–8 well-known games that clearly belong to the concept or are the closest to the references, from your knowledge — exact store titles of real, released games, never the references themselves. Anomaly hunting → ["The Exit 8","Platform 8","I'm on Observation Duty","Shinkansen 0"]; gacha → ["Genshin Impact","Wuthering Waves","Honkai: Star Rail","Zenless Zone Zero","Tower of Fantasy","Infinity Nikki"]; "like Genshin Impact" → the same without Genshin Impact; "like Hades" → ["Dead Cells","Hades II","Children of Morta"]; "cozy farming" → ["Stardew Valley","Coral Island","Sun Haven"]. They anchor the store search, so give 3–8 whenever the request names a kind of game, a setting or "like X" — also when X is not a game but a meme, film or place ("like the Backrooms" → liminal-space games such as "The Complex: Found Footage", "Anemoiapolis", "POOLS"). [] only when the request names no kind or reference (only hard constraints, only a mood).
- sessionMinutes: the length of one play session ("for 30 minutes", "an hour tonight"; "a quick session" → 20); else null. This is NOT the game's length.
- references: games the user named as examples ("like Hades" → ["Hades"]), titles as the user means them, in their store spelling (fix obvious typos and transliterations: Genshin Impact written in Cyrillic → "Genshin Impact"). A game the LATEST message names after "like", "similar to", "such as" or the same words in another language is ALWAYS a reference — also in a follow-up that keeps the earlier concept, and also when it is the best-known game of that concept; it is then never in exemplars. "similar to these / like them" with ATTACHED GAMES → the attached titles.
- exclude.titles: games the user rules out ("not Dark Souls", "except Stardew Valley"). exclude.tags: kinds the user rules out, in English ("no horror" → ["horror"], "no pixel art" → ["pixel graphics"]).
- count: how many games the user wants ("three" → 3, "a couple" → 2, "one game" → 1); default 5; 1–8.
- confidence 0–1: 0.7 or more when the request names any constraint, mood, kind, situation or reference — even a single word such as "horror" or "co-op"; below 0.4 only when it cannot be acted on sensibly (e.g. "game?", "something").
- question: one short clarifying question in the language of the latest message — only when confidence < 0.4; else null.
- readings: only when confidence < 0.4 — 2–3 concrete readings of the request the user could send instead, each ≤ 60 characters, in the language of the latest message ("co-op games for tonight", "a short story game"); else [].
- assumption: when the request is ambiguous, the reading you chose as one short clause in the language of the latest message ("co-op = online or local"); null when it is unambiguous.

# Follow-ups
"more", "others", "something shorter", "cheaper", "but online" (in any language) continue the earlier request in the CONVERSATION (it starts at the ORIGINAL REQUEST when one is given): copy its intent (scope, sources, hard, soft, softTags, concept, exemplars, references, exclude, count) and apply only the change — shorter → lower maxLengthHours (6 → 3; none → 6); longer → raise minLengthHours; cheaper → lower maxPrice, or onSaleOnly true; "more" → the same intent plus other well-known exemplars of the same kind (the app skips games already shown). A message that names a reference or a kind of its own ("yes, but games like X") is a new request about it, even when it continues the conversation; when the earlier request asked for a kind the reference belongs to (a gacha question, then "like Genshin Impact"), keep that concept. A new topic replaces the earlier intent.

# Rules
- Hard constraints are only what the user asked for; never invent constraints, and hard constraints win over soft wishes.
- Attached games are excluded automatically; do not put them in exclude.
- Words in any language map to the same English values (concept and soft in English, exemplars and references as the stores spell the titles); question, readings and assumption use the language of the latest message.`;

/** Mode words a model may produce instead of the vocabulary values. */
const MODE_ALIASES: Record<string, Mode[]> = {
  coop: ['coop_online', 'coop_local'],
  co_op: ['coop_online', 'coop_local'],
  cooperative: ['coop_online', 'coop_local'],
  online_coop: ['coop_online'],
  online_co_op: ['coop_online'],
  local_coop: ['coop_local'],
  local_co_op: ['coop_local'],
  couch_coop: ['coop_local'],
  split_screen: ['coop_local'],
  singleplayer: ['single'],
  single_player: ['single'],
  versus: ['pvp'],
  competitive: ['pvp'],
  mmorpg: ['mmo'],
};

/** Strings only, whitespace-collapsed, length-capped, deduped case-insensitively, at most `max`. */
function cleanStrings(v: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = oneLine(x).slice(0, maxLen);
    const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

const posNum = (v: unknown, max: number): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 10) / 10 : null;
};

const textOrNull = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = oneLine(v);
  return s ? trim(s, max) : null;
};

/** A model's "no value" spelled as text ("null", "none", "n/a") is no value. */
const NO_VALUE = /^(null|none|n\/a|-|—)$/i;

/**
 * Exemplar titles: deduped by normalized title, never a reference (nor an edition of one), at most 8.
 * A model that lists the reference among "games like it" would otherwise recommend the reference.
 */
function cleanExemplars(v: unknown, references: string[]): string[] {
  const refKeys = references.map(normalizeTitle).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of cleanStrings(v, 16, 120)) {
    const k = normalizeTitle(t);
    if (!k || seen.has(k) || refKeys.some((r) => r === k || isEditionPair(r, k))) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

/** Defensive validation of the model's intent: wrong types fall back to defaults, lists are capped. A price
 *  cap in another currency than `storeCur` is kept as stated in `priceAsked`; parseIntent converts it. */
function sanitizeIntent(raw: any, storeCur: string): Intent {
  const r = raw && typeof raw === 'object' ? raw : {};
  const h = r.hard && typeof r.hard === 'object' ? r.hard : {};
  const ex = r.exclude && typeof r.exclude === 'object' ? r.exclude : {};

  let sources = cleanStrings(r.sources, 3, 20)
    .map((s) => s.toLowerCase())
    .filter((s): s is Intent['sources'][number] => s === 'library' || s === 'wishlist' || s === 'store');
  const libraryOnlyAsked = sources.length === 1 && sources[0] === 'library';
  // An old-style reply without a scope still says it through its sources.
  let scope: Intent['scope'] =
    r.scope === 'mine' || r.scope === 'any' || r.scope === 'buy' ? r.scope : sources.length && !sources.includes('library') ? 'buy' : 'mine';
  // The scope rules overlap ("games like X" is any, "in the store" is buy), and the template defaults to mine
  // with all three sources, so a narrowed list is a deliberate choice: it wins over a scope that contradicts it.
  // "Find something like Hades in the store" stays a store search, "what do I own like Hades" a library one. A
  // buy scope with a library-only list keeps buying: owned games cannot be bought.
  if (scope !== 'buy' && sources.length && !sources.includes('library')) scope = 'buy';
  else if (scope === 'any' && libraryOnlyAsked) scope = 'mine';
  // The scope decides the sources; a narrower list the model gave for the same scope stays.
  if (scope === 'any') sources = [...DEFAULT_SOURCES];
  else if (scope === 'buy') {
    sources = sources.filter((s) => s !== 'library');
    if (!sources.length) sources = ['wishlist', 'store'];
  } else sources = libraryOnlyAsked ? ['library'] : [...DEFAULT_SOURCES];

  const modeOf = (v: string): Mode[] | undefined => {
    const s = slug(v);
    if ((MODES as readonly string[]).includes(s)) return [s as Mode];
    return Object.prototype.hasOwnProperty.call(MODE_ALIASES, s) ? MODE_ALIASES[s] : undefined;
  };
  const modes: Mode[] = [];
  for (const m of cleanStrings(h.modes, 6, 30)) for (const x of modeOf(m) ?? []) if (!modes.includes(x)) modes.push(x);
  // A play mode written as a Steam tag ("Co-op") would become a hard tag group: store games would need that
  // exact tag on top of the mode check, and every Epic game would drop out (Epic has no Steam tags). It is a
  // mode; it fills `modes` when the model left them empty.
  const steamTags: string[] = [];
  const tagModes: Mode[] = [];
  for (const p of cleanStrings(h.steamTags, 5, 40)) {
    const m = modeOf(p);
    if (!m) steamTags.push(p);
    else for (const x of m) if (!tagModes.includes(x)) tagModes.push(x);
  }
  if (!modes.length) modes.push(...tagModes);

  let maxLengthHours = posNum(h.maxLengthHours, 1000);
  let minLengthHours = posNum(h.minLengthHours, 1000);
  if (maxLengthHours !== null && minLengthHours !== null && minLengthHours > maxLengthHours) [maxLengthHours, minLengthHours] = [minLengthHours, maxLengthHours];

  const price = parsePrice(h.maxPrice);
  // Generous bound: a $10-ish cap is 160 000 in IDR and 250 000 in VND.
  const maxPrice = price.amount !== null && price.amount >= 0 && price.amount <= 10_000_000 ? price.amount : null;
  const priceCurrency = currencyCode(h.maxPriceCurrency) ?? price.currency;
  const priceAsked = maxPrice !== null && maxPrice > 0 && priceCurrency && priceCurrency !== storeCur ? { amount: maxPrice, currency: priceCurrency } : null;
  const onSaleOnly = h.onSaleOnly === true;
  const installed = typeof h.installed === 'boolean' ? h.installed : null;
  const played = h.played === 'never' || h.played === 'any_played' ? h.played : null;

  // Owned games cost nothing, so a price or sale wish is about buying.
  if (onSaleOnly || maxPrice !== null) {
    scope = 'buy';
    sources = sources.filter((s) => s !== 'library');
    if (!sources.length) sources = ['wishlist', 'store'];
  }
  // Install state and playtime exist only for owned games.
  if (installed !== null || played !== null) {
    scope = 'mine';
    sources = ['library'];
  }
  const references = cleanStrings(r.references, 5, 120);
  const concept = textOrNull(r.concept, 200);

  const sessionRaw = posNum(r.sessionMinutes, 600);
  const sessionMinutes = sessionRaw !== null && sessionRaw >= 5 ? Math.round(sessionRaw) : null;
  const countRaw = Number(r.count);
  const count = Number.isFinite(countRaw) && countRaw >= 1 ? Math.min(8, Math.round(countRaw)) : 5;
  const confRaw = typeof r.confidence === 'string' ? Number(r.confidence) : r.confidence;
  // A model that answers in percent (80) still means 0.8.
  const confidence =
    typeof confRaw === 'number' && Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw > 1 && confRaw <= 100 ? confRaw / 100 : confRaw)) : 0.7;

  return {
    kind: r.kind === 'recommend' ? 'recommend' : 'other',
    scope,
    sources,
    hard: {
      steamTags,
      modes,
      maxLengthHours,
      minLengthHours,
      installed,
      played,
      onSaleOnly,
      maxPrice,
    },
    priceAsked,
    soft: typeof r.soft === 'string' ? trim(oneLine(r.soft), 400) : '',
    softTags: cleanStrings(r.softTags, 6, 40),
    concept: concept && !NO_VALUE.test(concept) ? concept : null,
    exemplars: cleanExemplars(r.exemplars, references),
    sessionMinutes,
    references,
    exclude: { titles: cleanStrings(ex.titles, 10, 120), tags: cleanStrings(ex.tags, 6, 40) },
    count,
    confidence,
    question: confidence < CLARIFY_BELOW ? textOrNull(r.question, 300) : null,
    // Readings become clickable replies: an over-long one is dropped rather than cut mid-word.
    readings:
      confidence < CLARIFY_BELOW
        ? cleanStrings(r.readings, 6, 200)
            .filter((s) => s.length <= 80)
            .slice(0, 3)
        : [],
    assumption: textOrNull(r.assumption, 200),
  };
}

/** Step 1: one small JSON call on the user's model (not streamed, 800 max tokens, 45 s timeout). Sees the
 *  last 6 turns (plus the request a chain of bare follow-ups started from, when it is older), the attached
 *  games, today's date and the store currency. Follow-ups merge with the earlier request's constraints. A
 *  price cap in another currency is converted to the store currency at the daily rate. An unreadable reply
 *  throws AI_BAD_INTENT carrying the call's tokens. */
export async function parseIntent(
  turns: ChatTurn[],
  lang: string,
  context: ContextGame[]
): Promise<{ intent: Intent; promptTokens: number; completionTokens: number; model: string }> {
  const recent = turns.slice(-INTENT_TURNS);
  let li = recent.length - 1;
  while (li >= 0 && recent[li].role !== 'user') li--;
  if (li < 0) throw new Error('AI_EMPTY');
  const latest = String(recent[li].content ?? '');
  const earlier = recent.slice(0, li);
  // "more" → "shorter" → "more": by the third follow-up the request they refine has left the window, and
  // the model would merge with the follow-ups alone. The newest user turn that is not a bare follow-up
  // goes in on its own when it is older than the window.
  let anchor: ChatTurn | null = null;
  if (bareFollowUp(latest)) {
    const start = turns.length - recent.length;
    for (let i = start + li - 1; i >= 0; i--) {
      if (turns[i].role !== 'user' || bareFollowUp(String(turns[i].content ?? ''))) continue;
      if (i < start) anchor = turns[i];
      break;
    }
  }
  const storeCur = storeCurrency();
  const user = [
    `Today: ${new Date().toISOString().slice(0, 10)}. Interface language: ${lang === 'ru' ? 'Russian' : 'English'}. Language of the latest message: ${answerLanguage(latest, lang)}. STORE CURRENCY: ${storeCur}.`,
    context.length
      ? `ATTACHED GAMES (the subject of the conversation; "these", "them", "similar to these" refer to them):\n${context
          .slice(0, 20)
          .map((g) => `- ${g.title} (${originLabel(g.origin)})`)
          .join('\n')}`
      : '',
    anchor ? `ORIGINAL REQUEST (the earlier message the follow-ups below continue):\n${turnLine(anchor, INTENT_TURN_CHARS)}` : '',
    earlier.length ? `CONVERSATION (oldest first):\n${earlier.map((t) => turnLine(t, INTENT_TURN_CHARS)).join('\n')}` : '',
    `LATEST USER MESSAGE:\n${trim(latest.trim(), 1500)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: INTENT_SYSTEM.replace('{{modes}}', MODES.join(', ')) },
    { role: 'user', content: user },
  ];
  let res = await chatJson(messages, INTENT_MAX_TOKENS, { timeoutMs: INTENT_TIMEOUT_MS });
  let parsed = parseJson(res.text);
  // Same guard as explain(): a reply with repeated or empty keys may have lost fields even when it parses.
  // The retry is not always better — seen live, it came back as the bare default template and dropped
  // "story-rich, no horror" — so the reply that carries more of the request wins.
  const defect = jsonDefect(res.text);
  if (defect) {
    debug(`${res.model} intent degenerated (${defect}), asking once more`);
    const first = res;
    const retry = await chatJson([messages[0], { role: 'user', content: user + INTENT_MALFORMED_HINT }], INTENT_MAX_TOKENS, { timeoutMs: INTENT_TIMEOUT_MS });
    const again = parseJson(retry.text);
    const weightOf = (p: unknown): number => (p && typeof p === 'object' ? intentWeight(sanitizeIntent(p, storeCur)) : -1);
    if (weightOf(again) >= weightOf(parsed)) {
      res = retry;
      parsed = again;
    }
    res = { ...res, promptTokens: retry.promptTokens + first.promptTokens, completionTokens: retry.completionTokens + first.completionTokens };
  }
  debug(`${res.model} intent: ${res.text.replace(/\s+/g, ' ').slice(0, 400)}`);
  // An unreadable reply is an error, so the caller falls back to the tool loop instead of guessing.
  if (!parsed || typeof parsed !== 'object') throw billedError('AI_BAD_INTENT', res);
  const intent = sanitizeIntent(parsed, storeCur);
  // "under $10" against UAH prices would cap at 10 hryvnias: compare in the store currency, or not at all.
  if (intent.priceAsked) intent.hard.maxPrice = await convertPrice(intent.priceAsked, storeCur);
  return { intent, promptTokens: res.promptTokens, completionTokens: res.completionTokens, model: res.model };
}

// ---------- step 2: candidates ----------

export interface Candidate {
  title: string;
  origin: 'library' | 'wishlist' | 'store';
  score: number;
  /** Compact facts for the fit check and the explanation call (same spirit as describe()/describeStore()). */
  facts: Record<string, unknown>;
  lib?: LibGame; // library candidates
  appid?: number | null; // wishlist/store candidates (null for Epic store games)
  /** Which store a non-library candidate is from. */
  store?: 'steam' | 'epic';
  /** The Epic store offer of an Epic store candidate (what its card shows). */
  epic?: { url: string | null; image: string | null; price: string | null; discountPct: number | null; namespace: string | null } | null;
  /** The fit check's verdict; absent = not verified (the check failed or did not cover it). */
  fit?: 'yes' | 'partly';
}

/** One hard tag phrase as the filters apply it: a game must carry ANY of `names`. */
interface TagGroup {
  phrase: string;
  /** Exact English Steam tag names (or the raw phrase when nothing resolved). */
  names: string[];
  /** Nothing resolved: `names` is the raw phrase and is matched as a substring. */
  literal: boolean;
  /** The one name storeDiscover requires (it adds the platform-flag equivalents itself). */
  require: string;
}

/**
 * Store-side stand-ins for profile play modes: a game passes when it carries any of them. Couch play needs
 * a local tag: the generic "Co-op" also marks online-only games (Deep Rock Galactic, Phasmophobia). The
 * generic reading (both co-op modes) still accepts "Co-op" through coop_online.
 */
const MODE_TAGS: Record<Mode, string[]> = {
  single: ['Singleplayer'],
  coop_online: ['Co-op', 'Online Co-Op', 'Co-op Campaign'],
  coop_local: ['Local Co-Op', 'Split Screen', 'Local Multiplayer', '4 Player Local'],
  pvp: ['PvP', 'Competitive', 'Team-Based', 'eSports'],
  mmo: ['Massively Multiplayer', 'MMORPG'],
};
/** The tag the store search browses by for a mode ("Co-op" when both co-op modes are wanted, see selectCandidates). */
const MODE_BROWSE: Record<Mode, string> = { single: 'Singleplayer', coop_online: 'Co-op', coop_local: 'Local Co-Op', pvp: 'PvP', mmo: 'Massively Multiplayer' };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word containment: "horror" is in "Survival Horror", "war" is not in "Warhammer 40K". */
const hasWord = (hay: string, needle: string): boolean =>
  !!needle && new RegExp(`(^|[\\s_/-])${escapeRe(needle.toLowerCase())}($|[\\s_/-])`).test(hay.toLowerCase());

/**
 * A hard phrase → the tag names that satisfy it. Platform flags are expanded by hand: "Steam Deck"
 * accepts Verified or Playable (never Unsupported, which an embedding match could rank close), "VR"
 * accepts the user tag and both official flags. Only an explicit Steam Deck phrase is the platform:
 * "deck-building" / "deck builder" is the Deckbuilding tag, which the resolver maps.
 */
function hardGroup(phrase: string, r: TagResolution | undefined): TagGroup {
  const p = phrase.toLowerCase().trim();
  const deck = /\bsteam[\s-]*deck\b|стим[\s-]*дек/.test(p) || /^deck([\s-]*(verified|playable|compatible|friendly))?$/.test(p);
  if (deck && !/unsupported|deck[\s-]*build/.test(p)) {
    return /verified|провер/.test(p)
      ? { phrase, names: ['Steam Deck Verified'], literal: false, require: 'Steam Deck Verified' }
      : { phrase, names: ['Steam Deck Verified', 'Steam Deck Playable'], literal: false, require: 'Steam Deck Playable' };
  }
  if (/\bvr\b|virtual reality/.test(p)) {
    return /\bonly\b/.test(p)
      ? { phrase, names: ['VR Only'], literal: false, require: 'VR Only' }
      : { phrase, names: ['VR', 'VR Supported', 'VR Only'], literal: false, require: 'VR' };
  }
  const names = resolvedNames(r, 2);
  return names.length ? { phrase, names, literal: false, require: names[0] } : { phrase, names: [phrase], literal: true, require: phrase };
}

/** Exact hits only when the phrase matched exactly; otherwise the best embedding matches. */
function resolvedNames(r: TagResolution | undefined, top: number): string[] {
  if (!r || !Array.isArray(r.tags)) return [];
  const exact = r.exact ? r.tags.filter((t) => t.score >= 0.999) : [];
  const list = (exact.length ? exact : r.tags).map((t) => t.name).filter((n): n is string => typeof n === 'string' && !!n);
  const wantsUnsupported = /unsupported/i.test(r.phrase ?? '');
  return [...new Set(list.filter((n) => wantsUnsupported || !/unsupported/i.test(n)))].slice(0, top);
}

/**
 * All phrases in one resolver call. The embedding pass gets TAG_WAIT_MS (past it only exact names and
 * synonyms resolve); a phrase left unresolved is matched literally.
 */
async function resolvePhrases(phrases: string[], signal?: AbortSignal): Promise<Map<string, TagResolution>> {
  const list = [...new Set(phrases.map((p) => p.trim()).filter(Boolean))];
  const out = new Map<string, TagResolution>();
  if (!list.length) return out;
  let res: TagResolution[] = [];
  try {
    res = await resolveTagsWithin(list, TAG_WAIT_MS, { top: 3, signal });
  } catch (e) {
    if (isCancel(e)) throw e;
    debug(`resolveTags failed: ${errText(e)}`);
  }
  list.forEach((p, i) => {
    const hit = res.find((r) => r?.phrase?.trim().toLowerCase() === p.toLowerCase()) ?? res[i];
    if (hit) out.set(p.toLowerCase(), hit);
  });
  return out;
}

/**
 * itemsMeta tags come in the UI language (Russian names for 'ru'); the filters work with English names,
 * so map them back through the tag ids. Platform-flag tags are English already and pass unchanged.
 */
async function englishTagMapper(lang: string): Promise<(tag: string) => string> {
  if (lang === 'en') return (t) => t;
  try {
    const [local, en] = await Promise.all([tagNames(lang), tagNames('en')]);
    const map = new Map<string, string>();
    for (const [id, name] of Object.entries(local)) if (en[id] && !map.has(name)) map.set(name, en[id]);
    return (t) => map.get(t) ?? t;
  } catch {
    return (t) => t;
  }
}

/** Everything a game must satisfy, resolved once and shared by the library, wishlist and store checks. */
interface HardFilter {
  groups: TagGroup[];
  /** Lowercased store tags any of which satisfies the requested modes; [] = no mode constraint. */
  modeTags: string[];
  /** Exact English tag names a game must not carry (whole-word match, so sub-genres count too). */
  excludedTags: string[];
  /** The same plus the raw phrases, lowercased — matched against profile genres/moods/themes/keywords. */
  excludedWords: string[];
  onSaleOnly: boolean;
  maxPrice: number | null;
  /** Tag names the facts list first (after platform flags), so the explanation sees what the filter matched. */
  want: string[];
}

const tagsHold = (tags: string[], g: TagGroup): boolean => {
  const lower = tags.map((t) => t.toLowerCase());
  return g.literal ? lower.some((t) => t.includes(g.names[0].toLowerCase())) : g.names.some((n) => lower.includes(n.toLowerCase()));
};

/** Wishlist/store item vs the hard filter (tags already mapped to English). Length cannot be checked here. */
function storeItemFits(it: StoreItem, tags: string[], f: HardFilter): boolean {
  if (!f.groups.every((g) => tagsHold(tags, g))) return false;
  if (f.modeTags.length && !tags.some((t) => f.modeTags.includes(t.toLowerCase()))) return false;
  if (f.excludedTags.some((x) => tags.some((t) => hasWord(t, x)))) return false;
  if (f.onSaleOnly && !((it.price?.discountPct ?? 0) > 0)) return false;
  // Same rule as storeDiscover: free passes any cap and is all a cap of 0 accepts; an unknown price fails a cap.
  if (f.maxPrice !== null && !fitsPrice(it, f.maxPrice)) return false;
  return true;
}

/** Profile fields an excluded word must not appear in. */
function profileWords(g: LibGame): string[] {
  const p = g.profile;
  if (!p) return [];
  return [...p.genres, ...p.moods, ...p.themes, ...(p.keywords ?? [])].map((x) => String(x).replace(/_/g, ' '));
}

function libraryExcluded(g: LibGame, f: HardFilter): boolean {
  if (f.excludedTags.some((x) => g.storeTags.some((t) => hasWord(t, x)))) return true;
  if (!f.excludedWords.length) return false;
  const fields = profileWords(g);
  return f.excludedWords.some((w) => fields.some((v) => hasWord(v, w)));
}

const STOP_WORDS = new Set(
  'the and with for game games that like some something not but are its very more less about minutes session into from you your play played playing where which this have has'.split(' ')
);
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

/** Word overlap between the wish and a game's tags/profile — the ranking when embeddings are unavailable. */
function lexicalScore(query: Set<string>, g: LibGame | null, tags: string[]): number {
  if (!query.size) return 0;
  const p = g?.profile;
  const bag = new Set(
    words([...(p?.keywords ?? []), ...(p?.themes ?? []), ...(p?.genres ?? []), ...(p?.moods ?? []), ...tags].map((x) => String(x).replace(/_/g, ' ')).join(' '))
  );
  let hit = 0;
  for (const w of query) {
    if (bag.has(w)) hit++;
    // Cheap stemming: "roguelikes" ~ "roguelike", "farming" ~ "farm…".
    else if (w.length >= 5 && [...bag].some((b) => b.length >= 5 && (b.startsWith(w.slice(0, 5)) || w.startsWith(b.slice(0, 5))))) hit += 0.5;
  }
  return hit / query.size;
}

/** Keeps candidates within RELATIVE_FLOOR of the best score, at most `max`, best first. */
function floorCut<T extends { score: number }>(list: T[], max: number): T[] {
  const sorted = [...list].sort((a, b) => b.score - a.score);
  if (!sorted.length) return sorted;
  const best = sorted[0].score;
  return sorted.filter((x) => x.score >= best - RELATIVE_FLOOR).slice(0, max);
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// An owned copy of a reference game may carry an edition suffix ("Control" → "CONTROL Ultimate Edition"):
// the rule gameFacts uses for Steam twins, plus remasters, which measure the same game. A bare prefix is
// not enough: "Rust" is not "Rustler", "Dark Souls" is not "Dark Souls III", "Portal" is not "Portal 2".
const REF_EDITION_SUFFIX =
  /^(standard|ultimate|definitive|deluxe|digitaldeluxe|complete|gold|premium|enhanced|special|legendary|anniversary|collectors|gameoftheyear|goty|remastered|redux|directorscut)?(edition)?$/;

/** Two normalized titles that differ only by an edition suffix (shared with assistant.ts for Epic cards). */
export function isEditionPair(a: string, b: string): boolean {
  if (a === b || !a || !b) return false;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short) && REF_EDITION_SUFFIX.test(long.slice(short.length));
}

/** A store description as one plain line of at most ABOUT_CHARS (markup and entities removed). */
const aboutText = (s: string | null | undefined): string => (s ? trim(oneLine(stripMarkup(s)), ABOUT_CHARS) : '');

/** The store's short description of an owned game, from its fact card ('' when there is none). */
function cardAbout(key: string): string {
  try {
    return aboutText(getFactCard(key)?.shortDescription);
  } catch {
    return ''; // fact store unreadable — the profile facts still stand
  }
}

/** Library facts for the fit check and the explanation: describe() plus pitch (or the summary's first
 *  sentence), keywords, and the store's short description when the profile has no pitch. `want` = tag names
 *  the hard filter asked for (shown first after the platform flags). */
function libFacts(g: LibGame, want: string[]): Record<string, unknown> {
  const p = g.profile;
  const known = !!p && p.known;
  const pitch = known ? (p!.pitch?.trim() || (p!.summary ?? '').split(/(?<=[.!?])\s+/)[0]?.trim() || '') : '';
  const length = known ? (p!.endless ? 'endless' : p!.lengthHours !== null ? `~${p!.lengthHours}h` : null) : null;
  // A pitch says for whom and when a game fits, in the UI language; the store's own description says what
  // it is, which is what the fit check needs when there is no pitch.
  const about = p?.pitch?.trim() ? '' : cardAbout(g.key);
  return {
    title: g.title,
    on: g.sources.map((s) => (s === 'Epic' ? 'EGS' : s)),
    installed: g.installed,
    hoursPlayed: hours1(g.minutes),
    ...(g.lastPlayedAt ? { lastPlayed: g.lastPlayedAt.slice(0, 10) } : {}),
    ...(g.minutes2w > 0 ? { hoursLast2Weeks: hours1(g.minutes2w) } : {}),
    ...(g.progress && g.progress.total > 0 ? { achievements: `${g.progress.unlocked}/${g.progress.total} (${g.progress.percentage}%)` } : {}),
    ...(g.storeTags.length ? { steamTags: factTags(g.storeTags, want, 6) } : {}),
    ...(known
      ? {
          ...(length ? { length } : {}),
          genres: p!.genres.slice(0, 4),
          moods: p!.moods.slice(0, 4),
          modes: p!.modes,
          ...(p!.coopPlayers ? { coop: p!.coopPlayers } : {}),
          ...(pitch ? { pitch: trim(pitch, 240) } : {}),
        }
      : {}),
    ...(p?.keywords?.length ? { keywords: p.keywords.slice(0, 8) } : {}),
    ...(about ? { about } : {}),
  };
}

/** Wishlist/store facts: title, appid, price, discount, reviews, tags ≤ 8 and why it was found. When the user
 *  asked for a length, `length: 'not checked'` says so per game: store games have no length to filter by.
 *  The short description (`about`) is added later, in one batch (addStoreAbouts). */
function storeFacts(it: StoreItem, tags: string[], why: string[], lengthUnchecked: boolean, want: string[]): Record<string, unknown> {
  return {
    title: it.name,
    appid: it.appid,
    ...(lengthUnchecked ? { length: 'not checked' } : {}),
    price: it.price?.formattedFinal ?? (it.isFree ? 'free' : null),
    ...(it.price?.discountPct ? { discount: `-${it.price.discountPct}%` } : {}),
    ...(it.reviewPct != null ? { reviewPct: it.reviewPct } : {}),
    ...(it.reviewCount != null ? { reviewCount: it.reviewCount } : {}),
    ...(tags.length ? { tags: factTags(tags, want) } : {}),
    ...(why.length ? { why: why.slice(0, 3) } : {}),
  };
}

/** The fit check runs when the request says what kind of game it wants beyond the hard filters. */
const needsFitCheck = (i: Intent): boolean => !!i.concept || !!i.soft.trim() || i.references.length > 0 || i.softTags.length > 0;

/** `p`'s value, or `fallback` when `ms` pass first or `p` fails (late work goes on detached, its result dropped). */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Play modes on the Epic store, whose features are free text ("Co-op", "Online Multiplayer", "Single
 * Player"): a game passes a mode wish when any feature or genre matches.
 */
const EPIC_MODE: Record<Mode, RegExp> = {
  single: /single/i,
  coop_online: /co-?op/i,
  coop_local: /co-?op/i,
  pvp: /pvp|competitive|multiplayer/i,
  mmo: /mmo|massively/i,
};

/** An Epic offer as a card: product page, wide cover, the formatted price ("Free" for free games). Shared with
 *  assistant.ts, which makes the same card for Epic games the tool loop names. */
export function epicCardInfo(d: EpicDetails): NonNullable<Candidate['epic']> {
  const free = !!d.isFree || d.price?.final === 0;
  return {
    url: d.storeUrl ?? null,
    image: d.image ?? null,
    price: free ? 'Free' : (d.price?.formattedFinal ?? null),
    discountPct: d.price?.discountPct ? d.price.discountPct : null,
    namespace: d.namespace ?? null,
  };
}

/**
 * Can an Epic offer stand next to the Steam candidates? Epic has no Steam tags, so a hard tag group cannot be
 * verified there (always out); a required mode must show in its features, an excluded kind must not; sale and
 * price as for Steam games, the price converted from the Epic region's currency to the store currency at the
 * daily rate (free passes; an unknown price or rate fails a cap).
 */
async function epicFits(d: EpicDetails, f: HardFilter, modes: Mode[], storeCur: string): Promise<boolean> {
  if (f.groups.length) return false;
  const labels = [...d.genres, ...d.features];
  if (modes.length && !modes.some((m) => labels.some((l) => EPIC_MODE[m].test(l)))) return false;
  if (f.excludedWords.some((x) => labels.some((l) => hasWord(l, x)))) return false;
  if (f.onSaleOnly && !((d.price?.discountPct ?? 0) > 0)) return false;
  if (f.maxPrice === null || d.isFree || d.price?.final === 0) return true;
  const minor = d.price?.final;
  const cur = d.price?.currency?.toUpperCase();
  if (f.maxPrice <= 0 || minor == null || !cur) return false;
  const major = minor / 10 ** minorDigits(cur);
  const amount = cur === storeCur ? major : await convertPrice({ amount: major, currency: cur }, storeCur);
  return amount !== null && amount <= f.maxPrice;
}

/** ISO 4217 currencies without minor units: the yen, the won and the like. */
const ZERO_DECIMAL = new Set('BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF'.split(' '));

/**
 * Digits after the point in an Epic price. EGS reports prices in the currency's minor units, which a
 * zero-decimal currency does not have (¥4,980 comes as 4980, not 498000); Steam always uses hundredths.
 */
const minorDigits = (currency: string): number => (ZERO_DECIMAL.has(currency) ? 0 : 2);

/** An Epic store candidate (an exemplar Steam does not sell): the card's offer plus facts for the model. */
function epicCandidate(d: EpicDetails, score: number, lengthUnchecked: boolean): Candidate {
  const card = epicCardInfo(d);
  const genres = [...new Set([...d.genres, ...d.features])].slice(0, 8);
  const description = aboutText(d.description);
  return {
    title: d.title,
    origin: 'store',
    store: 'epic',
    score: round3(score),
    appid: null,
    epic: card,
    facts: {
      title: d.title,
      store: 'Epic Games Store',
      ...(lengthUnchecked ? { length: 'not checked' } : {}),
      price: card.price === 'Free' ? 'free' : card.price,
      ...(card.discountPct ? { discount: `-${card.discountPct}%` } : {}),
      ...(genres.length ? { genres } : {}),
      ...(description ? { description } : {}),
      why: ['well-known example'],
    },
  };
}

/**
 * Exemplar titles → Steam store games: the exact title (findSteamAppId), else a store-search hit whose
 * normalized title equals it or is an edition of it; hydrated through itemsMeta, released games only.
 * `missing` = the titles the Steam store does not list at all (the Epic store is asked about those).
 */
async function steamExemplars(titles: string[], lang: string): Promise<{ found: Map<string, StoreItem>; missing: string[] }> {
  const rows = await Promise.all(
    titles.map(async (title) => {
      const exact = await findSteamAppId(title, lang).catch(() => null);
      if (exact) return { title, ids: [exact] };
      const want = normalizeTitle(title);
      const hits = await storeSearch(title, lang).catch(() => [] as StoreItem[]);
      const ids = hits
        .filter((h) => {
          const k = normalizeTitle(h.name);
          return h.appid > 0 && (k === want || isEditionPair(k, want));
        })
        .map((h) => h.appid)
        .slice(0, 3);
      return { title, ids };
    })
  );
  const all = [...new Set(rows.flatMap((r) => r.ids))];
  const meta = all.length ? await itemsMeta(all, lang).catch(() => ({}) as Record<number, StoreItem>) : {};
  const found = new Map<string, StoreItem>();
  const missing: string[] = [];
  for (const r of rows) {
    const it = r.ids.map((id) => meta[id]).find((x): x is StoreItem => !!x && (!x.kind || x.kind === 'game') && !x.comingSoon);
    if (it) found.set(r.title, it);
    else if (!r.ids.length) missing.push(r.title);
  }
  return { found, missing };
}

/** Epic offers for exemplars Steam does not sell: at most EPIC_LOOKUPS in parallel, whatever arrived within
 *  EPIC_WAIT_MS; only an offer of exactly that game (or an edition of it) counts, failures are skipped. */
async function epicExemplars(titles: string[], lang: string): Promise<Map<string, EpicDetails>> {
  const out = new Map<string, EpicDetails>();
  const all = Promise.all(
    titles.slice(0, EPIC_LOOKUPS).map(async (title) => {
      const d = await epicStoreDetails(title, null, lang).catch(() => null);
      const want = normalizeTitle(title);
      const got = d ? normalizeTitle(d.title) : '';
      if (d && got && (got === want || isEditionPair(got, want))) out.set(title, d);
    })
  );
  await within(all.then(() => undefined), EPIC_WAIT_MS, undefined);
  // A snapshot: a lookup that answers after the deadline must not change what was already used.
  return new Map(out);
}

/** Short store descriptions for the fit check ("what the game is" beyond its tags) for the first ABOUT_IDS Steam
 *  wishlist/store candidates: cached per game, the rest in one small batched call, within ABOUT_WAIT_MS; failures
 *  change nothing. */
async function addStoreAbouts(candidates: Candidate[]): Promise<void> {
  const list = candidates.filter((c) => c.origin !== 'library' && c.store !== 'epic' && !!c.appid).slice(0, ABOUT_IDS);
  if (!list.length) return;
  const abouts = await within(storeAbouts(list.map((c) => c.appid!)), ABOUT_WAIT_MS, {} as Record<number, string>);
  for (const c of list) {
    const about = aboutText(abouts[c.appid!]);
    if (about) c.facts.about = about;
  }
}

/** Step 2: deterministic selection — no model calls except embeddings. `onStage` receives the stage
 *  starting now ('library_semantic', 'wishlist', 'store_discover') for the "Checking: …" line. `only`
 *  narrows the sources this call gathers (pickCandidates' store fallback). Hard tag phrases no Steam tag
 *  matched are moved from `intent.hard.steamTags` into `intent.concept`, in place, so the fit check and the
 *  explanation read the request the way it was searched. `ownedSetAside` counts the owned games left out on
 *  purpose — the references, earlier picks and attached games (0 when the library was not searched). */
export async function selectCandidates(
  intent: Intent,
  lang: string,
  opts: { exclude: Set<string>; context: ContextGame[]; signal?: AbortSignal; onStage?: (tools: string[]) => void; only?: Intent['sources'] }
): Promise<{ candidates: Candidate[]; stages: string[]; notes: string[]; ownedSetAside: number }> {
  const { signal } = opts;
  const stages: string[] = [];
  const notes: string[] = [];
  const candidates: Candidate[] = [];
  const stage = (name: string): void => {
    checkAbort(signal);
    stages.push(name);
    opts.onStage?.([name]);
  };
  const wants = (s: Intent['sources'][number]): boolean => intent.sources.includes(s) && (!opts.only || opts.only.includes(s));

  // ---- exclusions: earlier picks, attached games, the user's "not X", hidden games ----
  const exact = new Set<string>();
  for (const k of opts.exclude ?? []) exact.add(normalizeTitle(k));
  for (const g of opts.context ?? []) exact.add(normalizeTitle(g.title));
  for (const k of await hiddenTitleKeys().catch(() => new Set<string>())) exact.add(k);
  // "not Dark Souls" means the series too, so the user's own exclusions also match as a prefix/part.
  const fuzzy = intent.exclude.titles.map(normalizeTitle).filter((k) => k.length >= 3);
  for (const k of fuzzy) exact.add(k);

  // ---- library view (also the owned set for the wishlist, the store and the reference lookup) ----
  const useLibrary = wants('library');
  const lib = await libraryView(false, useLibrary).catch(() => [] as LibGame[]);
  const libByKey = new Map(lib.map((g) => [g.key, g]));
  // Steam twins of Epic-only games count as owned, and so do store names that differ by an edition suffix.
  const ownedIds = ownedSteamAppids(lib);
  const ownedKeys = ownedTitleKeys(lib);
  /** The owned copy of a title: the same normalized title, or the same game with an edition suffix. */
  const ownedCopy = (k: string): LibGame | undefined => (k ? (libByKey.get(k) ?? lib.find((g) => isEditionPair(g.key, k))) : undefined);

  // A reference game is the measure, not a pick ("like Hades" must not suggest Hades).
  const refGames: LibGame[] = [];
  for (const ref of intent.references) {
    const k = normalizeTitle(ref);
    if (!k) continue;
    exact.add(k);
    const own = ownedCopy(k);
    if (own && !refGames.includes(own)) {
      refGames.push(own);
      exact.add(own.key);
    }
  }
  const isExcluded = (key: string): boolean => !key || exact.has(key) || fuzzy.some((f) => f.length >= 5 && key.includes(f));
  // "No library game matches" is only true of the games that were looked at: an owned reference ("like
  // Genshin Impact") or an owned game shown a turn earlier may well be one.
  const setAside = new Set([...(opts.exclude ?? [])].map(normalizeTitle));
  for (const g of opts.context ?? []) setAside.add(normalizeTitle(g.title));
  const ownedSetAside = useLibrary ? lib.filter((g) => refGames.includes(g) || setAside.has(g.key)).length : 0;

  // ---- hard tags and excluded tags, resolved to exact Steam names ----
  const resolved = await resolvePhrases([...intent.hard.steamTags, ...intent.exclude.tags], signal);
  const hardGroups = intent.hard.steamTags.map((p) => hardGroup(p, resolved.get(p.toLowerCase())));
  // A phrase no Steam tag matched names a kind of game, not a tag ("gacha", "anomaly hunting"): matched
  // literally it would only empty the list, and the answer would end up talking about tags. It joins the
  // concept, which ranks and is fit-checked; only resolved tags filter.
  const unresolved = hardGroups.filter((g) => g.literal).map((g) => g.phrase);
  if (unresolved.length) {
    intent.hard.steamTags = intent.hard.steamTags.filter((p) => !unresolved.includes(p));
    const have = (intent.concept ?? '').toLowerCase();
    const extra = unresolved.filter((p) => !have.includes(p.toLowerCase()));
    if (extra.length) intent.concept = trim([intent.concept, extra.join(', ')].filter(Boolean).join('; '), 200);
  }
  const groups = hardGroups.filter((g) => !g.literal);
  const excludedTags = [...new Set(intent.exclude.tags.flatMap((p) => resolvedNames(resolved.get(p.toLowerCase()), 3)))];
  const filter: HardFilter = {
    groups,
    modeTags: [...new Set(intent.hard.modes.flatMap((m) => MODE_TAGS[m]).map((t) => t.toLowerCase()))],
    excludedTags,
    excludedWords: [...new Set([...intent.exclude.tags, ...excludedTags].map((w) => w.toLowerCase()))],
    onSaleOnly: intent.hard.onSaleOnly,
    maxPrice: intent.hard.maxPrice,
    want: [...groups.flatMap((g) => g.names), ...intent.hard.modes.flatMap((m) => MODE_TAGS[m])],
  };
  if (intent.priceAsked && intent.hard.maxPrice === null) {
    addNote(notes, `no exchange rate for ${intent.priceAsked.currency} → ${storeCurrency()} was available, so the price cap of ${intent.priceAsked.amount} ${intent.priceAsked.currency} was not applied`);
  }

  // The meaning to rank by: the wish plus the concept. Without either, the hard tags are the best hint.
  const wish = [intent.soft, intent.concept ?? ''].filter(Boolean).join(' ');
  const tagHint = [...groups.map((g) => g.names[0]), ...intent.softTags].join(', ');
  const softQuery = wish || (tagHint ? `Games with: ${tagHint}.` : '');
  const libQuery = softQuery && intent.sessionMinutes ? `${softQuery} Session: about ${intent.sessionMinutes} minutes.` : softQuery;
  const lexQuery = new Set([...words(`${wish} ${intent.softTags.join(' ')} ${tagHint}`), ...refGames.flatMap((g) => words(profileWords(g).join(' ')))]);

  // ---- library ----
  if (useLibrary) {
    stage('library_semantic');
    const h = intent.hard;
    const tags: NonNullable<FindArgs['tags']> = {
      ...(h.modes.length ? { modes: h.modes } : {}),
      ...(h.maxLengthHours !== null ? { maxLengthHours: h.maxLengthHours } : {}),
      ...(h.minLengthHours !== null ? { minLengthHours: h.minLengthHours } : {}),
    };
    const state: FindArgs = {
      ...(h.installed !== null ? { installed: h.installed } : {}),
      ...(h.played !== null ? { played: h.played } : {}),
    };
    const profileTagsAsked = Object.keys(tags).length > 0;
    // Every hard tag must hold (one applyFind per tag, any of its names, intersected), then install and play
    // state and the excluded kinds.
    const beforeProfile = (list: LibGame[]): LibGame[] => {
      let pool = list;
      for (const grp of groups) {
        const keep = new Set(applyFind(pool, { steamTags: grp.names }).map((g) => g.key));
        pool = pool.filter((g) => keep.has(g.key));
      }
      return applyFind(pool, state).filter((g) => !libraryExcluded(g, filter));
    };
    // Modes and length live in AI profiles: games without a usable one cannot be checked, so they are
    // left out (applyFind drops them) and the answer can say how many.
    const withProfile = (list: LibGame[]): LibGame[] => (profileTagsAsked ? applyFind(list, { tags }) : list);
    let pool = beforeProfile(lib.filter((g) => !isExcluded(g.key)));
    if (profileTagsAsked) {
      const unprofiled = pool.filter((g) => !g.profile?.known).length;
      if (unprofiled) {
        const what = [h.modes.length ? 'play modes' : '', h.maxLengthHours !== null || h.minLengthHours !== null ? 'length' : ''].filter(Boolean).join(' and ');
        addNote(notes, `${unprofiled} library games have no usable AI profile, so their ${what} could not be checked; they were left out`);
      }
    }
    pool = withProfile(pool);

    const ranked = floorCut(await rankLibrary(pool, libQuery, refGames, lexQuery, notes, signal), LIB_MAX);
    // Owned exemplars are the surest library fits: they join even when the ranking (or a missing index) would
    // not surface them, above the best ranked game, in the model's order — the hard constraints still hold.
    const named: LibGame[] = [];
    for (const t of intent.exemplars) {
      const g = ownedCopy(normalizeTitle(t));
      if (g && !isExcluded(g.key) && !named.includes(g)) named.push(g);
    }
    // applyFind sorts by playtime, so the survivors are read back in the exemplar order.
    const passed = new Set(withProfile(beforeProfile(named)).map((g) => g.key));
    const owned = named.filter((g) => passed.has(g.key));
    const best = ranked.length ? ranked[0].score : 1;
    owned.forEach((g, i) => {
      candidates.push({ title: g.title, origin: 'library', score: round3(best + 0.01 * (owned.length - i)), facts: { ...libFacts(g, filter.want), exemplar: true }, lib: g });
    });
    for (const { g, score } of ranked) {
      if (passed.has(g.key)) continue;
      candidates.push({ title: g.title, origin: 'library', score: round3(score), facts: libFacts(g, filter.want), lib: g });
    }
  }

  const enough = Math.max(2, intent.count);
  const libraryFirst = intent.sources[0] === 'library';
  // Rule from the tool loop: the wishlist and the store only when the library yields too few games — except
  // for a general question about a kind of game (scope "any"), which shows the store next to the library.
  // How many there are says nothing about fit: pickCandidates sends a "mine" request to the store after all
  // when the fit check finds no library game that matches.
  const satisfied = (): boolean => intent.scope !== 'any' && libraryFirst && candidates.filter((c) => c.origin === 'library').length >= enough;
  const libraryOnly = intent.hard.installed !== null || intent.hard.played !== null;
  const lengthAsked = intent.hard.maxLengthHours !== null || intent.hard.minLengthHours !== null;
  const toEnglish = wants('wishlist') || wants('store') ? await englishTagMapper(lang) : (t: string) => t;

  // ---- wishlist ----
  if (wants('wishlist') && !libraryOnly && !satisfied()) {
    const { steamId } = getSteamAccount();
    if (!steamId) addNote(notes, 'Steam is not signed in, so the wishlist could not be checked');
    else {
      stage('wishlist');
      const entries = await wishlistEntries(steamId).catch(() => []);
      const ids = [...entries].sort((x, y) => x.priority - y.priority).slice(0, WISHLIST_SCAN).map((e) => e.appid);
      const meta = ids.length ? await itemsMeta(ids, lang).catch(() => ({}) as Record<number, StoreItem>) : {};
      const fits: { it: StoreItem; tags: string[] }[] = [];
      for (const id of ids) {
        const it = meta[id];
        if (!it || (it.kind && it.kind !== 'game') || it.comingSoon) continue;
        const key = normalizeTitle(it.name);
        if (isExcluded(key) || ownedIds.has(it.appid) || ownsTitle(ownedKeys, key)) continue;
        const tags = (it.tags ?? []).map(toEnglish);
        if (storeItemFits(it, tags, filter)) fits.push({ it, tags });
      }
      if (fits.length && lengthAsked) addNote(notes, 'game length is unknown for wishlist and store games, so it was not checked for them');
      const scored = await rankStoreTexts(fits, softQuery, lexQuery, notes, signal);
      for (const { it, tags, score } of floorCut(scored, WISHLIST_MAX)) {
        candidates.push({ title: it.name, origin: 'wishlist', store: 'steam', score: round3(score), facts: storeFacts(it, tags, ['on your wishlist'], lengthAsked, filter.want), appid: it.appid });
      }
    }
  }

  // ---- store ----
  if (wants('store') && !libraryOnly && !satisfied()) {
    stage('store_discover');
    const modes = intent.hard.modes;
    // Co-op of either kind is the generic "Co-op" tag; couch play alone browses (and requires) "Local Co-Op".
    const anyCoop = modes.includes('coop_online') && modes.includes('coop_local');
    const modeBrowse = [...new Set(modes.map((m) => (anyCoop && (m === 'coop_online' || m === 'coop_local') ? 'Co-op' : MODE_BROWSE[m])))];
    // One mode tag can be required outright; "single or co-op" can only steer the search.
    const requireTags = [...new Set([...groups.map((g) => g.require), ...(modeBrowse.length === 1 ? modeBrowse : [])])];
    // Store games have no length to filter by; Steam's "Short" tag at least steers a short-game wish (last,
    // so it never becomes the one tag a relaxed search keeps).
    const shortWish = intent.hard.maxLengthHours !== null && intent.hard.maxLengthHours <= 10 ? ['Short'] : [];
    const softTags = [...new Set([...(modeBrowse.length > 1 ? modeBrowse : []), ...intent.softTags, ...shortWish])];
    // Exemplars the user neither owns nor ruled out are store picks of their own. Together with the references
    // they are also where Steam's "More like this" lists start (storeDiscover leaves its anchors out of its
    // own results, which is why the exemplars are added here directly).
    const storeExemplars = intent.exemplars.filter((t) => {
      const k = normalizeTitle(t);
      return !!k && !isExcluded(k) && !ownsTitle(ownedKeys, k) && !ownedCopy(k);
    });
    const anchors: string[] = [];
    for (const t of [...intent.references, ...intent.exemplars]) {
      const k = normalizeTitle(t);
      if (k && !anchors.some((a) => normalizeTitle(a) === k)) anchors.push(t);
    }
    const exemplarItems = (async () => {
      const steam = await steamExemplars(storeExemplars, lang);
      // Epic games cannot be checked against Steam tags, so a hard tag group keeps them out entirely.
      const epic = !groups.length && steam.missing.length ? await epicExemplars(steam.missing, lang) : new Map<string, EpicDetails>();
      return { steam: steam.found, epic };
    })().catch((e: unknown) => {
      debug(`exemplar lookup failed: ${errText(e)}`);
      return { steam: new Map<string, StoreItem>(), epic: new Map<string, EpicDetails>() };
    });
    const discovered = storeDiscover(
      {
        similarTo: anchors.slice(0, MAX_ANCHORS),
        tags: softTags,
        requireTags,
        excludeTags: excludedTags.length ? excludedTags : intent.exclude.tags,
        query: wish || undefined,
        onSaleOnly: intent.hard.onSaleOnly,
        ...(intent.hard.maxPrice !== null ? { maxPrice: intent.hard.maxPrice } : {}),
        excludeOwned: true,
        excludeTitles: [...exact],
        limit: STORE_MAX,
      },
      lang
    ).catch((e: unknown) => {
      if (isCancel(e)) throw e;
      debug(`storeDiscover failed: ${errText(e)}`);
      addNote(notes, 'the Steam store search failed');
      return null;
    });
    const [r, ex] = await Promise.all([discovered, exemplarItems]);
    checkAbort(signal);
    const storeCur = storeCurrency();
    const epicOk = new Map<string, boolean>();
    for (const [title, d] of ex.epic) epicOk.set(title, await epicFits(d, filter, modes, storeCur).catch(() => false));

    // Only the user's own references are worth a note; an exemplar Steam does not sell is simply not used, and
    // neither is a reference the user owns elsewhere (an Epic-only Genshin Impact is no news to its owner).
    const refKeys = new Set(intent.references.map(normalizeTitle));
    const unknownRefs = (r?.unknownRefs ?? []).filter((t) => {
      const k = normalizeTitle(t);
      return refKeys.has(k) && !ownedCopy(k);
    });
    if (unknownRefs.length) addNote(notes, `reference games not found on Steam: ${unknownRefs.join(', ')}`);
    const seen = new Set(candidates.map((c) => c.appid).filter((x): x is number => !!x));
    const seenTitles = new Set(candidates.map((c) => normalizeTitle(c.title)));
    let added = 0;

    // Exemplars first, in the model's order, scored above the "More like this" results.
    const top = Math.max(0, ...(r?.items ?? []).map((d) => d.score));
    for (const [i, title] of storeExemplars.entries()) {
      const score = top + 0.1 + 0.01 * (storeExemplars.length - i);
      const it = ex.steam.get(title);
      if (it) {
        const key = normalizeTitle(it.name);
        if (seen.has(it.appid)) {
          // Already a wishlist candidate: it is a well-known example of the kind as well.
          const c = candidates.find((x) => x.appid === it.appid);
          const why = Array.isArray(c?.facts.why) ? (c!.facts.why as string[]) : [];
          if (c && !why.includes('well-known example')) c.facts.why = [...why, 'well-known example'];
          continue;
        }
        if (isExcluded(key) || ownedIds.has(it.appid) || ownsTitle(ownedKeys, key)) continue;
        const tags = (it.tags ?? []).map(toEnglish);
        if (!storeItemFits(it, tags, filter)) continue;
        seen.add(it.appid);
        seenTitles.add(key);
        candidates.push({ title: it.name, origin: 'store', store: 'steam', score: round3(score), facts: storeFacts(it, tags, ['well-known example'], lengthAsked, filter.want), appid: it.appid });
        added++;
        continue;
      }
      const d = ex.epic.get(title);
      if (!d || !epicOk.get(title)) continue;
      const key = normalizeTitle(d.title);
      if (seenTitles.has(key) || isExcluded(key) || ownsTitle(ownedKeys, key) || ownedCopy(key)) continue;
      seenTitles.add(key);
      candidates.push(epicCandidate(d, score, lengthAsked));
      added++;
    }

    let fromDiscover = 0;
    for (const d of r?.items ?? []) {
      const it = d.item;
      const key = normalizeTitle(it.name);
      if (seen.has(it.appid) || seenTitles.has(key) || isExcluded(key) || ownedIds.has(it.appid) || ownsTitle(ownedKeys, key)) continue;
      const tags = (it.tags ?? []).map(toEnglish);
      // storeDiscover filters too; checking again keeps the hard constraints this module's own.
      if (!storeItemFits(it, tags, filter)) continue;
      seen.add(it.appid);
      seenTitles.add(key);
      candidates.push({ title: it.name, origin: 'store', store: 'steam', score: round3(d.score), facts: storeFacts(it, tags, d.why, lengthAsked, filter.want), appid: it.appid });
      added++;
      if (++fromDiscover >= STORE_MAX) break;
    }
    if (added && lengthAsked) addNote(notes, 'game length is unknown for wishlist and store games, so it was not checked for them');
  }

  // What each store game is, in the store's words, for the fit check.
  if (needsFitCheck(intent)) await addStoreAbouts(candidates);
  checkAbort(signal);
  return { candidates, stages, notes, ownedSetAside };
}

/** Library ranking: semantic search over the hard-filtered pool, lexical overlap when the index is unavailable. */
async function rankLibrary(
  pool: LibGame[],
  query: string,
  refGames: LibGame[],
  lexQuery: Set<string>,
  notes: string[],
  signal?: AbortSignal
): Promise<{ g: LibGame; score: number }[]> {
  if (!pool.length) return [];
  const refKeys = refGames.map((g) => g.key);
  if (!query && !refKeys.length) {
    // Nothing to measure meaning against ("installed games I never played"): ready-to-play and
    // recently touched games first, all within the floor.
    const order = [...pool].sort(
      (a, b) => Number(b.installed) - Number(a.installed) || (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? '') || b.minutes - a.minutes
    );
    return order.map((g, i) => ({ g, score: 1 - i * 0.005 }));
  }
  const lexical = (list: LibGame[]): { g: LibGame; score: number }[] => list.map((g) => ({ g, score: lexicalScore(lexQuery, g, g.storeTags) }));
  try {
    const hits = await semanticSearch(query, { candidates: pool.map((g) => g.key), k: LIB_POOL_K, refKeys, signal });
    const byKey = new Map(pool.map((g) => [g.key, g]));
    const ranked: { g: LibGame; score: number }[] = [];
    for (const h of hits) {
      const g = byKey.get(h.key);
      if (g && Number.isFinite(h.score)) ranked.push({ g, score: h.score });
    }
    if (!ranked.length) throw new Error('INDEX_EMPTY');
    // Hard-filtered games still waiting for a vector are valid picks too; they go below the indexed
    // ones (at the floor) instead of vanishing while the index catches up.
    if (ranked.length < LIB_MAX) {
      const have = new Set(ranked.map((x) => x.g.key));
      const rest = lexical(pool.filter((g) => !have.has(g.key)))
        .sort((a, b) => b.score - a.score)
        .slice(0, LIB_MAX - ranked.length);
      const floor = ranked[0].score - RELATIVE_FLOOR;
      rest.forEach((x, i) => ranked.push({ g: x.g, score: floor + 0.001 * (rest.length - i) }));
    }
    return ranked;
  } catch (e) {
    if (isCancel(e)) throw e;
    debug(`semanticSearch failed: ${errText(e)}`);
    addNote(notes, SEMANTIC_NOTE);
    return lexical(pool);
  }
}

/** Wishlist ranking: embedding similarity of the wish to "<name>. Tags: …", lexical overlap on failure. */
async function rankStoreTexts(
  list: { it: StoreItem; tags: string[] }[],
  query: string,
  lexQuery: Set<string>,
  notes: string[],
  signal?: AbortSignal
): Promise<{ it: StoreItem; tags: string[]; score: number }[]> {
  if (!list.length) return [];
  // No wish to compare with: keep the user's own wishlist priority order.
  if (!query) return list.map((x, i) => ({ ...x, score: 1 - i * 0.005 }));
  try {
    const sims = await scoreTexts(
      query,
      list.map((x) => `${x.it.name}. Tags: ${x.tags.slice(0, 12).join(', ')}`),
      { signal }
    );
    if (sims.length !== list.length) throw new Error('scoreTexts returned a different count');
    return list.map((x, i) => ({ ...x, score: Number.isFinite(sims[i]) ? sims[i] : 0 }));
  } catch (e) {
    if (isCancel(e)) throw e;
    debug(`scoreTexts failed: ${errText(e)}`);
    addNote(notes, SEMANTIC_NOTE);
    return list.map((x) => ({ ...x, score: lexicalScore(lexQuery, null, x.tags) }));
  }
}

// ---------- step 3: fit check ----------

export interface FitResult {
  kept: Candidate[];
  dropped: Candidate[];
  ran: boolean;
  /** The check gave verdicts. false when it did not run, or ran and failed (an error, a timeout, an unreadable
   *  reply): every candidate is then kept unjudged. */
  verified: boolean;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

const JUDGE_SYSTEM = `You check game candidates against a request inside a game-library app (Steam + Epic Games Store). For every candidate decide whether it genuinely matches what the user asked for:
- "yes": it clearly has the defining genre, mechanic or feel asked for (the CONCEPT when one is given);
- "partly": it HAS the defining element, but only as a secondary part or in a weaker form;
- "no": the defining element is missing — even when the genre, setting or mood is similar.
Judge from the candidate's facts and your knowledge of the game; when they disagree, trust the facts. Be strict about specific mechanics: the same broad genre is "no" for a specific mechanic — an open-world RPG without randomized summons is "no" for "gacha", a game that merely has "anomalies" in its world is "no" for "anomaly hunting". EXAMPLES, when given, are well-known games of the asked kind: they show what is meant when the CONCEPT is vague. A mood or feel ("cozy", "tense", "relaxing") is "yes" when the game generally delivers it. For "like X", the reference's own sequels and series entries are "yes". The app has already checked the hard constraints: judge only how well each game fits the wish.
Output JSON only, on one line, listing ONLY the candidates that fit ("yes" or "partly"), in candidate order; every candidate you leave out counts as "no":
{"fits":[{"i":0,"fit":"yes","why":"≤ 6 English words"}]}
"fit" is "yes" or "partly"; "why" says what fits. {"fits":[]} when none fits.`;

type Verdict = { fit: 'yes' | 'partly' | 'no'; why: string };

/** A candidate as the fit check sees it: what it is (tags, keywords, genres, a description), not prices. */
function judgeLine(c: Candidate, i: number): string {
  const f = c.facts as Record<string, unknown>;
  const list = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);
  const tags = c.lib ? factTags(c.lib.storeTags, [], 6) : list(f.tags ?? f.steamTags, 6);
  const keywords = list(f.keywords, 5);
  const genres = list(f.genres, 6);
  const about = [f.about, f.description, f.pitch].find((x): x is string => typeof x === 'string' && !!x.trim());
  return JSON.stringify({
    i,
    origin: c.store === 'epic' ? 'Epic store' : c.origin,
    title: c.title,
    ...(tags.length ? { tags } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(genres.length ? { genres } : {}),
    ...(about ? { about: trim(oneLine(about), JUDGE_ABOUT_CHARS) } : {}),
  });
}

/** A reply that is a bare JSON array of entries (parseJson reads objects only); null otherwise. */
function arrayReply(text: string): unknown[] | null {
  try {
    const v = JSON.parse(text.replace(/```(?:json)?/gi, '').trim());
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Verdicts by candidate index. The reply lists the candidates that fit; one it leaves out is "no" (a model that
 * still writes "no" entries is read the same way). A reply cut off at the token limit is not valid JSON: its
 * complete entries still count, whatever their key order, a candidate before the last of them that is not
 * listed is "no", and the ones after it stay unverified (missing). An unreadable reply gives no verdicts.
 */
function readVerdicts(text: string, n: number): Map<number, Verdict> {
  const out = new Map<number, Verdict>();
  const put = (r: any): void => {
    const idx = Number(r?.i);
    const f = typeof r?.fit === 'string' ? r.fit.trim().toLowerCase() : '';
    if (!Number.isInteger(idx) || idx < 0 || idx >= n || out.has(idx)) return;
    if (f !== 'yes' && f !== 'partly' && f !== 'no') return;
    out.set(idx, { fit: f, why: typeof r?.why === 'string' ? trim(oneLine(r.why), 80) : '' });
  };
  const parsed = parseJson(text);
  const list: unknown[] | null = Array.isArray(parsed?.fits) ? parsed.fits : arrayReply(text);
  if (list) {
    for (const r of list) put(r);
    // A list of something else ("fits": ["yes", …]) is unreadable, not "nothing fits".
    if (list.length && !out.size) return out;
  } else {
    for (const m of text.matchAll(/\{[^{}]*\}/g)) {
      try {
        put(JSON.parse(m[0]));
      } catch {
        /* an entry cut mid-way */
      }
    }
    if (!out.size) return out;
  }
  const covered = list ? n : Math.max(...out.keys()) + 1;
  for (let i = 0; i < covered; i++) if (!out.has(i)) out.set(i, { fit: 'no', why: '' });
  return out;
}

/**
 * The keep rule, in the original order: every "yes" and every unverified candidate; a "partly" one only
 * while fewer than `count` "yes" exist (the first count − yes of them). Shared by the fit check and by
 * pickCandidates, which re-applies it after adding the store fallback.
 */
function keepByFit(list: Candidate[], count: number): { kept: Candidate[]; dropped: Candidate[] } {
  let room = Math.max(0, count - list.filter((c) => c.fit === 'yes').length);
  const kept: Candidate[] = [];
  const dropped: Candidate[] = [];
  for (const c of list) {
    if (c.fit !== 'partly' || room-- > 0) kept.push(c);
    else dropped.push(c);
  }
  return { kept, dropped };
}

/** Asks the model which candidates genuinely match the request. Runs when the intent has a concept, a soft wish,
 *  references or soft tags (pure hard-constraint requests — "installed games I never played", "VR games" — skip it:
 *  the filters already guarantee fit; then ran=false and every candidate is kept with fit 'yes'). Non-streamed,
 *  JSON, ≤ 700 output tokens, 45 s timeout, the user's model; the reply lists only the candidates that fit, so it
 *  stays short however many there are. Keeps 'yes' (and 'partly' only while fewer than intent.count 'yes' exist,
 *  marked fit 'partly'), in the original order. A failed or unreadable reply keeps every candidate unjudged (fit
 *  undefined, verified false) and adds no error — the explanation is then told fit is unverified. */
export async function judgeCandidates(turns: ChatTurn[], intent: Intent, candidates: Candidate[], lang: string, opts: { signal?: AbortSignal } = {}): Promise<FitResult> {
  const none = { promptTokens: 0, completionTokens: 0, model: '' };
  if (!candidates.length || !needsFitCheck(intent)) {
    return { kept: candidates.map((c) => ({ ...c, fit: 'yes' as const })), dropped: [], ran: false, verified: false, ...none };
  }
  checkAbort(opts.signal);
  let li = turns.length - 1;
  while (li >= 0 && turns[li].role !== 'user') li--;
  const latest = li >= 0 ? String(turns[li].content ?? '').trim() : '';
  const earlier = li > 0 ? turns.slice(0, li).slice(-JUDGE_EARLIER_TURNS) : [];
  const user = [
    earlier.length ? `EARLIER TURNS (oldest first):\n${earlier.map((t) => turnLine(t, 200)).join('\n')}` : '',
    `LATEST USER MESSAGE:\n${trim(latest, 800)}`,
    intent.concept ? `CONCEPT (the defining kind asked for): ${intent.concept}` : '',
    intent.soft ? `WISH: ${intent.soft}` : '',
    intent.softTags.length ? `WISHED TAGS: ${intent.softTags.join(', ')}` : '',
    intent.references.length ? `REFERENCES ("games like these"): ${intent.references.join(', ')}` : '',
    // A follow-up's concept can come back generic ("open-world RPG" for "like Genshin Impact"); the examples
    // still say which kind is meant.
    intent.exemplars.length ? `EXAMPLES (well-known games of the asked kind): ${intent.exemplars.join(', ')}` : '',
    `HARD CONSTRAINTS (already checked): ${constraintSummary(intent)}`,
    // Pitches are written in the interface language.
    lang === 'ru' ? 'Some facts ("about") may be in Russian.' : '',
    `CANDIDATES (${candidates.length}, one JSON object per line):\n${candidates.map(judgeLine).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  // One deadline for the whole call: chatJson's own timeout is per model, and walking the model chain on a
  // busy day would hold the answer for minutes over an optional check.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), JUDGE_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
  let res: ChatResult;
  try {
    res = await chatJson(
      [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: user },
      ],
      JUDGE_MAX_TOKENS,
      { timeoutMs: JUDGE_TIMEOUT_MS, signal }
    );
  } catch (e) {
    if (opts.signal?.aborted) throw new Error('AI_CANCELLED');
    debug(`fit check failed: ${errText(e)}`);
    return { kept: candidates.map((c) => ({ ...c })), dropped: [], ran: true, verified: false, ...none };
  } finally {
    clearTimeout(timer);
  }
  debug(`${res.model} fit: ${res.text.replace(/\s+/g, ' ').slice(0, 400)}`);
  const verdicts = readVerdicts(res.text, candidates.length);
  const usage = { promptTokens: res.promptTokens, completionTokens: res.completionTokens, model: res.model };
  if (!verdicts.size) return { kept: candidates.map((c) => ({ ...c })), dropped: [], ran: true, verified: false, ...usage };

  const rejected: Candidate[] = [];
  const marked: Candidate[] = [];
  candidates.forEach((c, i) => {
    const v = verdicts.get(i);
    if (!v) marked.push({ ...c }); // not covered by the reply: unverified
    else if (v.fit === 'no') rejected.push(c);
    else marked.push({ ...c, fit: v.fit, facts: { ...c.facts, ...(v.why ? { fitWhy: v.why } : {}) } });
  });
  const { kept, dropped } = keepByFit(marked, intent.count);
  return { kept, dropped: [...rejected, ...dropped], ran: true, verified: true, ...usage };
}

// ---------- steps 2 + 3: what the explanation gets ----------

export interface PickResult {
  candidates: Candidate[];
  stages: string[];
  notes: string[];
  spend: { promptTokens: number; completionTokens: number; model: string }[];
  /** The fit check ran but gave no verdicts (an error, a timeout, an unreadable reply): nothing this turn is
   *  verified, and checking again would most likely fail the same way after the same wait. */
  fitFailed: boolean;
}

/** The notes that make the explanation say plainly that the library has no such game — or no other one, when
 *  owned games were left out on purpose (the references, earlier picks, attached games). */
const NO_LIBRARY_FIT = "none of the user's library games matches";
const NO_OTHER_LIBRARY_FIT = "none of the user's other library games (the reference games and those shown earlier are left out) matches";

/** Is this one of the "no library game matches" notes? (assistant.ts drops them when it offers shown library games again.) */
export const isNoLibraryFitNote = (note: string): boolean => note.startsWith(NO_LIBRARY_FIT) || note.startsWith(NO_OTHER_LIBRARY_FIT);

/** The candidates the fit check sees: the best of each origin within JUDGE_QUOTA, in the original order. */
function judgePool(list: Candidate[]): Candidate[] {
  const left = { ...JUDGE_QUOTA };
  return list.filter((c) => left[c.origin]-- > 0);
}

/** What a fit check let through before the keep rule: every "yes", "partly" and unverified candidate. */
const fitting = (fr: FitResult): Candidate[] => [...fr.kept, ...fr.dropped.filter((c) => c.fit === 'partly')];

const ORIGIN_ORDER: Record<Candidate['origin'], number> = { library: 0, wishlist: 1, store: 2 };

/** select → fit check → (scope mine: when fewer than 2 library candidates fit — the tool loop's source rule — and
 *  the sources allow it, select again with only wishlist+store and fit-check those) → candidates for explain,
 *  library first. scope any: one select over all sources, one fit check. Only "yes" counts as a library fit. When
 *  every library candidate was checked and none fits, the library's "partly" games are dropped and the note "none
 *  of the user's (other) library games matches <concept or request>" is added. A fit check that failed is not
 *  repeated: the fallback's store games stay unverified, and no such note is added. stages gain 'fit_check' when
 *  the judge ran; `spend` has one entry per billed fit-check call. */
export async function pickCandidates(
  turns: ChatTurn[],
  intent: Intent,
  lang: string,
  opts: { exclude: Set<string>; context: ContextGame[]; signal?: AbortSignal; onStage?: (tools: string[]) => void }
): Promise<PickResult> {
  const stages: string[] = [];
  const notes: string[] = [];
  const spend: PickResult['spend'] = [];
  const merge = (r: { stages: string[]; notes: string[] }): void => {
    for (const s of r.stages) if (!stages.includes(s)) stages.push(s);
    for (const n of r.notes) addNote(notes, n);
  };
  const judge = async (list: Candidate[]): Promise<FitResult> => {
    const wanted = needsFitCheck(intent) && list.length > 0;
    if (wanted) {
      checkAbort(opts.signal);
      if (!stages.includes('fit_check')) stages.push('fit_check');
      opts.onStage?.(['fit_check']);
    }
    const fr = await judgeCandidates(turns, intent, wanted ? judgePool(list) : list, lang, { signal: opts.signal });
    if (fr.promptTokens || fr.completionTokens) spend.push({ promptTokens: fr.promptTokens, completionTokens: fr.completionTokens, model: fr.model });
    return fr;
  };

  const sel = await selectCandidates(intent, lang, opts);
  merge(sel);
  const first = await judge(sel.candidates);
  const fitFailed = first.ran && !first.verified;
  if (!first.ran || !sel.stages.includes('library_semantic')) {
    return withExemplarNet(first.kept, { turns, intent, lang, opts, stages, notes, spend, fitFailed, merge, judge });
  }

  let fits = fitting(first);
  // A library game fits only when the check said yes: "partly" is only close, and an unverified one (the check
  // failed or did not reach it) may be merely word-related — counting it would keep a "mine" request away
  // from the store exactly when the check could not help.
  const libraryFits = fits.filter((c) => c.origin === 'library' && c.fit === 'yes').length;
  const libraryOnly = intent.hard.installed !== null || intent.hard.played !== null;
  const storeAllowed = !libraryOnly && (intent.sources.includes('wishlist') || intent.sources.includes('store'));
  const storeSearched = sel.stages.includes('wishlist') || sel.stages.includes('store_discover');
  // Enough library games were found, but (almost) none of them is what was asked: the store after all. The
  // tool loop's rule: the next source when the previous one yields fewer than 2 fitting games.
  if (intent.scope === 'mine' && storeAllowed && !storeSearched && libraryFits < Math.min(2, intent.count)) {
    try {
      const more = await selectCandidates(intent, lang, { ...opts, only: ['wishlist', 'store'] });
      merge(more);
      // After a failed check the store games go unverified (the explanation picks only those whose facts show
      // the asked kind) instead of waiting for a second check that would most likely fail too.
      fits = [...fits, ...(fitFailed ? judgePool(more.candidates) : fitting(await judge(more.candidates)))];
    } catch (e) {
      if (isCancel(e)) throw e;
      debug(`store fallback failed: ${errText(e)}`);
    }
  }
  // "No library game matches" holds only when every library candidate was checked and none said yes. Its "close"
  // games would contradict that sentence (and are the loosely related picks the check is there to stop).
  if (!libraryFits && !fits.some((c) => c.origin === 'library' && !c.fit)) {
    fits = fits.filter((c) => c.origin !== 'library');
    addNote(notes, `${sel.ownedSetAside ? NO_OTHER_LIBRARY_FIT : NO_LIBRARY_FIT} ${askedFor(turns, intent)}`);
  }
  // The keep rule once more over everything that fits: "partly" games only while too few say yes.
  const ordered = [...fits].sort((a, b) => ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin]);
  return withExemplarNet(keepByFit(ordered, intent.count).kept, { turns, intent, lang, opts, stages, notes, spend, fitFailed, merge, judge });
}

/** Exemplar safety net: how many titles one extra call may name, and its budget. */
const NET_MAX_TOKENS = 250;
const NET_TIMEOUT_MS = 30_000;
const EXEMPLAR_SYSTEM = `You name well-known, released PC games that match a game request. Exact store titles of games you are sure exist; never the reference games themselves; best match first. Output JSON only: {"exemplars":["…"]} with 3–8 titles.`;

/**
 * The store search needs anchors (reference or example games) or tags; a request described only in words —
 * "liminal space games like the Backrooms", where the Backrooms is a meme, not a game — can leave it with neither
 * when the intent named no examples and embeddings are down, and the answer becomes "no such games" although the
 * model knows several. When nothing was found, the request reached for the store and the intent gave no
 * exemplars, one small call asks for them and the search runs once more with them (library included: an example
 * may be owned). Its tokens are billed like a fit check.
 */
async function withExemplarNet(
  found: Candidate[],
  ctx: {
    turns: ChatTurn[];
    intent: Intent;
    lang: string;
    opts: { exclude: Set<string>; context: ContextGame[]; signal?: AbortSignal; onStage?: (tools: string[]) => void };
    stages: string[];
    notes: string[];
    spend: PickResult['spend'];
    fitFailed: boolean;
    merge: (r: { stages: string[]; notes: string[] }) => void;
    judge: (list: Candidate[]) => Promise<FitResult>;
  }
): Promise<PickResult> {
  const { turns, intent, lang, opts, stages, notes, spend, fitFailed } = ctx;
  const done = (candidates: Candidate[]): PickResult => ({ candidates, stages, notes, spend, fitFailed });
  const libraryOnly = intent.hard.installed !== null || intent.hard.played !== null;
  const storeAllowed = !libraryOnly && (intent.sources.includes('wishlist') || intent.sources.includes('store'));
  const described = !!(intent.soft || intent.concept || intent.references.length);
  if (found.length || !storeAllowed || intent.exemplars.length || !described) return done(found);
  let li = turns.length - 1;
  while (li >= 0 && turns[li].role !== 'user') li--;
  const latest = li >= 0 ? trim(oneLine(String(turns[li].content ?? '')), 600) : '';
  try {
    checkAbort(opts.signal);
    const res = await chatJson(
      [
        { role: 'system', content: EXEMPLAR_SYSTEM },
        {
          role: 'user',
          content: [
            `REQUEST: ${latest}`,
            intent.concept ? `KIND: ${intent.concept}` : '',
            intent.soft ? `WISH: ${intent.soft}` : '',
            intent.references.length ? `REFERENCES (not to be named): ${intent.references.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      NET_MAX_TOKENS,
      { timeoutMs: NET_TIMEOUT_MS, signal: opts.signal }
    );
    spend.push({ promptTokens: res.promptTokens, completionTokens: res.completionTokens, model: res.model });
    const refs = new Set(intent.references.map(normalizeTitle));
    const parsed = parseJson(res.text);
    const exemplars = cleanStrings(parsed?.exemplars, 8, 120).filter((t) => !refs.has(normalizeTitle(t)));
    debug(`${res.model} exemplar net: ${exemplars.join(', ') || 'none'}`);
    if (!exemplars.length) return done(found);
    intent.exemplars = exemplars;
    const again = await selectCandidates(intent, lang, opts);
    ctx.merge(again);
    const fr = await ctx.judge(again.candidates);
    const fits = fitting(fr).sort((a, b) => ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin]);
    // An owned example that fits contradicts an earlier "no library game matches" note.
    if (fits.some((c) => c.origin === 'library' && c.fit === 'yes')) {
      for (let i = notes.length - 1; i >= 0; i--) if (isNoLibraryFitNote(notes[i])) notes.splice(i, 1);
    }
    return done(keepByFit(fits, intent.count).kept);
  } catch (e) {
    if (isCancel(e)) throw e;
    debug(`exemplar net failed: ${errText(e)}`);
    return done(found);
  }
}

/** What the user asked for, in a few words, for the "no library game matches" note. */
function askedFor(turns: ChatTurn[], intent: Intent): string {
  if (intent.concept) return `the asked kind (${intent.concept})`;
  if (intent.references.length) return `games like ${intent.references.join(', ')}`;
  if (intent.soft) return `the wish (${intent.soft})`;
  const last = [...turns].reverse().find((t) => t.role === 'user');
  return `the request ("${trim(oneLine(String(last?.content ?? '')), 120)}")`;
}

// ---------- step 4: explanation ----------

const EXPLAIN_SYSTEM = `You write the reply of the assistant inside a desktop game-library manager (Steam + Epic Games Store). The app has already searched the user's library, Steam wishlist and the stores, and gives you CANDIDATES that pass every hard constraint it could check, best match first, each marked with how well it matches the request ("fit"). Pick from them and explain briefly.

# Rules, in priority order
1. Answer in the ANSWER LANGUAGE (the language of the user's LATEST message), whatever the interface language.
2. Recommend ONLY games from CANDIDATES, titles copied exactly. Never invent games, numbers, prices or facts: every number comes from a candidate's facts. Every game you list in the answer is also in "games".
3. Fit: "fit":"yes" games clearly match the request — recommend them first ("fitWhy" says why). A "fit":"partly" game only when too few "yes" games remain, introduced as close but not quite, in one clause. A candidate without "fit" was not verified: pick it only when its facts clearly show what was asked (the CONCEPT, the wished genre or mechanic). Fewer games beat loosely related ones: when no candidate is "yes" and none of the others is close enough, answer as in rule 10.
4. Pick the requested number of games (PICK; fewer when fewer fit), best fit for the latest message first. Hard constraints already hold (except a length marked "not checked"). Never repeat a game recommended earlier in the conversation.
5. Sources: library games first. SCOPE "mine": wishlist and store games only when too few library games fit; "any": the fitting library games, then store games; "buy": wishlist and store games. When the list mixes origins, say where each non-library game is from: the wishlist, the Steam store or the Epic Games Store (facts "store": "Epic Games Store"; other store candidates are from the Steam store). "exemplar": true or "why": "well-known example" marks a well-known game of the asked kind.
6. When NOTES say that ${NO_LIBRARY_FIT} …, say so plainly in one short clause first ("Your library has no such games", in the answer language); when they say that none of the user's OTHER library games matches, say "Your library has no other such games" instead. Then present the other games, and list no library game.
7. Wishlist and store games: put the price and the review % in the note when the facts have them.
8. Length: call a game short or long only when its facts give a length. For a candidate whose length is "not checked", say in one clause that its length is unknown.
9. When ASSUMPTION is given, state it in one short clause.
10. No candidates: say in plain words that you found no such games, without technical detail, and offer 2–3 concrete next requests in "suggestions" (look up a well-known game of that kind from EXAMPLES, look in the store, drop one of the CONSTRAINTS).
11. NOTES describe the search (games without AI profiles that could not be checked, a wishlist that was unavailable, …): mention one only when it changes what the user should know, in plain words.
12. Never describe how the app searched: no words about tag lookups, filters, literal matching, indexes, tools, candidates, checks or constraints that "do not exist" — talk about games only (a game's store tag named as a fact about it is fine).

# Style
- Concise: at most two short sentences before the list, then the list. No greetings, apologies, restating the question, praise or closing offers.
- Markdown: **bold titles**, one bullet per game ("- **Title** — why it fits"); no headers, no tables.
- Each note ≤ 10 words and built on a fact (hours, genre, length, price, review %).
- Notes and suggestions are in the ANSWER LANGUAGE too: "fitWhy" and "why" are English hints — translate what they say, never copy them.

# Output — JSON only, nothing outside it
{"answer":"…","games":[{"title":"exact title from CANDIDATES","note":"≤ 10 words, fact-based, in the answer language"}],"suggestions":["follow-up the user might send next, in the answer language", …]}
"games": the games you recommend, in the order of the answer (0–8); "suggestions": 0–3.`;

/** The hard constraints that were applied, in plain words, so a "nothing matched" answer can name them. A price
 *  cap that could not be converted is not one of them (a note says so). */
function constraintSummary(i: Intent): string {
  const h = i.hard;
  const parts: string[] = [];
  if (h.steamTags.length) parts.push(`kind: ${h.steamTags.join(' and ')}`);
  if (h.modes.length) parts.push(`play modes: ${h.modes.join(' or ')}`);
  if (h.maxLengthHours !== null) parts.push(`at most ${h.maxLengthHours} h to finish`);
  if (h.minLengthHours !== null) parts.push(`at least ${h.minLengthHours} h to finish`);
  if (h.installed !== null) parts.push(h.installed ? 'installed' : 'not installed');
  if (h.played === 'never') parts.push('never played');
  else if (h.played === 'any_played') parts.push('played before');
  if (h.onSaleOnly) parts.push('on sale');
  const asked = i.priceAsked ? ` (${i.priceAsked.amount} ${i.priceAsked.currency} at the daily rate)` : '';
  if (h.maxPrice !== null) parts.push(h.maxPrice === 0 ? 'free' : `price at most ${h.maxPrice} ${storeCurrency()}${asked}`);
  if (i.exclude.titles.length) parts.push(`not: ${i.exclude.titles.join(', ')}`);
  if (i.exclude.tags.length) parts.push(`without: ${i.exclude.tags.join(', ')}`);
  return parts.length ? parts.join('; ') : 'none';
}

const SCOPE_LINE: Record<Intent['scope'], string> = {
  mine: 'mine — something the user owns',
  any: 'any — a general question about a kind of game: the fitting library games and store games',
  buy: 'buy — games to buy (wishlist and store)',
};
const SOURCE_NAME: Record<Intent['sources'][number], string> = { library: 'library', wishlist: 'Steam wishlist', store: 'stores' };

/** Bold titles the answer lists as bullets ("- **Title** — why", "1. **Title**"): its recommendations.
 *  A bold label such as "**From the store:**" is not a title. */
export function bulletTitles(answer: string): string[] {
  return [...answer.matchAll(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+\*\*([^*\n]{2,120})\*\*/gm)].map((m) => m[1].trim()).filter((t) => t && !t.endsWith(':'));
}

/** Step 4: one streamed explanation call. Returns the same final shape the tool loop produces. Candidates carry
 *  their fit ('yes' | 'partly'; absent = unverified). Throws AI_BAD_ANSWER (carrying the call's tokens) when the
 *  reply has no answer, picks none of the candidates although one fits "yes", or lists a game that is not one of
 *  them. */
export async function explain(
  turns: ChatTurn[],
  intent: Intent,
  candidates: Candidate[],
  lang: string,
  opts: { model?: string; onDelta?: (soFar: string) => void; onAttempt?: (m: string, a: number) => void; notes: string[] }
): Promise<{ final: any; promptTokens: number; completionTokens: number; model: string }> {
  let li = turns.length - 1;
  while (li >= 0 && turns[li].role !== 'user') li--;
  if (li < 0) throw new Error('AI_EMPTY');
  const latest = String(turns[li].content ?? '').trim();
  const earlier = turns.slice(0, li).slice(-EXPLAIN_EARLIER_TURNS);
  // A checked game's fitWhy says what its store description would; only an unverified one keeps the description
  // (the model has to judge it from its facts).
  const lines = candidates.map((c) => {
    const { about, description, ...rest } = c.facts;
    return JSON.stringify({ origin: c.origin, ...(c.fit ? { fit: c.fit, ...rest } : { ...rest, about, description }) });
  });
  const unverified = candidates.some((c) => !c.fit);
  // The index note is a diagnostic: the answer has nothing to say about it.
  const notes = opts.notes.filter((n) => n !== SEMANTIC_NOTE);
  const user = [
    `ANSWER LANGUAGE: ${answerLanguage(latest, lang)}`,
    earlier.length ? `EARLIER TURNS (oldest first):\n${earlier.map((t) => turnLine(t, EXPLAIN_TURN_CHARS)).join('\n')}` : '',
    `LATEST USER MESSAGE:\n${trim(latest, 1500)}`,
    `PICK: ${intent.count}`,
    `SCOPE: ${SCOPE_LINE[intent.scope]}; looked in: ${intent.sources.map((s) => SOURCE_NAME[s]).join(', ')}`,
    intent.concept ? `CONCEPT (what the user asked for): ${intent.concept}` : '',
    `CONSTRAINTS: ${constraintSummary(intent)}`,
    intent.assumption ? `ASSUMPTION: ${intent.assumption}` : '',
    notes.length ? `NOTES:\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
    lines.length && unverified ? 'FIT: candidates without "fit" were not verified — pick only those whose facts clearly show what was asked.' : '',
    lines.length
      ? `CANDIDATES (one JSON object per line, best match first):\n${lines.join('\n')}`
      : `CANDIDATES: none — no game was found that fits.${
          intent.exemplars.length ? `\nEXAMPLES (well-known games of the kind, not checked — for "suggestions" only, never list them as recommendations): ${intent.exemplars.join(', ')}` : ''
        }`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const ask = (extra: string): Promise<ChatResult> =>
    chatJson(
      [
        { role: 'system', content: EXPLAIN_SYSTEM },
        { role: 'user', content: user + extra },
      ],
      EXPLAIN_MAX_TOKENS,
      { model: opts.model, onDelta: opts.onDelta, onAttempt: opts.onAttempt }
    );
  let res = await ask('');
  // A looping reply ("title":"D","note":"","title":"Dungeons 3",…) still parses, with most games lost; seen
  // live on DeepSeek-V4-Flash. One more try, billed together with the first.
  const defect = jsonDefect(res.text);
  if (defect) {
    debug(`${res.model} explain degenerated (${defect}), asking once more`);
    const first = res;
    res = await ask(MALFORMED_HINT);
    res = { ...res, promptTokens: res.promptTokens + first.promptTokens, completionTokens: res.completionTokens + first.completionTokens };
  }
  debug(`${res.model} explain: ${res.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  const parsed = parseJson(res.text);
  const answer = typeof parsed?.answer === 'string' ? parsed.answer.trim() : '';
  // A reply without an answer breaks the contract; failing lets the caller fall back to the tool loop
  // (the error carries the tokens it cost, so the turn's usage still counts them).
  if (!answer) throw billedError('AI_BAD_ANSWER', res);

  // Only candidates become games: an invented or misspelled title is mapped to the candidate it means
  // or dropped, so every card is a game the selection actually checked.
  const byKey = new Map(candidates.map((c) => [normalizeTitle(c.title), c]));
  const candidateFor = (title: string): Candidate | undefined => {
    const k = normalizeTitle(title);
    if (!k) return undefined;
    return (
      byKey.get(k) ??
      candidates.find((x) => {
        const ck = normalizeTitle(x.title);
        return ck.length >= 4 && k.length >= 4 && (ck.includes(k) || k.includes(ck));
      })
    );
  };
  const games: { title: string; note: string | null }[] = [];
  const used = new Set<string>();
  const addGame = (title: string, note: unknown): void => {
    const c = candidateFor(title);
    if (!c || used.has(c.title) || games.length >= 8) return;
    used.add(c.title);
    games.push({ title: c.title, note: typeof note === 'string' ? trim(note.trim(), 120) : null });
  };
  for (const g of Array.isArray(parsed.games) ? parsed.games.slice(0, 8) : []) {
    if (typeof g?.title === 'string') addGame(g.title.trim(), g?.note);
  }
  if (candidates.length) {
    // The text is what the user reads, and dropping a card does not change it: a listed game the
    // selection never checked (an invented title, an unowned game shown as the user's own) fails the
    // turn, so the tool loop answers instead.
    const listed = bulletTitles(answer);
    if (listed.some((t) => !candidateFor(t))) throw billedError('AI_BAD_ANSWER', res);
    // A model that listed candidates in the text but left "games" empty still gets their cards.
    if (!games.length) for (const t of listed) addGame(t, null);
    // A "yes" candidate passes the hard constraints and fits the request, so an answer that picks none of them
    // ignored them. "Partly" ones are only close and unverified ones may all be loosely related: when nothing
    // said yes, "no such games" is a fair answer (rule 3: fewer games beat loosely related ones).
    if (!games.length && candidates.some((c) => c.fit === 'yes')) throw billedError('AI_BAD_ANSWER', res);
  }
  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions
        .filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
        .slice(0, 3)
        .map((s: string) => trim(s.trim(), 100))
    : [];
  return { final: { answer, games, suggestions }, promptTokens: res.promptTokens, completionTokens: res.completionTokens, model: res.model };
}
