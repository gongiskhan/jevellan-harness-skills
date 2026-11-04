# cred-panel

A small integrations panel. `server.mjs` is a Node HTTP server with a JSON API over a file store
(`lib/store.mjs`, one row per integration: label, enabled, settings, credential) and serves two pages from `web/`:
`panel.html` (the integrations, one panel each) and `accounts.html` (the inbox accounts and the integration each one
reads through).

## Commands

- `npm test`: every test (`node --test`, which runs every `*.test.mjs`).
- `npm run dev`: the server on `PORT` (default 3000). The pages are `/panel.html` and `/accounts.html`. The store
  lives in `data/` (ignored by git); `CONFIG_STORE` points it elsewhere.

## Rules

- UI copy is European Portuguese (pt-PT). Never use the em dash anywhere.
- A credential never reaches the browser in full: the API masks it (`lib/mask.mjs`).
- Check every screen you change at 390 and 1440 pixels wide.
- Tests live in `tests/`, one file per area, with `node:test`. No new dependencies without a reason.
- Every change reaches `main` as a pull request that the owner reviews.
