# AI assistant eval

A headless harness that sends scripted chat turns through the real assistant (`assistantChat`) and checks
the replies. It uses your real key, library, AI profiles, fact cards and semantic index. It checks
**properties** instead of exact titles: every game card carries a tag, every card is owned or none is, a
tool was used, the answer is in the right language, owned games are short enough. Model output changes
from run to run, and a check that names exact games would fail good answers. A property check also works
on any library. The one exception is `requireAnyOf`: for a genre or mechanic that no Steam tag expresses
(anomaly hunting, gacha), it asks for any one game from a long list of well-known examples. Every answer
is also checked for talk about the app's internals (tags, tools, filters, the index).

Code: `src/main/services/aiEval.ts`. Cases: `eval/ai-cases.json`. Hook: the `--ai-eval` flag in
`src/main/index.ts`.

## Before you run it

- **Close the dev app first.** The eval runs as `electron .` and uses the same userData folder as
  `npm run dev` (`%APPDATA%\steam-egs-launcher` on Windows), not the installed app's folder. If both run
  at once, they write the same files (cache, usage counter, embeddings) at the same time.
- The dev app must already have a chutes.ai key (Settings → AI) and a synced library. Without a key the
  eval stops before the first case.
- Some cases need more setup:
  - Steam signed in: wishlist, inventory and achievements cases.
  - AI profiles: mode and length checks (`haveModeAny`, `maxLengthHours`).
  - The semantic index: "like X" and mood cases. They still run without it, through the fallbacks.

## Running

From `steam-egs-launcher/`:

```sh
npm run ai:eval                                              # build, then run every case
npm run ai:eval -- --ai-eval-only=vr-library-en,short-5h-ru  # only these ids
npm run ai:eval -- --ai-eval-cases=eval/my-cases.json        # another cases file
```

`npm run ai:eval` always rebuilds first (`electron-vite build`). If `out/` is already current,
`npx electron . --ai-eval` skips the build. Set `LAUNCHER_AI_DEBUG=1` to print every tool call and model
round as well.

Cases run one after another. For each case the eval prints a progress line, then:

- a summary table: id, pass/FAIL/ERROR, latency, tokens in/out, tools used
- every failure reason, e.g. `vr-library-en: game 'Portal 2' lacks tags [VR] (has: Puzzle, Co-op, …)`
- totals: passed and failed counts, tokens, estimated cost, and the `expectAnyOf` hit rate

Exit code: `0` all passed, `1` at least one case failed, `2` the harness could not run (bad cases file,
unknown id, no key).

The report goes to `<userData>/ai-eval/report-<ISO time>.json`, with a Markdown table of the same run
next to it (`.md`). For each case it records:

- pass/fail and every failed check
- notes: checks that could not be verified, and corrected context origins
- latency, tokens, estimated USD, model and tools used
- the answer, cut to 600 characters, and the game cards (`store: "epic"` marks an Epic Games Store card,
  which has no appid; the Markdown table appends "(Epic)" to its title)

It also stores the delta of the app's usage counter, which includes intent parsing, fallbacks and
embedding calls. The report never contains the API key or account identifiers.

If a case hits `AI_NO_KEY`, `AI_AUTH` or `AI_BALANCE`, the remaining cases are marked skipped instead of
spending more requests. A case that throws, or gets no reply within 6 minutes, counts as a failure. A turn
cannot be aborted, so after a timeout the eval waits up to 5 more minutes for it to finish before the next
case starts (a late reply's tokens are counted in that case; the wait is noted).

A failed chat-path embedding call (429, 5xx, timeout) opens the embedding breaker for 60 s: the cases in
that window rank by tags and word overlap instead of meaning. A score drop during a busy spell may come
from that rather than from the change under test; rerun the affected cases with `--ai-eval-only`.

## Cost

Each case is one real, paid assistant turn on your key. That means an intent call, a fit check (unless the
request is hard constraints only, such as "VR games"; about 20% more tokens) and the explanation, or up to three
tool rounds plus the answer, and sometimes both when the pipeline falls back. Advice turns can escalate
to the "smart" model. A full run of about 35 cases usually costs a few hundred thousand tokens, plus a
fraction of a cent for embeddings. The summary prints the exact token count and an
estimate from chutes' live price list. The estimate covers chat tokens only, each priced at the model that
spent it when the assistant reports a per-model split; otherwise all of a turn's tokens are priced at its
last model, and the report says how many cases that affects. Embedding tokens appear only in the usage
counter delta. Use `--ai-eval-only` while working on a single behaviour.

## Case format

`ai-cases.json` is an array (a `{ "cases": [...] }` object also works). Each case looks like this:

```jsonc
{
  "id": "followup-more-store-en",          // unique; suffix -en / -ru by convention
  "history": [                             // optional earlier turns
    { "role": "user", "content": "Recommend some roguelikes from the Steam store" },
    { "role": "assistant", "content": "…", "games": ["Dead Cells", "Hades"] }  // games = cards shown
  ],
  "message": "More",                       // the turn under test
  "lang": "en",                            // optional UI language; default: "ru" if the message has Cyrillic
  "context": [                             // optional attached games (the picker)
    { "title": "Hollow Knight", "origin": "store" }   // origin: library | wishlist | store
  ],
  "expect": { "noRepeat": true, "owned": false, "haveTagAny": ["Roguelike"] }
}
```

The eval corrects the `origin` of a context game to `library` when the title is in your library, and back
to `store` when a `library` title is not, so a case reads truthfully on any library. Each correction is
listed in the case's notes.

### Expectation keys

All keys are optional, and every check applies to the game cards of the reply. Keys that are missing or
misspelled, and values of the wrong type, make the case fail without running.

| key | passes when |
|---|---|
| `answerLang` | `"en"` / `"ru"`: the answer reads in that language. Bold spans (titles) are ignored; Russian means at least 30% of the letters are Cyrillic. |
| `toolsInclude` | every entry appears in `toolsUsed`. `"a\|b"` accepts either tool, e.g. `"store_discover\|store_browse"`. |
| `toolsExclude` | none of these tools was used. |
| `minGames` / `maxGames` | the number of game cards is within the bounds (`maxGames: 0` = no cards). |
| `owned` | `true`: every card is owned. `false`: no card is owned. |
| `haveTagAny` | every game carries at least one of these tags (see tag sources and equivalence below). A game whose tags are unknown fails. |
| `lackTags` | no game carries any of these tags. A game whose tags are unknown is noted, not failed. |
| `haveModeAny` | every **owned** game's AI-profile `modes` include one of these (`single`, `coop_local`, `coop_online`, `pvp`, `mmo`). Store games are skipped. An owned game without a profile fails. |
| `maxLengthHours` | every **owned** game's profile `lengthHours` is at most n and the game is not endless. An unknown length fails. |
| `maxPrice` | every non-owned game costs at most n **US dollars**. Steam prices in the account's regional currency, so the price is converted at the daily rate. Free games pass; an unknown price fails; a price whose currency has no known rate is noted, not failed. A reply whose store games are all free gets a note (a cap read as 10 local units looks like that). |
| `answerMatches` / `answerNotMatches` | the regex (case-insensitive) matches / does not match the answer text plus all game notes. |
| `noRepeat` | no card repeats a title from the `games` of the history turns. |
| `excludeTitles` | no card has one of these titles (normalized comparison). |
| `requireAnyOf` | at least one card is one of these titles: the same normalized title, or a card title that starts with the entry as whole words (`I'm on Observation Duty 5` matches `I'm on Observation Duty`; `Exit 80` does not match `Exit 8`). A leading label in brackets and an alternate-language ` \| …` tail of a Steam title (`[Chilla's Art] Shinkansen 0 \| …`) are ignored. An empty list is a case-definition error. |
| `maxLatencyMs` | the turn finished within n ms. |
| `expectAnyOf` | **not pass/fail**: records the share of cards found in this list. Use it only with very well-known games. |

`requireAnyOf` is for concepts that tags cannot check. List many well-known games of the concept, from
both stores and the user's possible library, so that any good answer contains one of them; the check
then catches answers that offer loosely related games instead (detective games for "anomaly hunting",
open-world RPGs for "games like Genshin Impact").

Every case also fails, whatever its `expect`, when:

- the answer is empty;
- the reply shows game cards but used no tool at all (the games came from the model's memory), unless
  they are the attached context games;
- the answer describes the app's internals instead of games: Steam tags (a tag that "does not exist",
  "Steam has no X tag", "nothing was found by the tag X"), literal matching ("searched literally"), tool names and calls (`library_find`, "in one call",
  `limit: 40`), the index, filters ("passed the tag filter"). Only the answer text is read, with bold
  spans and the card titles taken out, and every pattern needs a machinery context word, so a game
  called "Filter", "literally addictive" or "upgrade your tools" do not count. The patterns (English and
  Russian) are `LEAKS` in `aiEval.ts`; the failure quotes the phrase that matched.

### Tag sources and equivalence

- **Owned games:** the library view's store tags (Steam user tags and platform flags for Steam copies;
  EGS genres and features for Epic-only games), plus the game's fact card (Steam tags of the own copy or
  of the Steam twin, and Steam categories such as "Online Co-op" and "VR Only").
- **Store and wishlist games:** the Steam store metadata (`itemsMeta`, English tag names), looked up by the
  card's appid.

Tags are compared case-insensitively. A few umbrella names are widened, because Steam tags, Steam
categories and EGS spell them differently:

| wanted | also accepts |
|---|---|
| `VR` | `VR Only`, `VR Supported` |
| `Co-op` (or `Coop`) | any tag containing "co-op" or "coop" (`Online Co-Op`, `Local Co-Op`, `LAN Co-op`, …) |
| `Horror` | any tag containing "horror" (`Psychological Horror`, `Survival Horror`, …) |
| `Roguelike` | any tag containing "rogue" (`Roguelite`, `Action Roguelike`, EGS `Rogue-Lite`, …) |

Every other name needs an exact match, so `"VR Only"` on its own is strict. The table lives in
`TAG_FAMILIES` in `aiEval.ts`. Extend it there if a new umbrella name is needed.

## Adding cases

1. Write the message the way a user would type it. Russian (or any other language) is fine inside the
   JSON data: it is test input. Keep the id, file names and everything else in English.
2. Check properties, not titles. Do not name games from your own library in a case: the file is in the
   repo and has to work on anyone's library. For attached games and follow-up history, use well-known
   store games. When no tag can express the request, use `requireAnyOf` with a long list of well-known
   examples rather than a short list of the answers you expect. An `excludeTitles` list that guards
   against a reproduced bug may name the wrong games it showed; list every store spelling of each
   (editions, "Chernobyl" / "Chornobyl"), because the comparison is exact.
3. Pick the smallest set of keys that would catch the bug you care about. Overly tight expectations, such
   as a `maxGames` on an open question, make the eval flaky.
4. Run the new case alone with `--ai-eval-only=<id>` a few times before you commit it.
