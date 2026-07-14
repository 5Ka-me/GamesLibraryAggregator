# GL Aggregator — web app

React (CRA, TypeScript) browser version of the library: sync Steam/EGS, search and filter the
merged collection, open store pages. Multi-user via private workspace tokens (stored in
`localStorage`, sent as `X-Workspace-Token`).

Shared code (API client, game cards/list, i18n, theming) comes from the
[`@app/shared`](../packages/shared) workspace package — the desktop launcher reuses the same
components.

See the [root README](../README.md) for the full picture.

## Develop

From the **repo root** (npm workspaces):

```bash
npm install
npm run dev:web                      # builds @app/shared, then CRA dev server on :3000
```

The backend must be running (default `http://localhost:5080`); override with
`REACT_APP_API_URL=<url> npm start` from this folder.

## Build

```bash
npm run build:web                    # from the repo root → build/
```

## Docker

The image is built from the **repo root context** (the app consumes the `@app/shared` workspace
package), see `docker-compose.yml`:

```yaml
build:
  context: ..
  dockerfile: steam-egs-aggregator/Dockerfile
```

The bundle is served by nginx; `REACT_APP_API_URL` is baked in at build time.
