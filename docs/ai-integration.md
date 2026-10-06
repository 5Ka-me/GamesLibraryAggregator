# AI in GL Aggregator: chat assistant, game profiles, semantic search, prompts, practices

Everything AI-related in the launcher runs on [chutes.ai](https://chutes.ai) under the user's own key:
chat models through the OpenAI-compatible endpoint (`https://llm.chutes.ai/v1/chat/completions`) and,
for meaning-based search, an embedding model on a public chute (see [Semantic index](#semantic-index)).
The parts:

- **The "AI" page** — one multi-turn chat: library search, advice on what to play / finish /
  drop, "is it worth buying", questions about the library. Recommendation requests go through a
  [two-step pipeline](#two-step-pipeline-for-recommendations) (parse the request → deterministic
  selection → a fit check → one streamed explanation); everything else, and any pipeline failure, goes through the
  [tool loop](#the-tool-loop-the-model-calls-tools-the-launcher-executes).
  Code: `steam-egs-launcher/src/main/services/assistant.ts` (tools, tool loop, entry point),
  `services/aiPipeline.ts` (the pipeline), page `src/renderer/src/pages/AiPage.tsx`.
- **The "Worth buying?" block** on the game page — the same analysis on demand, with facts
  shown separately from the opinion (`gameVerdict` in `assistant.ts`, `VerdictBlock` in
  `GameDetailsPage.tsx`).
- **Game profiles** ("backlog enrichment") — a one-off pass over the whole library, started
  from Settings → "AI" → "Game profiles": [fact cards](#fact-cards) from public store data
  (`services/gameFacts.ts`), [profiles](#game-profiles-library-enrichment) grounded in them
  (`services/enrichment.ts`), then the [semantic index](#semantic-index) (`services/embeddings.ts`).
- **Store discovery** — "games like X" and "games of this kind" in the Steam store, built on Steam's
  own "More like this" lists and tags (`services/similar.ts`), see [Store discovery](#store-discovery).
- **The eval harness** — real phrases with property-based expectations, re-run whenever a model, a
  prompt or a weight changes (`services/aiEval.ts`, `eval/ai-cases.json`), see [Eval harness](#eval-harness).

The shared HTTP client (model list, JSON mode, retries and fallback models, timeouts, token
accounting, the auth header helper `chutesHeaders`) is `services/aiClient.ts`. Settings live in the
"AI" panel of `SettingsPage.tsx`.

## Key and model

- **Where the key goes:** Settings → "AI" → "chutes.ai API key" → "Save key". The key is
  stored encrypted in the OS keystore (`secrets.bin`, DPAPI via `safeStorage`) next to the
  Steam key; it never reaches the renderer. The embedding calls use the same key through the
  same helper (`chutesHeaders` in `aiClient.ts`); no other module reads it.
- **Models.** Four tested ones, all with `json_mode` (`CURATED_MODELS` in `aiClient.ts`,
  prices come from `/v1/models`): `google/gemma-4-31B-turbo-TEE` — default, cheap and fast
  (~$0.12/$0.37 per 1M); `Qwen/Qwen3-32B-TEE` — an alternative at the same price;
  `deepseek-ai/DeepSeek-V4-Flash-0731-TEE` — smarter (~$0.44/$1.32); `zai-org/GLM-5.1-TEE` —
  best quality (~$0.98/$3.08). On a 429 "at maximum capacity" the client retries, then
  switches to the next model on the list; the answer footer shows which model replied. Thinking
  models get `chat_template_kwargs.enable_thinking = false` (Qwen3 otherwise returns an empty
  content field), and an empty reply counts as a busy model, so the next one is tried.
- **Embedding model.** `Qwen/Qwen3-Embedding-8B` (fixed, not user-selectable). Its token usage is
  added to the same usage counter in Settings.
- **Cost.** A chat turn is 3–9k tokens on the tool loop (one or two tool rounds), i.e. a fraction of
  a cent on the default model; a recommendation through the pipeline is one small intent call, usually
  one [fit-check](#two-step-pipeline-for-recommendations) call (accepted by the user: about +2–4 s and
  +20 % tokens per turn; two when the library has nothing that fits and the store is checked too) and
  one explanation call. A game verdict is ~1.5–3k. The first profile version (titles only) measured
  ~150k tokens, about $0.06, for a ~700-game library; grounded profiles send a fact card per title,
  and the estimate constants were raised accordingly (320 tokens in and 300 out per title, 900 per
  batch), which puts a ~700-game library at roughly half a million tokens. The warning before a run
  shows the live estimate. Embedding the library costs a fraction of a cent. The usage counter is
  visible in Settings.

## The assistant

`assistantChat(history, lang, context)` in `assistant.ts` is the single entry point. A cheap regex
check (`looksLikeRecommendation`) decides whether the turn looks like a recommendation request; if
so, the two-step pipeline runs, otherwise the tool loop. Both paths end in the same reply shape and
the same title resolution (one shared helper), so the page cannot tell them apart except by the
"used: …" footer.

```json
{ "answer": "markdown in the user's language",
  "games": [{ "title": "exact title from tool results", "note": "why" }],
  "suggestions": ["a natural follow-up question", "..."] }
```

At the end of a turn the launcher **resolves every named title** against the real library (a card
with Play / Open / Skip-in-reel actions) or the store: a Steam store card, or — for a game that is not
sold on Steam — an **Epic Games Store card** (cover, note, price and an "Epic Store" button that opens
the product page in the Epic Games Launcher when it is installed, otherwise in the browser; it never
leads to a library page). Candidates the pipeline passed resolve first (library → owned card, Steam →
appid card, Epic → the offer the selection already found); on the tool loop a not-owned title Steam
does not know is looked up on EGS (`epicStoreDetails`, 5 s cap) and becomes an Epic card when the
normalized titles match. A title found nowhere stays plain text. `AssistantGame` carries
`store` (`steam` / `epic` / null for owned games), `epicUrl`, `image` and `price` (formatted, Epic
cards only — Steam cards read live store metadata). Everything the tools (or the pipeline's candidate selection) found during the turn is
available under "All results", so a search-like question still shows the full list rather than only
what the model chose to mention.

**Streaming.** The final call is requested with `stream: true` (SSE). When the final JSON starts
with `"answer": "…"`, the launcher decodes the string value as it arrives (`partialAnswer` in
`assistant.ts`) and pushes it to the page as `ai:progress` events (throttled to ~12/s), so the text
paints while the model writes and the cards appear once the JSON closes. Usage comes from the last
chunk (`stream_options.include_usage`). Tool rounds produce nothing visible except the "Checking: …"
line that names the running tools.

**Earlier cards travel with the history.** Every assistant turn the renderer sends back carries
`games` — the titles it showed as cards (`ChatTurn.games`; IPC accepts at most 8 strings of at most
200 characters each). The pipeline uses them to avoid recommending the same games again on "more".

### Two-step pipeline for recommendations

Small models are unreliable at choosing tools and filters in one go: a request like "a short co-op
game for tonight, not horror" used to produce a broad tool call, an ignored constraint and a
confident answer. The pipeline splits the work so the model only does what models are good at —
reading a request and writing the explanation — and the app does the selection deterministically.
Code: `aiPipeline.ts`.

1. **Pre-check** — `looksLikeRecommendation(lastUser, history, context)`: a regex over English and
   Russian words, attached games plus "like these", and follow-ups ("more") after a recommendation.
   General questions about a kind of game count as recommendation turns too: "what games are there",
   "which games exist", "games in the … genre", a kind named without the word for games ("what
   extraction shooters are there") and their Russian equivalents ("genre" alone only next to a game
   noun). Seen live: "what extraction shooters are there" without this went to the tool loop, which
   checked only famous titles and wrongly said the library had none. Listing questions about the user's own games ("my", "do I have" and the Russian
   "I have") still go to the tool loop. No model call.
2. **Parse the intent** — `parseIntent`: one small JSON call on the user's model (not streamed,
   800 max tokens, 45 s timeout). It sees the last 6 turns, the attached games and today's date;
   follow-ups merge with the earlier request's constraints. The result:

   | Field | Meaning |
   |---|---|
   | `kind` | `recommend` or `other` (`other` → tool loop) |
   | `scope` | `mine` — something the user owns ("what to play tonight", "from my library", installed games; a what-to-play message stays `mine` even when it says "like X"); `any` — a general question about a kind of game ("what games are there in genre X", "games like X"): library fits **and** the store; `buy` — buying, new, not owned, "in the store", "from my wishlist". Default when the model gives none: derived from `sources` |
   | `sources` | kept for compatibility, derived from `scope`: `mine` → library → wishlist → store as a fallback order, `any` → the same three gathered together, `buy` → wishlist → store. A list the model narrowed wins over a `mine` / `any` scope it contradicts ("find something like Hades in the store" with `any` + `["store"]` → `buy`; `any` + `["library"]` → `mine`), since the scope rules overlap and the template defaults to all three sources. Installed / played force the library and `mine`; a price cap or "on sale" drops the library (`buy`) |
   | `concept` | the defining genre, mechanic or feel when it is **not** simply a Steam tag, one English line of at most 200 characters ("anomaly hunting: spot what changed in a looping place and turn back", "gacha: character collecting with randomized summons, live-service, anime style"); for "like X", what sets X apart from its broad genre (Genshin Impact → gacha, not "open-world RPG"), and a follow-up "like Genshin Impact" after a gacha question keeps the gacha concept; null when tags and modes already say it |
   | `exemplars` | 0–8 well-known released games that clearly belong to the concept or are closest to the references, from the model's knowledge, exact store titles, never the references themselves (anomaly hunting → The Exit 8, Platform 8, I'm on Observation Duty; gacha or "like Genshin Impact" → Wuthering Waves, Honkai: Star Rail, Zenless Zone Zero; "like Hades" → Dead Cells, Hades II). Deduped, at most 120 characters each |
   | `hard` | constraints every result must meet: `steamTags` (**real Steam tags only** — VR, Anime, Roguelike, Pixel Graphics, Hidden Object, Detective…; a genre or mechanic Steam has no tag for goes to `concept`; play modes go to `modes`, and a mode written as a tag anyway — "Co-op", "PvP", "Singleplayer", "Split Screen" — is moved there by `sanitizeIntent`, so it never becomes a tag group that would also shut out every Epic game; phrases, resolved by the app), `modes`, `minLengthHours` / `maxLengthHours`, `installed`, `played` (never / any_played), `onSaleOnly`, `maxPrice` (major units of the Steam store currency: the model copies the number as said plus `maxPriceCurrency`, and the app converts a cap named in another currency at the daily rate; only the store's ISO currency code is sent, never the country) |
   | `soft` | the wished feel or content, one or two English sentences — used for semantic ranking |
   | `softTags` | tag-like words for the store side ("roguelike", "cozy") |
   | `sessionMinutes` | a wished session length |
   | `references` | games the user named ("like Hades") |
   | `exclude` | titles and kinds to keep out ("Dark Souls", "horror") |
   | `count` | how many games (default 5, 1–8) |
   | `confidence`, `question`, `readings`, `assumption` | how sure the reading is (0–1), one clarifying question, 2–3 concrete readings to offer under it (only below the clarify threshold), the reading acted on |

3. **Clarify only when really unsure.** When `confidence < CLARIFY_BELOW` (0.4) and the model gave a
   question, the reply is that question with the intent's `readings` as suggestions (concrete requests
   to click; none when the model gave none), no games, footer `parse_intent`. A short reply to that
   question goes back into the pipeline, not to the tool loop. Above the threshold the app acts on the likely reading and the answer
   states the `assumption` in one clause — the "assume, then ask" rule of the tool loop, made explicit.
4. **Select candidates** — `selectCandidates`, no model calls except embeddings:
   - Exclusions (normalized titles): attached games, games already recommended in the conversation
     (earlier turns' `games` plus `**bold**` titles in their text), `exclude.titles`, hidden games.
   - Hard and excluded tags go through the [tag resolver](#tag-resolver) to exact Steam tag names.
     **Only resolved tags filter.** A hard phrase that resolves to no tag is moved into the `concept`
     (appended, or the concept is created from it) and its group is dropped — "Gacha" is not a Steam
     tag, and as a literal filter it used to let nothing through.
   - **Library** (when in `sources`): the library view minus exclusions → `applyFind` with the hard
     filters (each resolved Steam tag must hold — one `applyFind` per tag, intersected; modes,
     length, installed, played) → games carrying an excluded tag, or whose profile genres / themes /
     keywords contain an excluded word, are dropped → ranked by `semanticSearch` over `soft` plus the
     `concept` (plus "Session: about N minutes." when a session length was given, owned reference
     games blended in). Without an index, or on an embedding error, a lexical score (overlap of
     `soft` / `softTags` / `concept` words with keywords, themes, genres, moods and store tags) stands
     in (a diagnostic note records it; the explanation never sees it). Candidates within
     0.25 of the best score are kept, at most 12.
   - **Exemplars in the library:** every exemplar the user owns (exact normalized title or an edition
     pair) and has not excluded becomes a library candidate even when filters and ranking would not
     surface it — unless one of the hard constraints fails for it. It scores just above the best ranked
     library game, in exemplar order, and its facts carry `exemplar: true`.
   - **Scope** decides which sources are gathered. `mine`: library first; the **wishlist** and then the
     **store** only when the library yields fewer than `max(2, count)` candidates *before* the fit
     check (the [fallback after the check](#fit-check-and-store-fallback) covers a library whose
     candidates all fail it). `any`: library, wishlist and store together, however many library
     candidates there are. `buy`: wishlist and store. The wishlist (Steam signed in) is filtered the
     same way on store tags plus sale / price and ranked with `scoreTexts`; the store goes through
     [`storeDiscover`](#store-discovery) with the references and exemplars as `similarTo` (references
     first), soft tags, hard tags, excluded tags, the soft text, sale / price limits and every
     exclusion. `opts.only` restricts one call to some of the sources (the fallback uses it).
   - **Exemplars on Steam:** each exemplar that is neither owned nor excluded is looked up on Steam
     (`findSteamAppId`, else the first store-search game hit whose normalized title equals it or is an
     edition pair) and becomes a store candidate when it passes the same store filters, with the reason
     "well-known example", scored above the "More like this" results (`storeDiscover` leaves its
     anchors out of its own results, so exemplars are added here directly).
   - **Exemplars on the Epic Games Store:** an exemplar that is neither owned nor on Steam is looked up
     on EGS (`epicStoreDetails`, at most 3 lookups in parallel with a 10 s cap for all of them; failures
     are skipped). An offer whose normalized title matches (or is an edition pair) becomes an Epic store
     candidate (`store: 'epic'`, no appid, the offer's URL, cover, price, discount and namespace) with
     the facts title, `store: "Epic Games Store"`, price, discount, up to 8 genres / features, a
     description of at most 200 characters and "well-known example". Epic has no Steam tags, so an Epic
     candidate is dropped when the request has hard tags, when a required play mode does not show in
     its features (co-op, PvP / competitive / multiplayer, MMO / massively, single), when the request
     wants a sale and it has no discount, and when a price cap is set and its price — converted from
     Epic's region currency to the store currency at the daily rate — exceeds it (free passes; no rate,
     no pass). EGS prices come in the currency's minor units: hundredths, or whole units for the ISO
     zero-decimal currencies such as JPY and KRW. This is how Honkai: Star Rail (Epic only) reaches a gacha answer.
   - Facts per candidate: library games get the same facts the tool loop's `describe()` returns plus
     the profile pitch (or the summary's first sentence), up to 8 keywords and, when there is no pitch,
     the fact card's short description as `about` (at most 200 characters); store and wishlist games
     get title, appid, price, discount, review share and count, up to 8 tags, the "why" and `about` —
     the Steam short description (at most 200 characters) from `storeAbouts` (`steamStore.ts`: GetItems
     with the basic info only, cached per game for 7 days, so a follow-up such as "more" fetches only
     new games; at most 24 ids, an 8 s cap, failures ignored), so the fit check judges what the game
     is, not only its tags. Tags are listed platform flags first, then the tags the hard filter asked for, so the
     explanation sees what matched.
   - Ownership (wishlist and store): a game is owned when its appid is a library Steam copy or the
     Steam twin of an Epic-only game (from its fact card), or when its normalized name matches a library
     title with or without an edition suffix. A price cap accepts only games with a known price within
     it (a cap of 0 only free ones), the same rule as store discovery.
   - The stage names (`library_semantic`, `wishlist`, `store_discover`) are reported as they run, so
     the page shows "Checking: …" like it does for tools.
5. **Check fit** — `judgeCandidates`: a separate model call that asks which candidates genuinely match
   the request (see [below](#fit-check-and-store-fallback)). Stage `fit_check` ("fit check" on the page).
6. **Fall back to the store** when the library has nothing that fits — `pickCandidates`, which
   `assistant.ts` calls instead of `selectCandidates`, wraps steps 4 and 5 and adds this fallback (see
   [below](#fit-check-and-store-fallback)).
7. **Explain** — `explain`: one streamed call, on the smart model whenever the user's own model ranks
   below it. Unlike the tool loop, no wording test decides this: every turn the pipeline answers is
   advice, a genre question or a bare "more" included. The prompt (English, compact): pick `count`
   games **only** from CANDIDATES (exact titles), fit "yes" first, best fit first; a fit "partly"
   candidate only when too few fit "yes", and then described as close but not quite in one clause;
   when the fit is unverified (the check failed), only games whose facts clearly show the asked
   concept; when nothing is "yes" and nothing else is close enough, "no such games" is a valid answer
   (only a reply that ignores "yes" candidates is rejected); when the NOTES say no library game
   matches, say so plainly in one short clause first ("Your library has no such games", or "no other
   such games" when owned references or earlier picks were left out, in the answer language), then
   present the store games and no library game; with mixed origins, label each as library / wishlist /
   Steam store / Epic Games Store. Each note at most 10 words built on a fact (hours, tag, price,
   review share), in the answer language (`fitWhy` and `why` are English hints to translate, not copy);
   the answer is at most two short sentences plus the list in markdown, in the language of the latest
   message; state the assumption when given; with no candidates, say that no such games were found —
   without technical detail — and offer 2–3 concrete next requests as suggestions (name a well-known
   example, look in the store, relax a constraint); 0–3 follow-up suggestions; never invent games or
   numbers. **No internals:** the answer never says how the app searched — no tags, filters, "literal"
   matching, indexes, tools, candidates or constraints that "do not exist"; it talks about games only.
   `constraintSummary` lists only constraints that were applied. Candidates carry `fit` ("yes",
   "partly", or absent = unverified) and `fitWhy`; Epic candidates carry `store: "Epic Games Store"`
   and map back to cards by title like every other candidate. The output is the usual
   `{"answer","games","suggestions"}`.

Library candidates become the turn's "All results" library list, wishlist and Steam store candidates
its store list; the footer reads `parse_intent` plus the stages that ran (`fit_check` when the judge
ran). **Fallback:** any error in parsing, selection or the explanation other than `AI_NO_KEY` /
`AI_AUTH` / `AI_BALANCE` / `AI_CANCELLED` falls back to the tool loop for the same turn (logged only
with `LAUNCHER_AI_DEBUG`), so a pipeline bug costs a few tokens, never an answer. A failed fit check is
not an error: the candidates are kept unjudged. Two exceptions end the turn instead, because the tool
loop would walk the same model chain for minutes and fail the same way: `AI_TIMEOUT` (no model
answered), and `AI_RATE` / `AI_HTTP_5xx` after more than 60 s in one call. Tokens of a billed but
unusable reply (`AI_BAD_INTENT`, `AI_BAD_ANSWER`) still count in the turn's usage, as do the fit-check
calls; the usage also reports the split per model (`usage.byModel`).

#### Fit check and store fallback

Three live misses (DeepSeek-V4-Flash, embeddings unavailable) shaped this part. "What games are there
in the anomaly-hunting genre?" was not seen as a request by the pre-check, and the tool loop listed
five unrelated detective games from the library as "the closest" — the library has no anomaly game,
and word overlap even surfaces S.T.A.L.K.E.R. for its "anomalies".
"Gacha games?" became a literal tag filter that let nothing through, and the answer explained the miss
in terms of Steam tags. "Something like Genshin Impact" found five open-world RPGs in the library by
word overlap, five was "enough", and the store was never asked. The causes: routing that missed general
genre questions, no notion of a genre that is not a Steam tag, the number of candidates taken for
fit, "enough" decided before anyone checked fit, and no Epic store. The wider pre-check, the intent's
`scope`, `concept` and `exemplars`, the Steam and Epic exemplars above, and the two steps below are
the fix.

**`judgeCandidates(turns, intent, candidates, lang)`** asks the model which candidates match.

- **When it runs:** the intent has a concept, a soft wish, references or soft tags. Pure
  hard-constraint requests ("installed games I never played", "VR games") skip it — the filters already
  guarantee fit; every candidate is then kept with fit "yes" and `ran` is false.
- **The call:** non-streamed JSON on the user's model (not the smart one), at most 700 output tokens,
  45 s timeout. The reply lists only the candidates that fit, so it stays short however many were
  checked; the input is about 100–190 tokens per candidate. Its usage is returned and billed into the
  turn.
- **The prompt** (English, compact): the latest user message plus up to 3 earlier turns, one line each;
  CONCEPT, SOFT, REFERENCES, EXAMPLES (the intent's exemplars, so a follow-up whose concept came back
  generic — "open-world RPG" for "like Genshin Impact" — still says which kind is meant) and a summary
  of the hard constraints; the candidates as one line each, `{"i":n, origin, title, tags ≤ 6,
  keywords ≤ 5, genres ≤ 6, about / pitch ≤ 160 chars}`. Fit "yes" = clearly has the defining genre,
  mechanic or feel; "partly" = HAS the defining element, but only as a secondary part or in a weaker
  form; "no" = the defining element is missing, even when the genre, setting or mood is similar (a
  detective game is "no" for anomaly hunting, not "partly"). Judge from the facts and from knowledge of
  the game; the facts win when they disagree. Strict about specific mechanics: the same broad genre
  ("open-world RPG") is "no" for a specific mechanic ("gacha", "anomaly hunting"); a reference's own
  sequel or series counts as "yes" for "like X". Output, on one line, only the candidates that fit:
  `{"fits":[{"i":0,"fit":"yes","why":"≤ 6 English words"}]}`; a candidate left out is "no".
- **Input cap:** the check sees at most 22 candidates — the best 8 library, 4 wishlist and 10 store
  games, in their order (exemplars rank first); the rest are dropped.
- **Reading the reply:** a parsed list means every candidate it leaves out is "no" (`{"fits":[]}` =
  none fits). A reply cut off mid-JSON still counts entry by entry, whatever the key order inside an
  entry: candidates before its last complete entry that it does not list are "no", the ones after it
  stay unverified. A list of something other than entries counts as unreadable.
- **Result:** the "yes" candidates in their original order; "partly" ones only while fewer than `count`
  are "yes", marked `fit: 'partly'`. The `why` of each kept candidate goes into its facts as `fitWhy`.
  A failed or unreadable reply keeps every candidate unjudged (no `fit`, `verified: false`) and adds no
  error; the explanation is then told that fit is unverified.

**`pickCandidates(turns, intent, lang, opts)`** runs select → fit check → fallback and returns the
candidates for the explanation (library first), the stages, the notes, every billed call and
`fitFailed` (the check ran but gave no verdicts):

- Only "yes" counts as a library fit: "partly" is only close, and an unverified game may be merely
  word-related.
- `mine`: when fewer than 2 library candidates fit (the tool loop's source rule) and the store was not
  searched yet, it selects again with only the wishlist and the store and fit-checks those. So a
  library with five loosely related games no longer stops the search. After a failed check the store
  games join unverified instead of waiting up to 45 s for a second check that would most likely fail
  the same way.
- `any`: one selection over all sources, one fit check.
- `buy`: one selection over the wishlist and the store, one fit check.
- **"Your library has no such games":** when every library candidate was checked and none is "yes",
  the library's "partly" games are dropped (next to that sentence they would contradict it, and they
  are the loosely related picks the check is there to stop) and the note "none of the user's library
  games matches <concept or request>" is added. When owned games were left out on purpose — an owned
  reference ("like Genshin Impact" for a Genshin owner), an earlier pick, an attached game
  (`selectCandidates`' `ownedSetAside`) — the note says none of the user's **other** library games
  matches, and the answer says "no other such games". No such note after a failed check, and none
  while a library candidate is unverified. A reference the user owns elsewhere (an Epic-only Genshin
  Impact) is not reported as "not found on Steam" either.
- `offerShownAgain` (`assistant.ts`, when too few new games pass) judges the shown library games it
  offers again, unless the turn's check failed (they then come back unverified, like the rest), and
  drops the "no library game matches" note once one of them comes back.
- **Exemplar safety net** (`withExemplarNet`): the store search needs anchors (references or
  exemplars) or tags. "Liminal space games like the Backrooms" — the Backrooms is a meme, not a game —
  once came back with neither (no exemplars in the intent, embeddings down), and the answer said "no
  such games" while its own suggestions named Anemoiapolis and The Complex. When a search that may reach
  the store finds nothing and the intent has no exemplars, one small call (≤ 250 tokens) asks for 3–8
  well-known matching games and the selection and fit check run once more with them (the library too:
  an example may be owned). The intent prompt also asks for exemplars whenever a request names a kind
  of game, a setting or "like X", including when X is not a game.
- **References over exemplars:** a game the latest message names after "like" / "similar to" (in any
  language, follow-ups included) is a reference, never an exemplar — otherwise "like Genshin Impact"
  in a follow-up offered the user's own Genshin Impact back as the genre's best example.

### The tool loop: the model calls tools, the launcher executes

The model **does not see the user's data** unless a tool returns it. It gets the chat history plus a
description of the tools (local functions) and in each round returns either
`{"calls":[{"tool","args"}...]}` — up to 4 calls, up to 3 rounds — or the final answer. The launcher
runs the calls in parallel and feeds the results back as the next message.

### Attached games (context picker)

The "+" button next to the composer opens a side drawer with three tabs — library, Steam
wishlist, Steam store (title search) — where up to 20 games can be ticked. They show as chips
above the input and travel with every turn until cleared or a new chat starts. Only the title
and where it came from (library / wishlist / store) go into the system prompt; the model is told
that "these" refers to the list, to fetch facts through the tools only when needed, to propose
concrete titles from its knowledge for "games like these" and to verify each one with
`store_search` / `library_find` before recommending it, excluding the attached games themselves.
The pipeline treats attached games as references for "like these" and always excludes them.

### Tools and what they return

| Tool | Arguments | Returns |
|---|---|---|
| `library_find` | store, installed, `played` buckets (never / <1h / 1-10h / 10-50h / 50h+), `achievements` (none / started / half / almost / perfect), `lastPlayed` (2 weeks / 90 days / >180 days / never), `titleContains`, `titles` (exact titles for follow-ups), `tags` from the profile vocabularies (genres, moods, modes, themes, length), `steamTags` (Steam user tags of the Steam copy — any language or phrasing, resolved to exact tag names first; a phrase that resolves to nothing is kept as given), sort, limit ≤ 40 | games with hours, last-played date, last-2-weeks hours, achievements `unlocked/total (%)`, install flag, top Steam tags and the AI profile (incl. up to 6 keywords) |
| `library_semantic` | `query` (a feel, a mood, "games like X"), `k` ≤ 40, optional `filters` (the `library_find` filters, validated the same way) | library games ranked by meaning: the same facts plus `score` and the profile `pitch`; without an index an error telling the model to use `library_find` with tags |
| `random_pick` | the same filters as `library_find` | a few random games from the pool |
| `game_profile` | title | one game's profile (incl. `pitch`, `keywords`, `confidence`) plus the same facts |
| `store_search` | query by **name**, `onSaleOnly` | Steam games with price, discount, owned flag; DLC and soundtracks filtered out by `GetItems.type` |
| `store_browse` | tags (any language or phrasing — each phrase resolved to its best exact Steam tag, reported back as `resolved`), `onSaleOnly`, `sort` (relevance / reviews / new / price), `limit` ≤ 20, `excludeOwned` | store games by kind — the storefront's own tag search (`search/results?json=1&tags=…`, with mature-content cookies so age-gated titles are not dropped), resolved through the batched metadata |
| `store_discover` | `similarTo` (reference titles), `tags` (soft), `requireTags`, `excludeTags`, `query`, `onSaleOnly`, `maxPrice` + `maxPriceCurrency` (the currency the user named; the cap is converted to the store currency at the daily rate, or not applied without a rate), `limit` | store games similar to the references and/or of the wished kind, ranked (see [Store discovery](#store-discovery)), each with price, review share, tags (platform flags and required tags first) and short "why" reasons; plus the resolved references, unknown references, the exact tags used, phrases no tag matched (with a hint) and the price cap applied |
| `store_game_info` | title or appid | price, discount, release, genres, tags, Metacritic, reviews all-time and **last 30 days (a sample of up to 100)**, current players, review snippets, **similar owned games** with hours played |
| `wishlist` | `onSaleOnly` | the Steam wishlist with prices and discounts |
| `achievements` | title | progress and the remaining achievements of one game, **easiest first** (by global unlock rate) |
| `collections_list` / `collection_add` | — / collection name, exact titles, `create` | the user's collections (name, kind, count, sample titles); adds owned games to a manual collection |
| `inventory_overview` | — | the Steam inventory per game: item, tradable and marketable counts |
| `inventory_find` | game, text query, tag values (all must match), tradable, marketable, sort (rarity / price / name / quantity / newest), `withPrices` | items with identical ones stacked: type, rarity, quality, exterior, quantity, trade hold, main tags; with `withPrices` (or sort "price") Market prices are loaded for up to 10 items |

Store results (`describeStore`) carry the review share when it is known. Their owned flag (and
`excludeOwned`) counts a game owned on Epic through its fact card's Steam twin and ignores edition
suffixes ("… GAME OF THE YEAR EDITION"). `store_browse` searches a platform flag ("VR Only",
"Steam Deck Verified") through a stand-in (the "VR" tag) or not at all, then checks the flag on each
result; Deck flags alone return an error that asks for a kind of game. `parse_intent`,
`library_semantic`, `wishlist` and `store_discover` are also the stage names the pipeline reports;
`fit_check` is a pipeline stage only.

There is no statistics tool: the Statistics page shows the same numbers without a model.
The inventory tools are read-only like the Inventory page: the prompt tells the model to describe
items, never to offer selling, trading or crafting, and to keep items out of the `games` array
(which the app resolves against the library and the store).

**Adult content.** Nothing in the launcher filters it: Steam's search returns age-gated titles, the tag
browse and "More like this" send the mature-content cookies, and the prompt tells the model adult tags
are ordinary tags. What remains is the model's own policy — Gemma is the most cautious of the four;
DeepSeek and GLM relay such results plainly. The earlier "nothing found" for "anime roguelikes with
erotica" was a title search fed genre words, not censorship.

Steam user tags come from the batched `GetItems` metadata (`include_tag_count`), extended with official
platform flags expressed as tags — "Steam Deck Verified / Playable / Unsupported", "VR Supported / VR Only"
(`include_platforms`); games that exist only on Epic get the EGS offer's genre + feature tags instead
(`epicTags` in `epicStore.ts`, one GraphQL call per game, cached a week, warmed in the background three
at a time). So concepts the profile vocabulary lacks (VR, anime, pixel art) are still filterable on both
stores; a vocabulary value the model invents is **rejected with a message**, never silently dropped — an
ignored filter used to return the whole library sorted by playtime, which read as "you have no VR games".
Tags are matched against the local profiles offline — zero tokens; the model is told how many games have
no profile and therefore could not match a tag filter.

### What leaves the machine

What the model gets is the user's decision (2026-09-14): **games with their facts** — title,
stores, install state, hours played (to 0.1 h), last-played date, hours in the last two
weeks, achievement progress, the AI profile, wishlist and store data. Nothing that identifies
the account leaves the machine: Steam ID, names, e-mail, keys, tokens. This is not a compliance
matter (the user's data goes to the provider under their own key, like any request) but a
deliberate balance between useful advice and the amount of personal data at a third party.

The newer parts send, in addition:

- **Profile runs**: game titles with their [fact cards](#fact-cards) — public store descriptions,
  tags, features, developer, release year, review share — to the chat model; the resulting game
  texts (title, pitch, summary, keywords, store description and tags) to the embedding model.
- **Chat**: search phrases (the wished feel, the concept, tag phrases that did not match a tag
  exactly) and the texts of store / wishlist candidates (name and tags) to the embedding model at
  chutes.ai. The fit check sends the chat model the latest messages and the candidates' public facts
  (title, tags, keywords, genres, store short description or profile pitch) — the same kind of data
  the explanation already gets. Exemplar titles are looked up in the Steam store and on Epic's public
  store GraphQL, like any store search.

The texts in Settings ("AI" panel, the profile warning) and on the empty chat say exactly this.

### Assistant prompt (system)

Full text: `SYSTEM` in `assistant.ts`. Structure (2026-09-21 rewrite, after the user's choices:
concise style, assume-then-ask, library first, wishlist and price checks before purchase advice,
no repeats, smart-model escalation):

1. Role and the one non-negotiable: every claim comes from tool results.
2. How data is reached (tools, rounds, call budget).
3. Tools with typed arguments and what each returns.
4. Vocabularies, with the routing rule "outside the vocabulary → steamTags, topics → themes";
   tags may be given in any language, the app resolves them.
5. Rules in priority order (language of the latest message; lookup before "you don't have it";
   source order library → wishlist → store, moving on only when the previous source yields
   fewer than two fitting games; hard constraints such as VR / co-op / length must hold for
   every listed game and are checked against returned facts, soft wishes only rank; wishlist +
   price/review check before purchase advice; no repeats within a conversation; attached games
   are the subject; act on the likely reading and put alternatives into suggestions; one call for
   follow-ups; honesty about gaps).
6. Phrase → call shortcuts (the few-shot part small models need), incl. "games like X / a mood or
   feel" → `library_semantic` and "something like X in the store" → `store_discover {similarTo}`.
7. Style: two sentences at most before the games, notes ≤ 10 words built on a fact, no filler.
8. Output contract with both shapes.

Additions (2026-10-05, after the anomaly-hunting and gacha misses described under
[Fit check and store fallback](#fit-check-and-store-fallback)), for turns that reach the tool loop:

- **A genre or mechanic Steam has no tag for** ("anomaly hunting", "gacha", "extraction shooter"):
  name 3–6 well-known exemplar games from knowledge, check ownership with
  `library_find {titles: [...]}`, and call `store_discover {similarTo: exemplars}` in the same round.
  Its `refItems` carry the store facts (price, review share, tags, owned) of the exemplars themselves,
  which never come back among its items: the unowned ones are the store answer, and one of its items
  is listed only when its tags show the mechanic. `library_find`'s `titles` accept an owned edition of
  a named game ("Control" finds "CONTROL Ultimate Edition"), and a card for such a game is the owned
  one, never an Epic store card offering it again. A `requireTags` phrase no Steam tag matches joins
  the `query` instead of being matched literally, and the hint on unknown phrases points to this rule
  instead of explaining tag matching.
- **No loose matches:** never present loosely related games as matches; list only games whose facts
  show the asked genre or mechanic. When the library has none, say so plainly and show store games.
- **No internals:** never describe the app's machinery (tags, tools, filters) in the answer.

The pipeline has three more prompts in `aiPipeline.ts`: the intent prompt (the `Intent` JSON above,
with the clarify rule, the scope rules with English and Russian examples, and the concept / exemplar
examples), the fit-check prompt (lists the candidates that fit, "yes" or "partly"; the rest are "no")
and the explanation prompt (choose only from CANDIDATES, fit first, no internals).

Techniques worth keeping:

- **A contract instead of a persona.** Tools with argument types, the tag vocabularies, the
  final answer format. "Either calls or the answer, nothing outside JSON" +
  `response_format: json_object` + temperature 0.2.
- **Let the model read, let the app select.** The pipeline asks the model for a structured reading
  of the request and for the explanation; filtering and ranking are code, so a hard constraint
  cannot be forgotten and the candidates are the same for every model.
- **Phrase-to-call hints** for common requests: "cozy" → `moods ["cozy","relaxing"]`,
  "short" → `maxLengthHours 6`, "what to finish" → `achievements "almost"` or
  `played "10-50h"` + `lastPlayed "over_180_days_ago"`.
- **A recipe for "worth buying"**: compare all-time vs 30-day review share, review volume,
  price and discount, current players (only matters for multiplayer), age, similar unplayed
  games in the library; end with one of four clear verdicts.
- **A follow-up rule**: "which of those are installed?" = ONE `library_find` with
  `titles: [...]`, never one call per game (the model used to make four).
- **Honesty about gaps**, in words about games, not about the app: games without a profile could not
  be checked; Steam not signed in → the wishlist and achievements are unavailable; the library has no
  game of the asked kind → say so in one clause, then show store games. How the app searched (tags,
  filters, indexes, tools) never appears in an answer — the eval fails an answer that mentions it.
- **Exemplars for concepts, verified by the app.** For a genre Steam has no tag for, the model names
  well-known games of it; the app checks ownership and finds them on Steam or the Epic Games Store, so
  the model's knowledge supplies the anchors and the stores supply the facts.
- **Fit is its own question.** Five candidates are not five matches: a separate judge call keeps only
  games that have the defining mechanic, and "enough" is decided after it, not before.
- **Language of the latest message**, not of the interface: a Russian question gets a Russian
  answer even when the UI is English.
- **Named game → look it up first** (`titles: [...]` or `game_profile`) before claiming it is
  not in the library.
- **Contract violations get one correction round**: a reply with neither `calls` nor a
  non-empty `answer` is sent back with a reminder instead of surfacing as an empty bubble.
- **Escalation for advice**: tool rounds (and the intent call and the fit check) run on the user's
  (cheap) model; once a turn that asks for recommendations has facts, the remaining rounds (or the
  explanation call) run on the "smart" curated model (DeepSeek), unless the user's own choice already
  ranks at least as high. In the tool loop a wording test decides what asks for recommendations; the
  pipeline's explanation always escalates, since every turn it answers is advice (genre questions and
  a bare "more" included). The footer shows the model that wrote the answer. Roughly ×3 on the final
  call, nothing on plain lookups.
- **Context** in one line: language, date, library size, how many games have profiles,
  whether Steam is signed in.

### Game verdict (system)

`VERDICT_SYSTEM`: judge only from the FACTS given; address the user as "you", never "the
user"; similar unplayed games are a secondary factor, `own_similar` only for close
substitutes. Strict JSON: verdict (`buy / wait_for_sale / skip / own_similar /
already_owned`), score 1–10, 2–3 sentences, pros, cons, review trend, "for whom". The UI
shows the facts (percentages, players, price, Metacritic) in a separate strip and the model's
opinion below, labelled "AI opinion, not advice". Cached for an hour per game.

**Steam gotcha:** `appreviews?...&day_range=30` limits the **list** of reviews, but
`query_summary` is always all-time. The 30-day share is therefore counted over a sample of up
to 100 most helpful reviews from that window and labelled as a sample.

## Fact cards

A profile written from the title alone is the model's memory of the game — fine for famous games,
guesswork for the long tail. In the reference library ~513 of ~717 titles are Epic-only, so the
Steam data the app already had covered only a minority of the games. A **fact card** is the public
store data for one title, built before the profile and given to the model as authoritative.
Code: `gameFacts.ts`.

- **Sources**, best first (`FactCard.source`):
  - `steam` — the game's own Steam copy (a title owned on both stores uses the Steam appid);
  - `steam_twin` — an Epic-only title whose Steam page was found: a store search whose hit matches
    the **exact normalized title** and is a game (not a DLC or soundtrack). Many Epic games are also
    sold on Steam, and the Steam page has richer data (tags in vote order, categories, reviews);
  - `epic` — no twin: the EGS offer (description, genres, features, developer, release date);
  - `none` — nothing found.
- **Steam data**: `steamAppFacts(appids)` in `steamStore.ts` — `IStoreBrowseService/GetItems` in
  batches of 50, English text, with the basic info, full description, 20 tags, release, reviews and
  platforms. Tags are resolved to names (plus the platform-flag tags: Steam Deck, VR), categories
  through `GetStoreCategories` (player modes first, then controller support, then features; DLC /
  demo categories and placeholder names skipped). A chunk that fails with HTTP 429 or 5xx is retried
  once after 3 s, then skipped.
- **Twin lookup pace**: two lookups in flight, each worker pausing 250 ms after a request. On HTTP
  429 every store search waits out a shared cooldown (30 s, doubling up to 120 s while the store keeps
  throttling, back to 30 s after a success) and the title is retried once.
- **Run-wide cut-off**: after 4 transient store-search failures in a row (429 after the retry,
  network, 5xx), the store search stops for the rest of the run; after 4 inconclusive Epic lookups in
  a row, so do the Epic lookups. Every title still queued is then left without a card and is profiled
  from its title alone (`grounded: 'none'`, no profile version); it counts as built from titles only,
  so the "rebuild" button in Settings queues it and looks its facts up again.
- **Card fields**: year (for `epic` cards the offer's listing date on EGS, shown as "On EGS since"
  so the model does not take it for the release year), developer, store tags (max 20; EGS genres +
  features for `epic` cards),
  categories (Single-player, Online Co-op, Full controller support, VR Only, …), the short
  description, `about` (at most 600 characters of the long description, BBCode / HTML / placeholders
  stripped, not repeating the short one), review share and count, build time.
- **For prompts** `factCardText(card, 900)` renders a compact block:
  ```
  Year: 2016 · Developer: ConcernedApe · Reviews: 98% of 896k     (On EGS since: … for epic cards)
  Steam tags: Farming Sim, Life Sim, Pixel Graphics, …             (EGS tags: … for epic cards)
  Features: Single-player, Online Co-op, …
  Description: <short> <about>
  ```
- **Persistence**: `userData/game-facts.json`, not the 7-day cache — cards ground profiles and
  embedding texts and must not silently disappear. A card is rebuilt after 30 days
  (`FACTS_MAX_AGE_DAYS`). The file is saved after every batch (temp file + rename).
- **Honest failures**: a transient error for a title (network, 5xx, 429 after the retry, a request-level
  4xx from GetItems, an EGS answer whose offer list itself carries a GraphQL error) leaves the title
  **without** a card, so it is retried the next time a run queues it, instead of writing a misleading
  `none`. Every EGS request has a 20 s limit, so a request that never answers cannot hold the build.
  When Steam's tag or category catalog is still empty after two retries 3 s apart, the build throws
  `FACTS_UNAVAILABLE` instead of writing tagless cards.
- The batched store metadata (`StoreItem`) gained `reviewPct` / `reviewCount` for the store-side
  ranking; its cache version was bumped so existing metadata is refetched once.

## Game profiles (library enrichment)

Stores know a game's storefront tags and blurb but not **how long it takes to finish**, its
**mood**, what it **feels** like to play, or what it is about in two honest sentences. A profile is
that card, written by the model from the fact card plus its own knowledge. Stored in
`%APPDATA%/steam-egs-launcher/enrichment.json` keyed by `normalizeTitle(title)`.

**Fields** (`GameProfile`): `lengthHours` / `endless`, `genres` (35 slugs), `moods` (17), `themes`
(English keys used for matching) + `themesLocal` (the same themes in the UI language), `modes`
(single / coop_local / coop_online / pvp / mmo), `coopPlayers`, `summary` (2–3 sentences in the UI
language). Version 2 (`v: 2`, `PROFILE_VERSION`) adds:

- `keywords` — 10–15 lowercase English descriptors of mechanics, structure, feel, perspective,
  session length and difficulty ("turn-based", "deckbuilding", "short runs", "base building",
  "first-person", "permadeath"); the vocabulary-free layer that meaning-based search and theme
  matching use;
- `pitch` — one sentence in the run's UI language: for whom and when it fits ("A relaxed farming sim
  for slow evenings; plays fine in 30-minute sessions"), shown in italics above the summary on the
  game page;
- `confidence` — `high` (store facts given and the model knows the game), `medium` (one of the
  two), `low` (neither); `known` is now derived (`confidence !== 'low'`) and kept for existing
  consumers;
- `grounded` — which fact source the profile was built from.

Version 1 files still load: a profile without `confidence` counts as `medium` when it was `known`,
otherwise `low`.

**Prompt** (`enrichment.ts`, English with `{{language}}` placeholders): the facts are authoritative —
never contradict them; own knowledge fills the gaps (length, feel, mechanics); `modes` must agree
with the Features line (Single-player → single, Online Co-op → coop_online, LAN or
Shared/Split Screen Co-op → coop_local, any PvP → pvp, MMO → mmo); keywords without genre words
already in `genres`, without title words, without marketing; a `low`-confidence profile stays
minimal and honest; summary concrete and neutral. The JSON envelope is `{"games":[…]}` with each
`title` copied exactly. The user message lists each title with its card text indented under it.

**Validation** (`toProfile`): keywords lowercased, at most 30 characters each, at most 15, deduped;
pitch at most 240 characters; confidence one of the three (default: facts present → `medium`,
otherwise `low`); when the card has categories, `modes` are **derived from the categories** and the
model's modes are used only if that set is empty (categories are authoritative); vocabulary values
are checked and the title must belong to the batch.

**A run** starts only from the button, after a warning with an estimate (titles, requests, tokens,
cost at live model prices, minutes), and has three phases, each shown with its own progress line in
Settings:

1. `facts` — fact cards for the queued titles. A title whose facts failed is still profiled, without
   facts (`grounded: 'none'`), and its profile gets no version, so it counts as built from titles only
   and a later "rebuild" looks its facts up again. The run reports how many titles got no facts
   (`FACTS: MISSED n/total`, worded by Settings). Cancel ends this phase at once, even mid-request.
2. `profiles` — batches of 10 titles, three requests in flight, `max_tokens` 5,000, a 240 s timeout
   per batch. Every batch is saved as it finishes; "Stop" aborts the in-flight requests.
3. `index` — the [semantic index](#semantic-index) for the library. An index failure is reported
   (prefixed `INDEX:`) but does not mark the profiles failed.

It is incremental. What is queued depends on the button: games **without a profile**; plus profiles
written **in another language** (after a UI language switch, Settings shows how many and offers to
rewrite them); or plus profiles from the **previous version** (built from titles only — Settings
shows "{n} profiles were built from titles only" with a rebuild button and the same warning). The
IPC still accepts the old boolean "redo" flag (`true` = other language). **Build index** in
Settings runs only phase 3 for libraries whose profiles exist but whose index is missing or stale —
no warning, since embeddings cost a fraction of a cent. "Delete all profiles" also deletes the
library vectors; the tag index is kept (it comes from Steam's tag list, not from the user's games).

Measured on the first version (titles only, batches of 15): 15 games — 2,700 tokens, 64 s, 13 of 15
recognised.

Where profiles are used: the "AI · ≈ 11 h · Action, Horror" line, the pitch and the "In short" card
on the game page; the filter chips (Short / Co-op / Story / Cozy / Horror / Competitive) behind the
"Filters" toggle in the library (list and grid) and the random reel; "Hours by genre" in Statistics;
the assistant's tools (tag filters — theme matching also searches keywords —, `game_profile`, similar
games for the verdict); the embedding texts.

## Semantic index

Tags and vocabularies answer "co-op" or "VR"; they do not answer "something melancholic to unwind
with" or "like Hades but calmer". The semantic index stores one vector per library game and ranks by
meaning. Code: `embeddings.ts`.

- **Model and endpoint**: `Qwen/Qwen3-Embedding-8B` on the public chute
  `POST https://chutes-qwen-qwen3-embedding-8b-tee.chutes.ai/v1/embeddings`, OpenAI format
  (`{ model, input: [...] }` → `data[].embedding`, `usage.prompt_tokens`), the same bearer key as chat
  (unauthenticated requests get 429). The model is multilingual, so a Russian query can match games
  whose texts are English.
- **Dimensions and wire format**: the native vector has 4,096 dimensions; the model is
  Matryoshka-trained, so any prefix re-normalized is a valid smaller embedding. The client asks for
  `dimensions: 1024` and `encoding_format: "base64"` (both in the chute's input schema; base64 is about
  4x smaller than a JSON float list). Both are optional extras: when a request fails in a way that may
  be about the body — 400 / 422, or 500 "exhausted all available targets", which is how chutes' gateway
  reports that every instance refused it — the client steps down to base64 only, then to the plain
  OpenAI body, and keeps the first shape that works for the rest of the session. Vectors are always
  truncated client-side to 1,024 (`EMBED_DIMS`) and L2-normalized, so cosine similarity is a dot
  product.
- **Availability**: this is the only embedding model on chutes, and it is less reliable than the chat
  models — during development it answered "Infrastructure is at maximum capacity" (429) for long
  stretches while its instances sat idle. Everything that uses it has a fallback (word overlap for
  ranking, exact names and synonyms for tags), so the assistant keeps working; Settings shows the
  index error and a **Build index** button to retry later.
- **Queries vs documents**: queries use the model's instruction format
  `Instruct: <task>\nQuery: <text>` (a game-retrieval instruction by default); documents are embedded
  raw.
- **Requests**: batches of 32, three in flight, cancellable, with a budget per caller. Index builds
  (and their tag sync): a 60 s timeout, 429 / 5xx retried after 5, 15 and 30 s, a timeout or network
  error once after 2 s. Chat turns (query vectors, store candidates, the resolver): a 12 s timeout,
  one quick retry only after a dropped connection, and a breaker — after a chat-path failure that
  means "busy or unreachable" (429, 5xx, timeout, network) chat calls fail at once for 60 s and their
  callers use the fallbacks; any successful request closes it. `embedTexts` itself keeps a 60 s
  timeout with one retry after 2 s / 5 s. `AI_NO_KEY`, `AI_AUTH` (401/403) and `AI_BALANCE` (402)
  surface like the chat errors. Token usage goes into the AI usage counter.
- **The text of a game** (`gameEmbedText`): title, pitch, summary, keywords, the store short
  description, up to 12 store tags, genres, moods, themes, modes and length — whatever exists, with
  English labels, at most 1,500 characters. A profile with `known: false` adds nothing (its
  boilerplate would pull all unknown games together); a title-only profile (no version) next to a
  fact card with content adds only its modes, co-op count and length, so the store's word wins.
- **Incremental**: each game's text is hashed (SHA-1); only games whose text is new or changed are
  embedded, and vectors of games that left the library are dropped. A new profile or fact card
  therefore re-embeds just that game.
- **Storage**: `userData/embeddings.json` —
  `{ version: 1, model, dims, games: { [key]: { h, v } }, tags: { [tagName]: { h, v } } }` with each
  vector as base64 of a `Float32Array`; written atomically, loaded lazily and kept in memory.
  A second build request while one runs joins the running one.
- **Search** (`semanticSearch`): the query vector (memory cache, 200 entries) against the library
  vectors, optionally limited to candidates from hard filters. With reference games ("like Hades"
  where Hades is owned) the score is 0.65 · cos(query) + 0.35 · max cos(reference), or the reference
  term alone without a query. Games without a vector are skipped; with no vectors at all the search
  reports `INDEX_EMPTY` and callers fall back to tags or word overlap.
- **Non-library items** (`scoreTexts`): store and wishlist candidates are embedded as documents on
  the fly (memory cache by text hash, 3,000 entries) and scored against the query.
- **Status** (`indexStatus`): indexed games, library games, stale games (missing vector or changed
  text), building flag, indexed tag count, model, last error — shown in Settings as
  "Semantic index: {i} of {g} games" with **Build index** when something is stale.
- **Cost**: embedding the whole library costs a fraction of a cent; per chat turn it is one short
  query plus, on the store side, the candidates' short texts (cached).

## Tag resolver

Users and models write "pixel art", "coop", "vr", or "anime" and "space" in Russian; Steam's tag
search wants "Pixel Graphics", "Co-op", "VR", "Anime", "Space". `resolveTags(phrases)` in
`embeddings.ts` maps free phrases in any language to exact Steam tag names:

1. **Exact pass** (no network): tag names, the synonym table (`TAG_SYNONYMS` in `steamStore.ts`, which
   also maps "mods" / "modding" to "Moddable" and "virtual reality" to "VR") and spelling variants
   (hyphens, spaces, "&" / "and"), case-insensitive; "party games" tries the singular of the whole
   phrase ("Party Game") before dropping "games". The official platform-flag tags ("Steam Deck
   Verified", "Steam Deck Playable", "VR Supported", "VR Only") are part of this vocabulary although
   Steam's tag list lacks them.
2. **Embedding pass** for the rest: the phrase against a **tag index** — every Steam tag (~450)
   embedded once as the tag plus its synonyms, e.g. "Sexual Content (erotic, nsfw, adult)", stored in
   the same `embeddings.json` and built on demand (tags only, cheap). Tags scoring at least
   `TAG_MIN_SCORE` (0.55) and within 0.08 of the best are kept, at most 3. The pass is skipped without
   a key, while the chat breaker is open, for two minutes after a failed on-demand tag sync, and while
   the tag index covers less than 98 % of Steam's tags (a half-synced index would map "space" to a
   merely related tag).

It never fails a request over the network: without the embedding pass a phrase that matched nothing
exactly simply resolves to no tags. Chat callers use `resolveTagsWithin`, which gives the embedding
pass a deadline (10 s for the tools, 13 s for the pipeline, 15 s inside store discovery): past it the
exact matches still come back and a first-ever tag sync goes on in the background. The pipeline's and
store discovery's deadlines sit above the 12 s chat-path request timeout on purpose: a stalled endpoint
then fails the request itself with `AI_TIMEOUT`, which opens the breaker, so the semantic ranking right
after fails at once instead of stalling for another 12 s (a deadline abort does not count as an
endpoint failure). Platform phrases are
read as families by the callers: "Steam Deck" accepts Verified or Playable ("verified" narrows it),
"VR" accepts the user tag and both flags ("only" narrows it), and "deck builder" stays Deckbuilding. Users of the resolver: `store_browse` (top tag per phrase,
reported back as `resolved`), `library_find` / `random_pick` / `library_semantic` `steamTags` (top tag
per phrase; an unresolved phrase is kept as given), the pipeline's hard and excluded tags, and
`storeDiscover`. The thresholds and the blend weights are exported constants so the eval can tune
them.

## Store discovery

"Something like Hades" used to mean the model guessing titles from memory and checking each with a
title search. Steam already computes similarity for every game — the "More like this" page — so the
app uses that. Code: `similar.ts`.

- **`moreLikeThis(appid)`** reads `https://store.steampowered.com/recommended/morelike/app/<appid>/`
  (HTML, browser user agent, age-gate cookies) and collects the `data-ds-appid` entries per section:
  *released* (weight 1.0), *top selling* (0.8), *new releases* (0.6); *coming soon* is ignored, and
  everything before the released section (the reference game itself) is skipped. Each id's weight is
  its section weight times a rank decay. Cached 7 days (cache namespace `similar`); an empty page is
  cached as empty, transient errors are not cached.
- **`storeDiscover(args, lang)`**:
  1. **References** (at most 6 — the pipeline passes the user's references first, then the intent's
     exemplars): the library's Steam appid, else the fact card's twin appid, else Steam's title lookup,
     else the first store-search game hit whose normalized title contains or is contained in the wanted
     one. Unfound titles are reported as `unknownRefs`. The references themselves never appear in the
     results (the pipeline adds exemplars as candidates on its own).
  2. **Candidates**: "More like this" for each reference (three in flight); a game similar to several
     references sums their weights (averaged over the references that answered) and ranks higher; a
     tag search for the required tags tops the lists up at a lower weight. Without references: the
     storefront search with the required + soft tags (at most 4), sorted by relevance and by reviews
     (40 each); with no tags but a `query`, the query's best resolved tags are used. Sale, price and
     Steam Deck go to the search itself (`specials`, `maxprice` rounded up to the region's own price
     steps, which are read from the search page, `deck_compatibility` 3 = Verified, 2 = Playable), so
     "free co-op games" or "Deck Verified roguelikes" are not limited to whatever ranks in the top 40.
  3. **Filters** on the batched metadata of the top 120: games only, released; excluded titles /
     appids and (by default) owned games dropped — owned by appid, including the Steam twins of
     Epic-only games, or by title with or without an edition suffix; every required tag must be
     present, no excluded tag may be (a required or excluded phrase that matched no tag is matched
     literally against the tag names instead of being dropped); sale-only and the price cap (in the
     store currency's major units; free games pass, a game without a known price does not, a cap of
     0 accepts only free games).
  4. **Ranking**: base score + 0.15 × the share of soft tags present + 0.10 × a review boost
     (≥ 90 % → 1, ≥ 80 % → 0.6, ≥ 70 % → 0.3, scaled by review volume); with a `query`, blended
     0.6 / 0.4 with the semantic score of the item's name and tags.
  5. **Why**: short English reasons — which references listed it, which wished tags it has.
- It serves the `store_discover` tool and the store stage of the pipeline.

## Eval harness

Prompt, model and weight changes are judged on a fixed set of real phrases rather than by feel.
Code: `services/aiEval.ts`, cases in `steam-egs-launcher/eval/ai-cases.json`, usage notes in
`steam-egs-launcher/eval/README.md`.

- **Run**: `npm run ai:eval` in `steam-egs-launcher/` builds the app and starts it with `--ai-eval`:
  no window, no autosync, no updater, no bridge — the cases run sequentially through
  `assistantChat` against the real local library, with the saved key (so it spends tokens). Options:
  `--ai-eval-cases=<path>`, `--ai-eval-only=<id,id>`. The exit code is 1 when a case fails.
- **Cases** (25–30, English and Russian): a message, optional earlier turns (with their `games`),
  optional UI language and attached games, and **property-based expectations** rather than exact
  titles — answer language, tools used / not used, number of games, owned or not, every game carries
  one of some tags (Steam / EGS tags; "VR" also accepts "VR Only" / "VR Supported") or none of
  others, profile modes, maximum length, answer regexes, no repeats of earlier cards, excluded titles,
  latency. `expectAnyOf` (well-known titles) is a soft metric, not pass / fail; `requireAnyOf` is its
  hard twin — the case fails unless at least one game card matches an entry (normalized titles equal,
  or the card title starts with the entry, so "I'm on Observation Duty 5" matches "I'm on Observation
  Duty"). Coverage: VR, co-op tonight, short games, "like Hades" in the library and in the store, cozy,
  "not horror", anime and adult tags in the store, Steam Deck, the never-launched backlog,
  almost-finished achievements, total hours, worth buying, wishlist sales, the inventory, collections,
  "more" follow-ups, attached games, ambiguous one-word requests, Russian phrasings, session length, a
  price cap, and genres Steam has no tag for: `genre-anomaly-ru` / `genre-anomaly-en` (anomaly hunting
  — at least one of The Exit 8, Platform 8, I'm on Observation Duty…, none of the detective games or
  S.T.A.L.K.E.R. the old answer listed), `genre-gacha-ru` (at least one of Genshin Impact, Wuthering
  Waves, Honkai: Star Rail, Zenless Zone Zero…) and `like-genshin-followup-ru` (a "something like
  Genshin Impact" follow-up after the gacha question — a gacha game, not the open-world RPGs the old
  answer found by word overlap).
- **Implicit checks** on every case: the answer is not empty; games are not named without a single
  tool call; and **no internals** — an answer that mentions Steam tags, literal matching, tools,
  indexes or filters (in English or Russian) fails.
- **Report**: `userData/ai-eval/report-<ISO time>.json` plus a short Markdown table next to it —
  per case pass / fail with the failed checks and reasons, latency, tokens, model, tools used, the
  answer (trimmed) and the game titles; totals and failures are printed. Secrets are never printed.

## Practices applied here (and worth keeping)

1. **Structured output instead of prose.** JSON mode + a strict schema + normalisation:
   numbers clamped to ranges, strings trimmed, unknown slugs dropped. Broken JSON degrades
   to a plain-text answer, not to an error.
2. **The model is not the source of truth.** It picks from what the tools (or the candidate
   selection) showed it, and every named title is checked against the real library or store before
   it becomes a card. Profiles are grounded in store facts, and where facts and the model disagree
   (play modes) the facts win in code, not only in the prompt.
3. **Selection in code, language in the model.** Hard constraints are filters, ranking is embeddings
   and arithmetic; the model reads the request and explains the result.
4. **Be explicit about what leaves the machine.** The user chooses the level of detail
   (currently game facts without account identity); the texts in Settings and on the empty
   chat say exactly what is sent, including the embedding model. Quick actions only fill the input
   — no click spends tokens without an explicit send.
5. **Budget by construction.** Round and call limits, trimmed tool results and history,
   `max_tokens` per task, a verdict cache, incremental embeddings by text hash, a token counter in
   every answer footer.
6. **The key stays in the main process**, stored via `safeStorage`; everything arriving over
   IPC is validated (key shape, model id, chat history length and shape incl. `games`, appid,
   redo mode).
7. **Provider resilience.** Retry on the chosen model, then fallback models; auth and balance
   errors are not retried; long generations get a longer timeout and an `AbortSignal` for
   cancellation; the pipeline falls back to the tool loop; search falls back from vectors to tags and
   word overlap.
8. **Understandable errors.** `AI_NO_KEY / AI_AUTH / AI_BALANCE / AI_RATE / AI_HTTP_*` map to
   messages with an action.
9. **Transparency.** The progress indicator names the tools or stages currently running; the answer
   footer shows the model, tokens and tools used; "All results" reveals the raw findings; the
   pipeline states the reading it acted on.
10. **UI language = answer language**; internal values (slugs, criteria, keywords, embedding texts)
    stay English.
11. **Expensive things once, and on demand.** Enrichment and verdicts are started by the user,
    with the cost on the button or in the warning; fact cards, profiles and vectors live locally and
    serve several screens.
12. **Measure, then tune.** The eval cases are re-run when the model, a prompt or a weight
    (`TAG_MIN_SCORE`, the blend weights) changes.
13. **Relevance is checked, not counted.** Candidates pass a fit check before "enough" is decided;
    when the library has nothing that fits, the answer says so and goes to the store (Steam, then the
    Epic Games Store for games Steam does not sell) instead of offering the closest misfits.
14. **Answers talk about games.** The way the app searched (tags, filters, indexes, tools) stays out
    of the answer; a miss is told as "no such games" plus concrete next requests.
15. **Degenerate JSON is detected, not trusted.** Some models in JSON mode fall into loops that still
    parse — a key repeated inside one object (`"title":"D","note":"","title":"Dungeons 3",…`, the
    last duplicate wins), an empty key, or a value that swallowed the rest of the list because the
    model switched to single-quoted pseudo-JSON mid-string (`"note":"…30 min.'}, {'title':'Void
    Bastards',…"`, which parses as one game with a long note). `jsonDefect()` in `aiClient.ts` spots
    all three. The intent and the
    explanation are asked once more with a hint written for that step; for the intent, the reply that
    carries more of the request wins (a retry once came back as the bare default template). Profile
    batches retry their unmatched titles in half-size batches. With `LAUNCHER_AI_DEBUG` every defect
    is logged as `[ai] degenerate JSON from <model>`.
16. **Forced JSON mode stays on.** Measured on 2026-10-06 with DeepSeek-V4-Flash over the 34 eval
    cases: with `response_format: json_object` 33 passed (3 degenerate replies, 2 recovered by the
    retry); without it (`LAUNCHER_AI_JSON_MODE=off`, an experiment switch for such comparisons) 30
    passed — an English answer to a Russian question, S.T.A.L.K.E.R. offered as anomaly hunting, an
    unowned game shown as owned.
