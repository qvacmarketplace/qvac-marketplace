# QVAC Marketplace

> **Decentralized peer-to-peer AI inference, paid in SOL.**
> Run open-source LLMs on a stranger's machine — encrypted end-to-end, no API key, no logs, no middleman. Settlement is enforced by a Solana smart contract: you pay only when the provider delivers.

**Live:** [www.qvacmarketplace.io](https://www.qvacmarketplace.io) &nbsp;·&nbsp; **Network:** Solana devnet &nbsp;·&nbsp; **License:** MIT

**Program ID:** [`6rbgdrQdxziVC25kt1Xmtz36ApiLdUVGpdyDcssmgoec`](https://explorer.solana.com/address/6rbgdrQdxziVC25kt1Xmtz36ApiLdUVGpdyDcssmgoec?cluster=devnet)

---

## Why QVAC?

- **No accounts, no API keys.** Pay per request directly from your wallet.
- **Truly private.** Prompts and responses travel peer-to-peer over Holepunch HyperDHT with end-to-end encryption — neither the marketplace nor Solana ever see content.
- **Trustless settlement.** Funds sit in an on-chain escrow until the provider commits a verifiable response hash. Mismatched delivery → consumer can refund.
- **Open marketplace.** Anyone with a GPU can register a provider, set their own price, and earn SOL by serving open-source models (Qwen, Llama, Mistral, …).

---

## How it works

```
                       ┌────────────────────────┐
                       │   Browser  (UI)        │
                       │   qvacmarketplace.io   │
                       └───┬────────────────┬───┘
                           │                │
            (1) GET /api/  │                │  ws://127.0.0.1:3000
            providers      │                │
                           ▼                ▼
                  ┌────────────────┐    ┌────────────────────┐
                  │  QVAC Webserver│    │  QVAC Bridge       │
                  │  (hosted)      │    │  (runs locally)    │
                  └────────┬───────┘    └─┬──────────────┬───┘
                           │              │              │
            getProgramAcc. │   create_job │              │ Hyperswarm
            (provider list)│   confirm_job│              │ (encrypted P2P)
                           ▼              ▼              ▼
                      ┌────────────────────────┐    ┌────────────────────┐
                      │     Solana devnet      │    │  QVAC Provider     │
                      │  ─────────────────     │    │  (any machine)     │
                      │  registry  +  escrow   │    │  LLM inference     │
                      │  Program 6rbgdrQd…     │◄───┤  provider_complete │
                      └────────────────────────┘    └────────────────────┘
```

### Job lifecycle

| # | Phase | What happens | Who signs |
|---|-------|--------------|-----------|
| ① | **Quote**          | Browser asks the provider's quote channel for a price                   | —                       |
| ② | **Create Job**     | Bridge builds tx, consumer signs in Phantom, escrow opens on-chain      | **Consumer** (Phantom)  |
| ③ | **Inference**      | Tokens stream P2P over Hyperswarm, end-to-end encrypted                 | —                       |
| ④ | **Provider Done**  | Provider commits SHA-256 of the response on-chain                       | **Provider** (auto)     |
| ⑤ | **Confirm**        | Consumer signs again to release escrow → SOL lands in provider wallet   | **Consumer** (Phantom)  |

### How payment works

Each inference costs the provider's quoted price — paid in SOL through an on-chain escrow so neither party has to trust the other:

1. **Lock** — at `create_job`, the quoted price moves from the consumer's wallet into a Job account on Solana. The provider cannot touch it yet.
2. **Earn** — after streaming the response, the provider commits a hash of the output on-chain in `provider_complete`.
3. **Release** — Phantom prompts the consumer once more. `consumer_confirm` moves the locked SOL from the Job account directly to the provider's wallet, and closes the Job account (rent returns to the consumer).

The two Phantom prompts are **not two separate charges** — it's the same SOL flowing in two steps (wallet → escrow → provider). Total per request = provider's quoted price + two small Solana network fees.

If the provider never delivers, the consumer can call `refund_job` after the timeout (`JOB_TIMEOUT`, 600s) and reclaim the escrowed funds.

---

## Repository structure

```
qvac-marketplace/
├── programs/        Anchor smart contract — 7 instructions      (Rust)
├── clients/         Codama-generated TypeScript SDK             (TS)
├── tests/           Integration tests — 39 passing              (TS)
├── qvac-bridge/     Local WebSocket bridge for the consumer     (Node)
└── qvac-provider/   Inference node — register, serve, earn      (Node)
```

Each component has its own README with setup and operational details.

---

## Quickstart

### As a consumer (use the marketplace)

1. Install [Phantom](https://phantom.app) and switch it to **devnet** (Settings → Developer Settings → Testnet Mode → Devnet).
2. Open [www.qvacmarketplace.io](https://www.qvacmarketplace.io).
3. Run the bridge on your machine — see [qvac-bridge/README.md](qvac-bridge/README.md).
4. Click **Connect Phantom**, pick a **LIVE** provider from the sidebar, and start chatting.
5. Phantom asks you to sign two transactions per inference — see [How payment works](#how-payment-works).

### As a provider (earn SOL)

1. Clone this repo, cd into `qvac-provider/`, and follow [qvac-provider/README.md](qvac-provider/README.md).
2. Generate a keypair, fund it on devnet, set a stable DHT seed.
3. `npm start` — the node auto-registers on Solana and appears in the marketplace within ~30 seconds.
4. You earn SOL for every inference request you serve. No KYC, no platform cut.

---

## Architecture notes

- **Privacy.** Inference traffic runs over Holepunch HyperDHT with Noise protocol encryption. The webserver and Solana only see public keys and 32-byte hashes — never message content.
- **Trust model.** The provider commits a SHA-256 response hash on-chain in `provider_complete` before the consumer releases escrow. Mismatched delivery is detectable off-chain; in MVP the consumer's recourse is `refund_job` (only available before `provider_complete`). A formal dispute path is reserved for V2.
- **Bridge.** Listens on `127.0.0.1:3000` only, with an explicit Origin allow-list — no other website (and no machine on your LAN) can talk to it. Your private key stays in Phantom.
- **Phantom.** Two approvals per inference — both transactions are built locally by the bridge and signed in-wallet. The bridge never holds your private key.

---

## Development

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 22.17 (QVAC SDK fails silently on older versions) |
| Rust + Anchor | 0.30.1 |
| Solana CLI | latest |
| pnpm | latest |

### Run all components locally

```bash
git clone https://github.com/qvacmarketplace/qvac-marketplace
cd qvac-marketplace
pnpm install

# Terminal 1 — provider node
cd qvac-provider && npm start

# Terminal 2 — local bridge
cd qvac-bridge && npm start
```

### Run the test suite

```bash
anchor test
```

Runs 39 integration tests against a local validator. Full settlement loop is verified end-to-end on every run.

### Regenerate the TypeScript client

```bash
anchor build      # writes target/idl/qvac_marketplace.json
npx codama        # writes clients/js/src/generated/
```

---

## Program instructions

| Instruction          | Description |
|----------------------|-------------|
| `register_provider`  | Create a Provider PDA (one per authority wallet) |
| `update_provider`    | Update a provider's name and supported task types |
| `rotate_peer_id`     | Update the on-chain DHT peer ID after a seed rotation |
| `create_job`         | Verify the provider's signed quote and escrow SOL |
| `provider_complete`  | Provider commits the response hash; transitions Job → ProviderDone |
| `consumer_confirm`   | Release escrow to the provider; close the Job |
| `refund_job`         | Reclaim escrow if the provider never delivered (after timeout) |

Full details and on-chain account layouts in [programs/README.md](programs/README.md).

---

## FAQ

**Is the inference itself trustless?**
No — the consumer trusts the provider to actually run the model and stream the right tokens. The on-chain part is the *payment* mechanism: funds are locked in escrow until the provider commits a response hash. A bad provider can earn the fee without serving real content (consumer's recourse in MVP is to not select that provider again — reputation lives on-chain via `jobs_completed`).

**Why two transactions per request instead of one?**
Because the consumer can't sign at the moment inference completes — they're in the browser, not running a server. The escrow pattern lets the consumer pre-authorize spending up to `amount`, the provider proves delivery on-chain, and the consumer releases.

**Why Holepunch and not WebRTC or libp2p?**
Holepunch HyperDHT punches NAT cleanly, gives free Noise-based encryption, and the QVAC SDK already uses it for inference streaming. Reusing the same transport for the quote channel keeps the design coherent.

**Why devnet only?**
This is an MVP / hackathon submission. The Anchor program has been audited internally but not externally; mainnet deployment will follow a formal review.

**Can I run a provider on a Mac / consumer GPU / CPU only?**
Yes — the default model (Qwen3-600M) fits in ~1 GB RAM and runs on CPU. Bigger models (Llama 8B, Mistral 7B) need ~6–8 GB RAM and benefit from a GPU but aren't required.

**What happens if the provider goes offline mid-job?**
Bridge will surface an error to the consumer. The Job stays in `Pending` on-chain; after `JOB_TIMEOUT` (600s) the consumer can call `refund_job` to reclaim the escrow.

**Is the marketplace available on mobile?**
Not yet — the bridge process needs to run locally on your machine, which isn't feasible on mobile browsers today. A native mobile app with built-in wallet integration is planned for a future version.

---

## License

MIT — see [LICENSE](LICENSE) (or the SPDX header in each file).
