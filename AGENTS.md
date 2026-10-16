# AGENTS.md

## Cursor Cloud specific instructions

This repo is a **backend-only** real-time game server (`phantom-game-server`): Express 5 + Socket.io,
with MongoDB for persistence and optional Solana on-chain payments. There is **no frontend in this
repo** — the game client is hosted separately. Core functionality (auth + live game) is exercised
through the HTTP API and Socket.io events.

### Services
- **MongoDB** — required. A local server is installed in the VM snapshot. Start it before running the
  app: `mongod --dbpath /data/db --bind_ip 127.0.0.1 --port 27017` (run it in its own tmux session;
  it is not auto-started).
- **Game server** — `node server.js`, listens on `PORT` (default `5000`). Entry point / scripts are
  in `package.json`.

### Running for development (important caveats)
- The committed `.env` points `MONGO_URI` at a **production MongoDB Atlas cluster** and uses real
  Solana mainnet RPC. For local dev, do **not** use it as-is — override env vars to use the local
  Mongo and simulated money.
- `dotenv` does **not** override variables that already exist in the shell environment, so you can
  override `.env` values by exporting/prefixing them inline. Run the dev server like:
  ```
  DEV_FREE_PLAY=true MONGO_URI=mongodb://127.0.0.1:27017/agario_dev PORT=5000 node server.js
  ```
- `DEV_FREE_PLAY=true` makes join/cashout/reset use simulated money (no real Solana), so house/BR
  wallets are optional. Without it the server still starts but money flows require real Solana wallets.
- Optional dev env vars: `DEV_ROOM_DURATION_MS` (shorten arena rounds), `DEV_RESET_SECRET` (enables
  `npm run reset` / `npm run reset:status` against `/api/dev/*`).

### Lint / Test / Build
- There is **no lint, no build, and no real test suite**. `npm test` is a placeholder that exits 1.
  Only `npm start` (and the dev/wallet helper scripts) are meaningful.

### Quick smoke test (hello-world)
With Mongo + server running in `DEV_FREE_PLAY` mode:
1. `POST /api/register` then `POST /api/login` to get a JWT.
2. Connect a Socket.io client and emit `joinGame` with `{ token, username, mode: 'agar', entryFeeUsd: 0 }`;
   the server replies with a `welcome` event and broadcasts `leaderboard`/state.
