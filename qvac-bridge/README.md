# QVAC Bridge

Local WebSocket bridge that connects your browser to the QVAC P2P network. The browser can't talk to the Solana RPC directly with your Phantom-held key, can't open Hyperswarm sockets, and definitely shouldn't host your private keypair — so the bridge does all three on your machine, then exposes a tightly-scoped local WebSocket the marketplace UI uses.

```
       Browser (qvacmarketplace.io)
                │
                │  WebSocket  ws://127.0.0.1:3000
                ▼
       ┌──────────────────┐        Solana devnet
       │   QVAC Bridge    │──────────────────────────►  create_job, consumer_confirm, refund_job
       │  (this process)  │
       │                  │        Holepunch HyperDHT
       └──────────────────┘──────────────────────────►  Quote channel + encrypted inference stream
```

---

## Quick start

```bash
git clone https://github.com/qvacmarketplace/qvac-marketplace
cd qvac-marketplace/qvac-bridge
npm install
cp .env.example .env          # edit if you want demo mode (see below)
npm start
```

Then open [www.qvacmarketplace.io](https://www.qvacmarketplace.io) — the bridge pill in the top-right turns green within a second.

---

## Requirements

- **Node.js ≥ 22.17** — the QVAC SDK fails silently on older versions. Check with `node --version`.
- **A Solana devnet wallet with SOL.** Two ways to provide it:
  - **Phantom** *(recommended)* — sign in-browser, key stays in the extension.
  - **Demo mode** — bridge auto-signs using a local `.json` keypair. Useful for testing and demos. **There is a 0.1 SOL per-job cap in demo mode** to limit blast radius if a malicious provider quotes wildly.

---

## Setup

### 1. Install

```bash
git clone https://github.com/qvacmarketplace/qvac-marketplace
cd qvac-marketplace/qvac-bridge
npm install
```

> **Mac / npm users:** if you see an `ERESOLVE` peer dependency error on install, run:
> ```bash
> npm install --legacy-peer-deps
> ```
> This is a known conflict between `bare-fetch` versions in `@qvac/sdk` and is safe to bypass.

### 2. Configure

```bash
cp .env.example .env
```

```env
# Solana RPC endpoint
SOLANA_RPC=https://api.devnet.solana.com

# Demo mode only — leave commented out if you'll use Phantom
# SOLANA_KEYPAIR_PATH=/home/you/.config/solana/consumer.json
```

For demo mode, generate and fund the keypair:

```bash
solana-keygen new -o ~/.config/solana/consumer.json
solana airdrop 2 ~/.config/solana/consumer.json --url devnet
```

### 3. Start

```bash
npm start
```

You should see something like:

```
  QVAC Bridge v1.0
  ─────────────────────────────────
  WebSocket : ws://127.0.0.1:3000
  Security  : localhost only
  Consumer wallet: 6TCKACK…   ← only if SOLANA_KEYPAIR_PATH is set
  Waiting for browser connection...
```

### 4. Open the marketplace

Go to [www.qvacmarketplace.io](https://www.qvacmarketplace.io). The bridge pill in the top-right turns green when the WebSocket handshake completes.

---

## Phantom signing flow

```
  Browser                      Bridge                       Solana
   │                            │                            │
   │ ── prompt ─────────────────▶                            │
   │                            │ ── quote_request ──▶ Provider
   │                            │ ◀── signed quote ──         │
   │                            │                            │
   │ ◀── sign_request {tx} ─────                            │
   │   ↓                        │                            │
   │   Phantom popup            │                            │
   │   "Approve in Phantom —    │                            │
   │    Escrow 0.000010 SOL"    │                            │
   │   ↓                        │                            │
   │ ── sign_response ──────────▶                            │
   │                            │ ── create_job (signed) ────▶
   │                            │                            │
   │  P2P inference (encrypted) ◀────────── tokens ─────────  Provider
   │                            │                            │
   │ ◀── sign_request {tx} ─────                            │
   │   "Release 0.000010 SOL"   │                            │
   │ ── sign_response ──────────▶                            │
   │                            │ ── consumer_confirm ──────▶
   │ ◀── settled ───────────────                            │
```

Two prompts per inference. Both transactions are built locally by the bridge — Phantom signs raw transaction bytes; it never sees a private key from the bridge.

---

## Demo mode (no Phantom)

If `SOLANA_KEYPAIR_PATH` is set in `.env`, the bridge signs and submits transactions automatically using that keypair. There is no wallet popup, no user confirmation per job. Caveat:

- A **per-job cap of 0.1 SOL** rejects quotes above that amount, so a malicious provider can't drain your wallet via an inflated quote.
- The keypair file is on disk — protect it with file permissions and keep it out of version control.

Phantom mode is recommended for everything except local automation.

---

## Security

- **Bind address.** The bridge listens on `127.0.0.1:3000` only — unreachable from your LAN, your Wi-Fi, or the internet.
- **Origin allow-list.** Only WebSocket connections from `qvacmarketplace.io` (production) or `localhost:3001` (local dev) are accepted. Other websites cannot CSRF-attack the bridge by opening a sneaky WebSocket.
- **Phantom mode.** Your private key never enters the bridge process — Phantom only emits a signed transaction.
- **Demo mode.** Keypair stays on disk in the file you specify. Bridge reads it once at startup. The 0.1 SOL per-job cap protects against malicious quotes.
- **Buffer caps.** Hyperswarm sockets reject any single line over 64 KB to defend against memory-exhaustion DoS.
- **Crypto-random IDs.** Session, transaction, and quote IDs are generated with `crypto.randomBytes` rather than `Math.random`.

---

## Operations

The bridge logs each session and transaction to stdout:

```
  [F1084ED9] browser connected
  [F1084ED9] qvacPeerId: a1b2c3d4e5f6789a…
  [F1084ED9] quote: 10000 lamports, valid until 1747000600
  [F1084ED9] job acked: J6wtAsnmESxV…
  [F1084ED9] response complete
  [F1084ED9] settled: 121uEmSfaqDTqiK6…
```

For long-running deployments, use a process manager:

```bash
npm install -g pm2
pm2 start "npm start" --name qvac-bridge
pm2 save
pm2 startup
```

---

## Troubleshooting

**Bridge pill stays red ("Bridge not detected")**
Make sure `npm start` is running. Check the terminal for an `EADDRINUSE` error — port 3000 may be taken by another process. Confirm `node --version` is ≥ 22.17.

**"Connection rejected — origin not allowed"**
You're loading the marketplace UI from a non-allowlisted origin. Use the hosted site (`qvacmarketplace.io`) or the local dev server (`localhost:3001`).

**"Quote channel connect timeout"**
The provider's DHT announcement can take up to 15 seconds to propagate on devnet. Wait until the *provider's* terminal prints `Quote channel: open`, then retry.

**"Provider quoted N lamports — exceeds demo-mode cap"**
The provider asked for more than 0.1 SOL and you're in demo mode. Switch to Phantom (which prompts you per-tx) or pick a different provider.

**"Transaction rejected in Phantom"**
You hit Cancel in the Phantom popup. Just send the message again.

**Phantom shows wrong network**
Open Phantom → Settings → Developer Settings → enable Testnet Mode and select Devnet.

**`SOL Insufficient lamports` errors mid-job**
Top up your devnet balance. Click **Airdrop 1 SOL** in the marketplace UI (Phantom mode) or run `solana airdrop 2 <keypair> --url devnet` (demo mode).
