# Bundled binaries

This folder holds native binaries bundled with the launcher. They are **not**
committed to git (see the repo `.gitignore`).

- `legendary.exe` — the EGS download CLI (https://github.com/derrod/legendary).
  Fetch it with:

  ```bash
  npm run fetch:legendary
  ```

At package time, everything in `resources/bin` is copied into the app's
`resources/bin` via electron-builder `extraResources`.
