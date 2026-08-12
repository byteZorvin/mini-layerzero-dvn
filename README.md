# Mini LayerZero DVN

A deliberately small, **testnet-only** LayerZero V2 DVN for the ArcX Ethereum Sepolia ↔ Starknet Sepolia OFT route.

The relay executes as bounded Vercel Hobby functions in Mumbai. A Cloudflare Worker cron invokes it at the start of every minute and again 15 seconds later. Upstash Redis stores cursors, job phases, transaction hashes, health, and the single-writer lease.

This is not a production DVN. Its owner keys can approve arbitrary packets and also control other ArcX testnet contracts. Do not use this design or these keys on mainnet.

Live testnet deployment:

- Vercel: `https://mini-layerzero-dvn.vercel.app`
- Public health: `https://mini-layerzero-dvn.vercel.app/api/health`
- Cloudflare Worker: `mini-layerzero-dvn-scheduler`
- Schedule: `* * * * *`, with relay calls at `+0s` and `+15s`
- Durable state: Upstash Redis Free in Mumbai

## Architecture

```text
Cloudflare cron (* * * * *)
  ├─ POST Vercel /api/relay at +0s
  └─ POST Vercel /api/relay at +15s
       ├─ atomic Upstash lease
       ├─ Ethereum → Starknet relay pass
       ├─ Starknet → Ethereum relay pass
       └─ durable cursors, phases, tx hashes, and health
```

The phase machine is:

```text
discovered → verify_submitted → verified → commit_submitted
           → committed → execute_submitted → executed
```

`failed` records which action is retryable. A transaction hash is stored immediately after the RPC accepts a broadcast. The next invocation checks the destination Endpoint and the receipt before doing more work. Endpoint payload state is the source of truth when the official LayerZero Executor wins a race.

## Current Sepolia route

| Item | Ethereum Sepolia | Starknet Sepolia |
|---|---|---|
| Chain ID | `11155111` | `SN_SEPOLIA` |
| LayerZero EID | `40161` | `40500` |
| Confirmations | `1` | `15` |
| OApp | `0x9A4C4D10d548D44e12aA847636700F6f4bF16E12` | `0x07e9593b9a78dff63fe86a488710be4c683a1befcd24f697475e3e0ae86e75e5` |
| Token | `0x0ae3f82B174d1837B30D530778c96a41C23FfCd5` | `0x05176ad5bd10d38ed31ed49b60280312546951017e99b78c102e6709073fc7f8` |
| Endpoint | `0x6EDCE65403992e310A62460808c4b910D972f10f` | `0x0316d70a6e0445a58c486215fac8ead48d3db985acde27efca9130da4c675878` |
| ReceiveUln | `0xdaf00f5ee2158dd58e0d3857851c432e34a3a851` | `0x0706572d6f7b938c813a20dc1b0328b83de939066e25bd0fbe14c270077f769d` |

Mini-DVN contracts:

- Ethereum source/job DVN: `0xfb9c6e7e0fe9eb8020aed5dfd3d1da7a42605299`
- Ethereum destination verifier: `0x28e505a838dfc64057e2ca1e64b1240b6930a7d8`
- Starknet source/job DVN: `0x038ad88677d883b79ff0379a04805d4318fc3f38b7973ad3f1bb55c507d54801`
- Starknet destination verifier: `0x050a2b57fa5b9de3b5d753b2f72d350aa89109e7c78c617a9183d07888eded66`

Signing accounts:

- Ethereum operator `0x37B54930D500Db3c35De7B72C68A1e7afbc9A5ae` verifies, commits, and executes Starknet → Ethereum packets.
- Starknet operator `0x011dE9C756a84A99b5765183625cD7ad8EB6A0206cE2904Dbe478A1a1e5C0cb1` verifies, commits, and executes Ethereum → Starknet packets.

Only one worker or administrator may transact from these accounts at a time. Stop the hosted scheduler before using either account in local scripts.

## Prerequisites

- Bun 1.x, Node 20+, Git, and the Vercel CLI.
- A private GitHub repository.
- Vercel Hobby project with functions in `bom1`.
- Upstash Redis Free database in AWS Mumbai (`ap-south-1`).
- Cloudflare Workers Free account.
- Production Alchemy RPC URLs for Ethereum Sepolia and Starknet Sepolia.
- Both operator accounts funded. Health warns below `0.05 ETH` or `50 STRK`.

Install and verify:

```bash
bun install --frozen-lockfile
bun run check
bun test
bun run scheduler:deploy -- --dry-run
```

Local contract commands load operator RPCs and keys from the sibling
`../arcxcore/scripts/.env.local` (falling back to `.env`). Set
`ARCXCORE_ENV_FILE` to select another existing environment file. Explicit
`MINI_DVN_*` variables always take precedence. No environment file is bundled
into Vercel.

Contract builds and tests are intentionally separate from the serverless build:

```bash
bun run build:ethereum
bun run build:starknet
bun run test:ethereum
```

After the one-time configurable-worker deployment, update `config/sepolia.json`
for a future OFT pair and run:

```bash
bun run configure
bun run configure -- --execute
```

The command verifies all four worker owners, changes only mismatched route
fields, and reads the configuration back. A contract redeployment is not
required for a future single-route cutover.

## Vercel configuration

Create the project without hot keys first:

```bash
vercel link
vercel env add MINI_DVN_ENABLED production
vercel deploy --prod
```

Set `MINI_DVN_ENABLED=false` until cutover. Add every variable in `.env.example` to **Production only**. The Vercel Upstash integration supplies `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which the service accepts in place of the two `UPSTASH_REDIS_*` names. Do not add private keys, full RPC URLs, Redis tokens, or trigger secrets to Preview.

The service exposes:

- `POST /api/relay` — `Authorization: Bearer $RELAY_TRIGGER_SECRET`; returns `completed`, `busy` (`202`), or `disabled`.
- `GET /api/health` — sanitized public state; never returns secrets or full errors.
- `GET /api/jobs?limit=25` — protected by `STATUS_SECRET`; returns recent public job/transaction state.

Disabled smoke tests:

```bash
curl -i https://YOUR_PROJECT.vercel.app/api/health
curl -i -X POST https://YOUR_PROJECT.vercel.app/api/relay
curl -i -X POST https://YOUR_PROJECT.vercel.app/api/relay \
  -H "Authorization: Bearer $RELAY_TRIGGER_SECRET"
```

The unauthenticated relay request must return `401`; the authenticated request must return `disabled` before cutover.

## Import existing local state

Stop the old continuous process and perform its final catch-up first. Then run the idempotent importer with the same RPC/operator environment and the new Redis credentials:

```bash
bun run migrate-state -- \
  --forward /absolute/path/to/state/sepolia.json \
  --reverse /absolute/path/to/state/sepolia-reverse.json
```

The importer rescans source-chain events to reconstruct immutable packets, merges the legacy phase and transaction hashes, and refuses completion if any legacy transaction cannot be reconstructed. Local JSON state is never committed.

## Cloudflare scheduler

Set both values as Worker secrets; Cloudflare never receives RPC URLs or chain keys:

```bash
bunx wrangler login
bunx wrangler secret put VERCEL_RELAY_URL --config cloudflare/wrangler.jsonc
bunx wrangler secret put RELAY_TRIGGER_SECRET --config cloudflare/wrangler.jsonc
bun run scheduler:deploy
```

`VERCEL_RELAY_URL` is the full production URL ending in `/api/relay`. The secret must exactly match Vercel. The Worker runs `* * * * *`, calls Vercel immediately, waits 15 seconds with the Cloudflare Scheduler API, and calls again. It retries one transient network/5xx failure. `202 busy` is a healthy result.

Do not configure Vercel Cron: Hobby does not provide minutely native scheduling.

## Cutover checklist

1. Deploy Vercel with `MINI_DVN_ENABLED=false` and Production-only secrets.
2. Confirm `/api/health`, auth rejection, Redis, RPCs, addresses, code, and funding with `bun run status`.
3. Stop the local worker and do not use the operator accounts elsewhere.
4. Import both JSON state files and inspect protected `/api/jobs`.
5. Run one authenticated hosted pass manually while still disabled to confirm the safe response.
6. Deploy the Cloudflare Worker and minutely cron while Vercel is still disabled.
7. Set `MINI_DVN_ENABLED=true` in Vercel Production and redeploy.
8. Run one authenticated pass and verify receipts/state, then confirm the scheduler refreshes health at both `+0s` and `+15s`.
9. Send one transfer in each direction. Confirm destination balance, LayerZero delivery/OFT events, and an `executed` or reconciled job.
10. Observe health, cursor lag, Redis command count, errors, and balances for at least 60 minutes.

## Recovery and rollback

- Disable/delete the Cloudflare cron first, then set `MINI_DVN_ENABLED=false` in Vercel.
- Keep Redis intact. Export protected job state before any manual repair.
- If Redis is lost, reset the two cursors to the deployment blocks and rescan source events; destination Endpoint reconciliation prevents redelivery.
- To return to the local worker, export/import the latest Redis state and ensure the hosted lease/scheduler is disabled before starting it.
- A persistent nonce error usually means another process is using the same broad operator account; disable both writers and reconcile submitted hashes before resuming.

Vercel Hobby, Cloudflare Free, Upstash Free, and this Mini-DVN provide no production SLA or production trust model. They are suitable only for ArcX testnet testing.
