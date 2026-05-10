# QVAC Provider

Run a QVAC inference node and earn SOL on Solana devnet. When a consumer submits a job, your node receives the request over an encrypted P2P channel, runs inference locally, and is paid automatically when the consumer confirms the result.

```
       Consumer (browser + bridge)
                │
                │  Holepunch HyperDHT  (encrypted, P2P)
                ▼
       ┌──────────────────┐         Solana devnet
       │  QVAC Provider   │──────────────────────────►  register_provider, provider_complete
       │  (this process)  │
       │                  │         QVAC SDK (llamacpp)
       └──────────────────┘──────────────────────────►  Local LLM inference
```

---

## Quick start

```bash
git clone https://github.com/qvacmarketplace/qvac-marketplace
cd qvac-marketplace/qvac-provider
npm install

# Generate a keypair, fund it on devnet, generate a stable DHT seed
solana-keygen new -o ~/.config/solana/provider.json
solana airdrop 2 ~/.config/solana/provider.json --url devnet
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Configure (see Setup below), then:
npm start
```

Within 30 seconds, your node appears in the marketplace at [www.qvacmarketplace.io](https://www.qvacmarketplace.io). When a consumer picks you and sends a prompt, you earn SOL.

---

## Requirements

| Item | Notes |
|------|-------|
| **Node.js ≥ 22.17** | QVAC SDK fails silently on older versions |
| **Solana devnet wallet** | Fund with at least **0.1 SOL** for registration + tx fees |
| **RAM** | ~1–2 GB for the default Qwen3-600M model; ~6–8 GB for larger models |
| **Disk** | ~500 MB for the default model weights |
| **Network** | Reachable from the public internet (Hyperswarm punches NAT, no port-forwarding needed) |
| **OS** | Linux / WSL / macOS / Windows. Tested on WSL2 Ubuntu 24.04 |

A consumer GPU helps with throughput but isn't required — quantized models run fine on CPU.

---

## Setup

### 1. Install

```bash
git clone https://github.com/qvacmarketplace/qvac-marketplace
cd qvac-marketplace/qvac-provider
npm install
```

### 2. Create and fund a provider wallet

```bash
solana-keygen new -o ~/.config/solana/provider.json

# Airdrop is rate-limited; rerun if it fails
solana airdrop 2 ~/.config/solana/provider.json --url devnet
solana balance ~/.config/solana/provider.json --url devnet
```

### 3. Generate a stable DHT identity

The Hyperswarm seed determines your P2P identity. **Generate it once and keep it constant** — every change submits a `rotate_peer_id` transaction on-chain (which costs a small fee).

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copy the 64-character hex string into .env below
```

### 4. Configure

```bash
cp .env.example .env
```

```env
SOLANA_RPC=https://api.devnet.solana.com
SOLANA_KEYPAIR_PATH=/home/you/.config/solana/provider.json

# 32-byte hex DHT seed — generate ONCE and keep stable
QVAC_HYPERSWARM_SEED=<paste your hex string from step 3>

# Display name shown in the marketplace UI (overrides qvac.config.json)
PROVIDER_NAME=My AI Node
```

Pricing and supported task types live in [`qvac.config.json`](qvac.config.json) — see [Configuration reference](#configuration-reference).

### 5. Start

```bash
npm start
```

**First run** registers the provider on-chain:

```
Starting QVAC provider...
QVAC peer ID: a1b2c3d4...
Registering provider on-chain...
Provider registered.
Authority:    G2VLzNG1...
Provider PDA: J6wtAsnm...
Quote channel: open

Running... Press Ctrl+C to stop
```

**Subsequent runs** reuse the existing on-chain record:

```
Starting QVAC provider...
QVAC peer ID: a1b2c3d4...
Provider already up-to-date.
Quote channel: open
```

If you change `PROVIDER_NAME`, `taskTypes`, or the DHT seed, the node detects the diff and submits exactly one of `update_provider` or `rotate_peer_id` to keep the chain in sync.

Your node is visible in the marketplace within ~30 seconds (the UI polls every 30s).

---

## How earnings work

```
1. Consumer asks your quote channel: "what's the price for task type X?"
2. You sign a quote payload with your authority key and return it.
3. Consumer creates a Job on Solana, escrowing the quoted SOL.
4. You verify the on-chain Job (state, provider match, request hash).
5. You stream inference tokens P2P (handled by the QVAC SDK).
6. After completion, you submit `provider_complete` with a SHA-256 of the output.
7. Consumer signs `consumer_confirm` — escrow lands directly in your wallet.
```

All of this is automatic. You just keep the process running.

You can watch your accumulated earnings on-chain — `Provider.total_earned` increments after every confirmed job. The marketplace UI also shows total SOL earned and jobs completed per provider.

---

## Configuration reference

### Environment variables (`.env`)

| Variable               | Required | Description |
|------------------------|----------|-------------|
| `SOLANA_RPC`           | No       | RPC endpoint (default: `http://localhost:8899`) |
| `SOLANA_KEYPAIR_PATH`  | No       | Provider keypair JSON (default: `~/.config/solana/id.json`) |
| `QVAC_HYPERSWARM_SEED` | **Yes**  | 32-byte hex DHT seed — generate once and keep stable |
| `PROVIDER_NAME`        | No       | Display name in the UI (overrides `qvac.config.json`) |

### Service configuration (`qvac.config.json`)

```json
{
  "marketplace": {
    "name": "My AI Node",
    "taskTypes": 1,
    "pricePerRequest": 10000
  }
}
```

| Key | Description |
|-----|-------------|
| `name`             | Display name shown to consumers (overridden by `PROVIDER_NAME` env) |
| `taskTypes`        | Bitmask of supported tasks — see [Task type bitmask](#task-type-bitmask) |
| `pricePerRequest`  | Price in **lamports** (1 SOL = 1,000,000,000 lamports). Default `10000` = 0.00001 SOL |

### Task type bitmask

`taskTypes` is a `u16` bitmask. Bit *N* set means task type *N* is supported.

| Bit | Task | Note |
|----:|------|------|
| 0 | TEXT  | Text completion (only one available in MVP) |
| 1 | EMBED | Embeddings (V2) |
| 2 | TRANS | Translation (V2) |
| 3 | STT   | Speech-to-text (V2) |
| 4 | TTS   | Text-to-speech (V2) |
| 5 | OCR   | OCR (V2) |
| 6 | IMG   | Image generation (V2) |
| 7 | MULTI | Multimodal (V2) |
| 8 | RAG   | RAG (V2) |
| 9 | VOICE | Voice assistant (V2) |

For TEXT only, set `taskTypes: 1`. For TEXT + EMBED, set `taskTypes: 3` (binary `11`).

### Pricing strategy

Quote-channel rate-limit defaults: 10 quote requests per 10 seconds per peer (Ed25519 signing is cheap but spammable). For a hackathon-grade node, the default `pricePerRequest: 10000` (0.00001 SOL) is fine. Some considerations for live operation:

- **Cover your costs.** Each completed job costs you one Solana tx fee (~5,000 lamports for `provider_complete`). Set `pricePerRequest` well above this floor.
- **Reflect compute.** A 7B-parameter model on a CPU costs orders of magnitude more wall-clock than a 600M model on a GPU. Don't price them the same.
- **Iterate.** You can change `pricePerRequest` any time — restart the node and the new price applies to subsequent quotes.

---

## Keeping it running

For a persistent node, use a process manager:

```bash
npm install -g pm2
pm2 start "npm start" --name qvac-provider
pm2 save
pm2 startup
```

Or write a small systemd unit if you prefer. The provider is a long-lived stateless process — restart-safe as long as the DHT seed and keypair stay constant.

Logs go to stdout. With pm2: `pm2 logs qvac-provider`.

---

## Troubleshooting

**Registration fails with "insufficient funds"**
Airdrop more SOL: `solana airdrop 2 ~/.config/solana/provider.json --url devnet`. The faucet is rate-limited — rerun a few times if needed.

**"Quote channel connect timeout" on the consumer side**
Your DHT announcement can take up to 15 seconds to propagate. Wait for `Quote channel: open` to appear in your terminal before the consumer tries to connect.

**Node appears offline in marketplace after restart**
Make sure `QVAC_HYPERSWARM_SEED` in `.env` matches what was used at registration. A different seed triggers `rotate_peer_id` on-chain; the marketplace's DHT ping picks up the new key within 30 seconds.

**"Provider PDA already exists" on first run**
Means you already registered with this keypair previously. Normal — the node will only update the fields that changed (name, peer ID).

**Consumer sees "rate_limited" rejection**
The bridge sent more than 10 quote requests in a 10-second window. This is the per-socket DoS guard. They should wait briefly and retry; reachable normal usage doesn't trigger it.

**Inference is too slow**
The default model is Qwen3-600M, which fits in ~1 GB RAM and runs on CPU. For higher throughput, switch to a smaller quant or run on hardware with more compute. Model selection is wired in `provider.js` — see the QVAC SDK docs for the model-loading API.
