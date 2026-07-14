# @app/shared

Code shared between the web app and the desktop launcher:

- `api/client.ts` — typed API client with an injectable transport (browser `fetch` on the web,
  IPC proxy in the launcher) and workspace-token handling.
- `components/` — `GameCard`, `GameList`, `Header`, Steam/Epic settings panels.
- `sources.ts` — the game-source registry (ids, labels, colors). Adding a new store (e.g. GOG)
  starts here; see the checklist in the file header.
- `libraryActions.tsx` — optional host-injected install/launch manager consumed by the shared UI.
- `i18n/`, `theme/` — EN/RU dictionaries and the light/dark theme context.
- Helpers: `normalizeTitle` (cross-store game matching, mirrors the backend), `steamAppId`,
  `epicAppName`, install-state resolvers.

Compiled to CommonJS (`dist/`) for the CRA web build; the launcher consumes the TypeScript
source directly via a Vite alias. Build with `npm run build:shared` from the repo root.
