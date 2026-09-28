# AI in GL Aggregator: chat assistant, game profiles, prompts, practices

Everything AI-related in the launcher runs through a model on [chutes.ai](https://chutes.ai),
an OpenAI-compatible endpoint (`https://llm.chutes.ai/v1/chat/completions`). Three parts:

- **The "AI" page** — one multi-turn chat: library search, advice on what to play / finish /
  drop, "is it worth buying", questions about the library.
  Code: `steam-egs-launcher/src/main/services/assistant.ts` (tools and the call loop),
  page `src/renderer/src/pages/AiPage.tsx`.
- **The "Worth buying?" block** on the game page — the same analysis on demand, with facts
  shown separately from the opinion (`gameVerdict` in `assistant.ts`, `VerdictBlock` in
  `GameDetailsPage.tsx`).
- **Game profiles** ("backlog enrichment") — a one-off pass over the whole library, started
  from Settings → "AI" → "Game profiles" — `services/enrichment.ts`.

The shared HTTP client (model list, JSON mode, retries and fallback models, timeouts, token
accounting) is `services/aiClient.ts`. Settings live in the "AI" panel of `SettingsPage.tsx`.

## Key and model

- **Where the key goes:** Settings → "AI" → "chutes.ai API key" → "Save key". The key is
  stored encrypted in the OS keystore (`secrets.bin`, DPAPI via `safeStorage`) next to the
  Steam key; it never reaches the renderer.
- **Models.** Four tested ones, all with `json_mode` (`CURATED_MODELS` in `aiClient.ts`,
  prices come from `/v1/models`): `google/gemma-4-31B-turbo-TEE` — default, cheap and fast
  (~$0.12/$0.37 per 1M); `Qwen/Qwen3-32B-TEE` — an alternative at the same price;
  `deepseek-ai/DeepSeek-V4-Flash-0731-TEE` — smarter (~$0.44/$1.32); `zai-org/GLM-5.1-TEE` —
  best quality (~$0.98/$3.08). On a 429 "at maximum capacity" the client retries, then
  switches to the next model on the list; the answer footer shows which model replied. Thinking
  models get `chat_template_kwargs.enable_thinking = false` (Qwen3 otherwise returns an empty
  content field), and an empty reply counts as a busy model, so the next one is tried.
- **Cost.** A chat turn is 3–9k tokens (one or two tool rounds), i.e. a fraction of a cent on
  the default model; a game verdict ~1.5–3k; profiling a ~700-game library ~150k tokens,
  about $0.06. The usage counter is visible in Settings.

## The assistant: the model calls tools, the launcher executes

The model **does not see the user's data**. It gets the chat history plus a description of
the tools (local functions) and in each round returns either `{"calls":[{"tool","args"}...]}`
— up to 4 calls, up to 3 rounds — or the final answer:

```json
{ "answer": "markdown in the user's language",
  "games": [{ "title": "exact title from tool results", "note": "why" }],
  "suggestions": ["a natural follow-up question", "..."] }
```

The launcher runs the calls in parallel, feeds the results back as the next message and, at
the end, **resolves every named title** against the real library (a card with Play / Open /
Skip-in-reel actions) or the store (a store card). A title found in neither stays plain text.
Everything the tools returned during the turn is available under "All results", so a
search-like question still shows the full list rather than only what the model chose to
mention.

**Streaming.** Every round is requested with `stream: true` (SSE). Tool rounds produce nothing
visible; when the final JSON starts with `"answer": "…"`, the launcher decodes the string value
as it arrives (`partialAnswer` in `assistant.ts`) and pushes it to the page as `ai:progress`
events (throttled to ~12/s), so the text paints while the model writes and the cards appear once
the JSON closes. Usage comes from the last chunk (`stream_options.include_usage`).

### Attached games (context picker)

The "+" button next to the composer opens a side drawer with three tabs — library, Steam
wishlist, Steam store (title search) — where up to 20 games can be ticked. They show as chips
above the input and travel with every turn until cleared or a new chat starts. Only the title
and where it came from (library / wishlist / store) go into the system prompt; the model is told
that "these" refers to the list, to fetch facts through the tools only when needed, to propose
concrete titles from its knowledge for "games like these" and to verify each one with
`store_search` / `library_find` before recommending it, excluding the attached games themselves.

### Tools and what they return

What the model gets is the user's decision (2026-09-14): **games with their facts** — title,
stores, install state, hours played (to 0.1 h), last-played date, hours in the last two
weeks, achievement progress, the AI profile, wishlist and store data. Nothing that identifies
the account leaves the machine: Steam ID, names, e-mail, keys. This is not a compliance
matter (the user's data goes to the provider under their own key, like any request) but a
deliberate balance between useful advice and the amount of personal data at a third party.

| Tool | Arguments | Returns |
|---|---|---|
| `library_find` | store, installed, `played` buckets (never / <1h / 1-10h / 10-50h / 50h+), `achievements` (none / started / half / almost / perfect), `lastPlayed` (2 weeks / 90 days / >180 days / never), `titleContains`, `titles` (exact titles for follow-ups), `tags` from the profile vocabularies (genres, moods, modes, themes, length), `steamTags` (Steam user tags of the Steam copy — "VR", "Anime", "Pixel Graphics"…, any of), sort, limit ≤ 40 | games with hours, last-played date, last-2-weeks hours, achievements `unlocked/total (%)`, install flag, top Steam tags and the AI profile |
| `random_pick` | the same filters | a few random games from the pool |
| `game_profile` | title | one game's profile plus the same facts |
| `store_search` | query by **name**, `onSaleOnly` | Steam games with price, discount, owned flag; DLC and soundtracks filtered out by `GetItems.type` |
| `store_browse` | Steam tag names (all must match; everyday words like "erotic" or "coop" map to tags), `onSaleOnly`, `sort` (relevance / reviews / new / price), `limit` ≤ 20, `excludeOwned` | store games by kind — the storefront's own tag search (`search/results?json=1&tags=…`, with mature-content cookies so age-gated titles are not dropped), resolved through the batched metadata |
| `store_game_info` | title or appid | price, discount, release, genres, tags, Metacritic, reviews all-time and **last 30 days (a sample of up to 100)**, current players, review snippets, **similar owned games** with hours played |
| `wishlist` | `onSaleOnly` | the Steam wishlist with prices and discounts |
| `achievements` | title | progress and the remaining achievements of one game, **easiest first** (by global unlock rate) |
| `inventory_overview` | — | the Steam inventory per game: item, tradable and marketable counts |
| `inventory_find` | game, text query, tag values (all must match), tradable, marketable, sort (rarity / price / name / quantity / newest), `withPrices` | items with identical ones stacked: type, rarity, quality, exterior, quantity, trade hold, main tags; with `withPrices` (or sort "price") Market prices are loaded for up to 10 items |

There is no statistics tool: the Statistics page shows the same numbers without a model.
The inventory tools are read-only like the Inventory page: the prompt tells the model to describe
items, never to offer selling, trading or crafting, and to keep items out of the `games` array
(which the app resolves against the library and the store).

**Adult content.** Nothing in the launcher filters it: Steam's search returns age-gated titles, the tag
browse sends the mature-content cookies, and the prompt tells the model adult tags are ordinary
tags. What remains is the model's own policy — Gemma is the most cautious of the four; DeepSeek
and GLM relay such results plainly. The earlier "nothing found" for "anime roguelikes with
erotica" was a title search fed genre words, not censorship.
Steam user tags come from the batched `GetItems` metadata (`include_tag_count`), extended with official
platform flags expressed as tags — "Steam Deck Verified / Playable / Unsupported", "VR Supported / VR Only"
(`include_platforms`); games that exist
only on Epic get the EGS offer's genre + feature tags instead (`epicTags` in `epicStore.ts`, one
GraphQL call per game, cached a week, warmed in the background three at a time). So concepts the
profile vocabulary lacks (VR, anime, pixel art) are still filterable on both stores; a vocabulary value the model
invents is **rejected with a message**, never silently dropped — an ignored filter used to return the
whole library sorted by playtime, which read as "you have no VR games".
Tags are matched against the local profiles offline — zero tokens; the model is told how
many games have no profile and therefore could not match a tag filter.

### Assistant prompt (system)

Full text: `SYSTEM` in `assistant.ts`. Structure (2026-09-21 rewrite, after the user's choices:
concise style, assume-then-ask, library first, wishlist and price checks before purchase advice,
no repeats, smart-model escalation):

1. Role and the one non-negotiable: every claim comes from tool results.
2. How data is reached (tools, rounds, call budget).
3. Tools with typed arguments and what each returns.
4. Vocabularies, with the routing rule "outside the vocabulary → steamTags, topics → themes".
5. Rules in priority order (language of the latest message; lookup before "you don't have it";
   source order library → wishlist → store, moving on only when the previous source yields
   fewer than two fitting games; hard constraints such as VR / co-op / length must hold for
   every listed game and are checked against returned facts, soft wishes only rank; wishlist + price/review check before purchase advice; no repeats within
   a conversation; attached games are the subject; act on the likely reading and put alternatives
   into suggestions; one call for follow-ups; honesty about gaps).
6. Phrase → call shortcuts (the few-shot part small models need).
7. Style: two sentences at most before the games, notes ≤ 10 words built on a fact, no filler.
8. Output contract with both shapes.

Techniques worth keeping:

- **A contract instead of a persona.** Tools with argument types, the tag vocabularies, the
  final answer format. "Either calls or the answer, nothing outside JSON" +
  `response_format: json_object` + temperature 0.2.
- **Phrase-to-call hints** for common requests: "cozy" → `moods ["cozy","relaxing"]`,
  "short" → `maxLengthHours 6`, "what to finish" → `achievements "almost"` or
  `played "10-50h"` + `lastPlayed "over_180_days_ago"`.
- **A recipe for "worth buying"**: compare all-time vs 30-day review share, review volume,
  price and discount, current players (only matters for multiplayer), age, similar unplayed
  games in the library; end with one of four clear verdicts.
- **A follow-up rule**: "which of those are installed?" = ONE `library_find` with
  `titles: [...]`, never one call per game (the model used to make four).
- **Honesty about gaps**: no profiles → say the tag filter could not be applied; Steam not
  signed in → say the wishlist and achievements are unavailable.
- **Language of the latest message**, not of the interface: a Russian question gets a Russian
  answer even when the UI is English.
- **Named game → look it up first** (`titles: [...]` or `game_profile`) before claiming it is
  not in the library.
- **Contract violations get one correction round**: a reply with neither `calls` nor a
  non-empty `answer` is sent back with a reminder instead of surfacing as an empty bubble.
- **Escalation for advice**: tool rounds run on the user's (cheap) model; once a turn that asks
  for recommendations has facts, the remaining rounds run on the "smart" curated model
  (DeepSeek), unless the user's own choice already ranks at least as high. The footer shows the
  model that wrote the answer. Roughly ×3 on the final call, nothing on plain lookups.
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

## Game profiles (library enrichment)

Stores know a game's storefront tags and blurb but not **how long it takes to finish**, its
**mood**, whether it has **co-op**, or what it is about in two honest sentences. A profile is
that card, written by the model: `lengthHours` / `endless`, `genres` (35 slugs), `moods`
(17), `themes` (English keys used for matching) + `themesLocal` (the same themes in the UI
language), `modes` (single / coop_local / coop_online / pvp / mmo), `coopPlayers`, `summary`
(2–3 sentences in the UI language), `known` (the model says so when it does not recognise
the game). Stored in `%APPDATA%/steam-egs-launcher/enrichment.json` keyed by
`normalizeTitle(title)`.

Where it is used: the "AI · ≈ 11 h · Action, Horror" line and the "In short" card on the game
page; the filter chips (Short / Co-op / Story / Cozy / Horror / Competitive) behind the
"Filters" toggle in the library (list and grid) and the random reel; "Hours by genre" in
Statistics; the assistant's tools (tag filters, `game_profile`, similar games for the
verdict).

The run starts only from the button, after a warning with an estimate (titles, requests,
tokens, cost at live model prices, minutes). It is incremental: only games without a profile
are queued. Batches of 15, three requests in flight, `max_tokens` 4,500, a 240 s timeout per
batch (90 s was not enough — the answer is long). Every batch is saved as it finishes; "Stop"
aborts the in-flight requests. Only titles are sent; the answer is validated against the
vocabularies and the title must belong to the batch. Profiles remember the run language
(`lang`): after a UI language switch, Settings shows how many profiles are in another
language and offers to rewrite them with the same estimate. Measured: 15 games — 2,700
tokens, 64 s, 13 of 15 recognised.

## Practices applied here (and worth keeping)

1. **Structured output instead of prose.** JSON mode + a strict schema + normalisation:
   numbers clamped to ranges, strings trimmed, unknown slugs dropped. Broken JSON degrades
   to a plain-text answer, not to an error.
2. **The model is not the source of truth.** It picks from what the tools showed it, and
   every named title is checked against the real library or store before it becomes a card.
3. **Be explicit about what leaves the machine.** The user chooses the level of detail
   (currently game facts without account identity); the text in Settings and on the empty
   chat says exactly what is sent. Quick actions only fill the input — no click spends tokens
   without an explicit send.
4. **Budget by construction.** Round and call limits, trimmed tool results and history,
   `max_tokens` per task, a verdict cache, a token counter in every answer footer.
5. **The key stays in the main process**, stored via `safeStorage`; everything arriving over
   IPC is validated (key shape, model id, chat history length and shape, appid).
6. **Provider resilience.** Retry on the chosen model, then fallback models; auth and balance
   errors are not retried; long generations get a longer timeout and an `AbortSignal` for
   cancellation.
7. **Understandable errors.** `AI_NO_KEY / AI_AUTH / AI_BALANCE / AI_RATE / AI_HTTP_*` map to
   messages with an action.
8. **Transparency.** The progress indicator names the tools currently running; the answer
   footer shows the model, tokens and tools used; "All results" reveals the raw findings.
9. **UI language = answer language**; internal values (slugs, criteria) stay English.
10. **Expensive things once, and on demand.** Enrichment and verdicts are started by the user,
    with the cost on the button or in the warning; the result lives locally and serves several
    screens.
11. **Next.** A set of 20–30 real phrases with the expected tool calls, to re-run when the
    model or prompt changes; a "clarify" step for ambiguous requests; region and price limits
    in purchase advice.
