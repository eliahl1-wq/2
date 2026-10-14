# Admin-sponsored SPL recovery

SPL tokens can be transferred from a deposit wallet with **zero SOL** when a
separate wallet signs as fee payer. The deposit key still authorizes the token
transfer. Neither the token amount nor its market value pays Solana network fees.

## Setup

To create a dedicated wallet locally, from the backend folder run
`npm run spl:fee-wallet`. It creates/reuses `.local/spl-fee-wallet.json` and prints
only the public address. Then run `npm run spl:fee-wallet -- --show-secret` in
your own terminal to display the Railway variable value. The file is Git-ignored;
back it up securely and never upload or share it. Repeated runs do not rotate the
key. The script does not fund wallets, send transactions or alter Railway.

1. Create a dedicated operational wallet. Do not use a house, reward, tournament
   wallet or any user's deposit wallet. Keep only a limited SOL amount in it.
2. In the backend service's server-side variables, set `SPL_FEE_SPONSOR_SECRET`
   to that wallet's private key. Accepted formats: base58 export, 64-byte hex,
   or a Solana CLI 64-integer JSON key array. Never put it in a `VITE_*` variable,
   commit it, send it in chat, or use your main savings wallet's private key.
3. Optionally set `SPL_FEE_SPONSOR_MAX_SOL` (default **0.25**, maximum **1**).
   This is the hard per-bulk-operation ceiling for estimated fees plus ATA rent.
4. Deploy the updated frontend and backend, then scan accounts again. The admin
   UI shows the derived public fee address and current SOL balance. Fund this
   exact address manually; no automatic top-ups or house/reward spending occur.
5. Choose **Admin fee wallet**, set **Max fees + rent (SOL)** (default 0.01),
   select tokens/destination, and approve the confirmation.

The sender needs its recoverable deposit signing key, not SOL. Creating a
destination ATA can cost more than the network fee; existing ATAs do not need
another rent deposit. Token-2022 account size uses the actual mint extensions.
Unsupported/frozen token transfers may still fail simulation independently of fees.

## Safeguards and accounting

- Admin authentication, existing confirmations, per-user operation locks and
  active-game exclusions remain in place. Sponsorship needs an additional fee
  confirmation. No source wallet's SOL is transferred to fund another account.
- Sponsor cannot be a protected house/reward/tournament address or any user's
  deposit address. There is no fallback to game/reward funds.
- Sponsored transfers run serially. One sponsored bulk operation at a time is
  allowed per backend process (current production uses one replica).
- Each transaction explicitly sets the sponsor as fee payer and ATA payer;
  both sponsor and token owner sign. Current RPC fee and exact new ATA rent are
  checked against sponsor SOL and the remaining approved budget before submission.
- Budget is conservatively reserved before submission and is not released on
  ambiguous errors. `feeBudgetReservedSol` is **not** an assertion of actual SOL
  spent. Some budget can remain reserved after a simulation/network failure.
- Successful transfer audit entries include fee payer, sponsored flag and
  transaction signatures. Existing signature/confirmation behavior is retained.
- No live transfer is part of verification. Tests build/sign real Solana message
  structures with mock RPC data, cover zero-SOL sources, two signatures,
  destination rent, malformed/protected keys, insufficient funds and budget limits.

Checks: `node --test spl-fee-sponsor.test.js`, `node --check server.js`,
and frontend `npm run build`.

## Saved scans and live refresh

The `SplScanCache` MongoDB collection stores the most recent token snapshot per
deposit address, including empty wallets, successful check time and RPC error.
It never stores signing keys. Reload/deploy does not clear it. The admin Users
tab loads these results automatically and polls cached pages every 15 seconds
while visible. Expired snapshots (60 seconds) queue a background recheck with
at most six concurrent RPC scans across all viewers. Duplicate requests share
one check. New wallets are queued too; first-time loading need not block the UI.

Fresh reads check **both** SPL Token and Token-2022 programs, so added mints,
increased/decreased amounts and emptied accounts are detected. This is periodic
refresh, not instant websocket delivery; large queues/RPC outages may take longer.
Known balances remain visible on RPC failure, marked with the error, and retries
back off for a minute. Actual transfer amounts are always read on-chain again.
Each confirmed transfer invalidates the source's saved snapshot and prevents an
older in-flight scan from republishing it. Background UI responses started before
a transfer are also discarded. Tests: `node --test spl-scan-cache.test.js`.
