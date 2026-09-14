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
  switches to the next model on the list; the answer footer shows which model replied.
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

### Tools and what they return

What the model gets is the user's decision (2026-09-14): **games with their facts** — title,
stores, install state, hours played (to 0.1 h), last-played date, hours in the last two
weeks, achievement progress, the AI profile, wishlist and store data. Nothing that identifies
the account leaves the machine: Steam ID, names, e-mail, keys. This is not a compliance
matter (the user's data goes to the provider under their own key, like any request) but a
deliberate balance between useful advice and the amount of personal data at a third party.

| Tool | Arguments | Returns |
|---|---|---|
| `library_find` | store, installed, `played` buckets (never / <1h / 1-10h / 10-50h / 50h+), `achievements` (none / started / half / almost / perfect), `lastPlayed` (2 weeks / 90 days / >180 days / never), `titleContains`, `titles` (exact titles for follow-ups), `tags` from the profile vocabularies (genres, moods, modes, themes, length), sort, limit ≤ 40 | games with hours, last-played date, last-2-weeks hours, achievements `unlocked/total (%)`, install flag and the AI profile |
| `random_pick` | the same filters | a few random games from the pool |
| `game_profile` | title | one game's profile plus the same facts |
| `store_search` | query by **name**, `onSaleOnly` | Steam games with price, discount, owned flag; DLC and soundtracks filtered out by `GetItems.type` |
| `store_game_info` | title or appid | price, discount, release, genres, tags, Metacritic, reviews all-time and **last 30 days (a sample of up to 100)**, current players, review snippets, **similar owned games** with hours played |
| `wishlist` | `onSaleOnly` | the Steam wishlist with prices and discounts |
| `achievements` | title | progress and the remaining achievements of one game, **easiest first** (by global unlock rate) |

There is no statistics tool: the Statistics page shows the same numbers without a model.
Tags are matched against the local profiles offline — zero tokens; the model is told how
many games have no profile and therefore could not match a tag filter.

### Assistant prompt (system)

Full text: `SYSTEM` in `assistant.ts`. Techniques:

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
