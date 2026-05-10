# QVAC Marketplace — Anchor Program

The on-chain heart of the QVAC marketplace. A Solana smart contract written in Rust + Anchor that handles **provider registration**, **escrowed inference jobs**, and **dispute-free settlement** between consumers and inference providers.

**Network:** Solana devnet
**Program ID:** [`6rbgdrQdxziVC25kt1Xmtz36ApiLdUVGpdyDcssmgoec`](https://explorer.solana.com/address/6rbgdrQdxziVC25kt1Xmtz36ApiLdUVGpdyDcssmgoec?cluster=devnet)
**Anchor:** 0.30.1 &nbsp;·&nbsp; **Rust:** see `rust-toolchain.toml`

---

## Instructions

| # | Instruction | Who calls it | What it does |
|---|-------------|--------------|--------------|
| 1 | `register_provider`  | provider | Creates the Provider PDA — one per authority wallet |
| 2 | `update_provider`    | provider | Mutates `name` and `task_types` |
| 3 | `rotate_peer_id`     | provider | Replaces the on-chain DHT peer ID after a seed rotation |
| 4 | `create_job`         | consumer | Verifies the provider's signed quote, escrows SOL, opens a Job PDA |
| 5 | `provider_complete`  | provider | Commits the SHA-256 response hash; Job → `ProviderDone` |
| 6 | `consumer_confirm`   | consumer | Releases escrow to the provider; closes Job; rent → consumer |
| 7 | `refund_job`         | consumer | Reclaims escrow after `JOB_TIMEOUT` if the provider never delivered |

---

## Job state machine

```
                    create_job
       ────────────────────────────────►   ┌──────────────┐
                                           │   Pending    │
                                           └──┬────────┬──┘
                          provider_complete   │        │   refund_job (after JOB_TIMEOUT)
                                              ▼        ▼
                                  ┌──────────────┐    ┌──────────┐
                                  │ ProviderDone │    │ Refunded │ (closed)
                                  └──────┬───────┘    └──────────┘
                                         │ consumer_confirm
                                         ▼
                                  ┌──────────────┐
                                  │  Completed   │ (closed)
                                  └──────────────┘
```

- **`Pending`** — funds in escrow; consumer can refund only here.
- **`ProviderDone`** — provider has committed a response hash. Refund is *blocked* (provider has delivered). Consumer can confirm anytime; after `CONFIRM_WINDOW` (300s) anyone may confirm to auto-release (so funds don't sit forever if the consumer ghosts).
- **`Completed` / `Refunded`** — terminal states; the Job PDA is closed and rent returns to the consumer.
- **`Disputed`** — reserved for V2; not reachable in MVP.

---

## On-chain accounts

### Provider PDA
**Seeds:** `["provider", authority_pubkey]` — one per wallet.

| Field | Type | Notes |
|-------|------|-------|
| `version` | `u8` | Layout version (= `PROVIDER_VERSION`) |
| `authority` | `Pubkey` | Owner; receives payouts |
| `qvac_peer_id` | `[u8; 32]` | Hyperdht public key — what consumers connect to |
| `name` | `String` | 3–50 UTF-8 bytes |
| `task_types` | `u16` | Bitmask — see [Task types](#task-types) |
| `jobs_completed` | `u64` | Lifetime count |
| `total_earned` | `u64` | Lifetime lamports earned |
| `registered_at` | `i64` | Unix timestamp |
| `bump` | `u8` | Cached PDA bump |
| `reserved` | `[u8; 30]` | Forward-compat |

### Job PDA
**Seeds:** `["job", consumer_pubkey, nonce_le8]` — multiple concurrent jobs per consumer.

| Field | Type | Notes |
|-------|------|-------|
| `version` | `u8` | Layout version (= `JOB_VERSION`) |
| `state` | `JobState` | See state machine above |
| `task_type` | `u8` | Validated against `provider.task_types` |
| `consumer` | `Pubkey` | Funder + sole refund / rent destination |
| `provider` | `Pubkey` | Provider PDA snapshot |
| `provider_authority` | `Pubkey` | Payout target — snapshotted at create time |
| `request_hash` | `[u8; 32]` | SHA256(payload ‖ nonce_le8) |
| `response_hash` | `[u8; 32]` | Set by provider in `provider_complete` |
| `amount` | `u64` | Lamports escrowed (snapshot of agreed quote) |
| `payment_mint` | `Pubkey` | `Pubkey::default()` = native SOL (MVP) |
| `nonce` | `u64` | Consumer-supplied uniqueness seed |
| `created_at` | `i64` | Unix timestamp |
| `provider_done_at` | `i64` | Unix timestamp at `provider_complete` (0 until set) |

---

## Quote signature design

The interesting bit. To bind off-chain pricing to on-chain settlement without trusting the bridge, **the provider Ed25519-signs a price commitment** that the consumer carries into `create_job`. The on-chain program verifies it via Solana's native `Ed25519SigVerify` precompile, sibling-instruction-style.

**Signed payload** (64 bytes):

```
| amount_le (8) | payment_mint (32) | valid_until_le (8) | quote_nonce (16) |
```

**Transaction layout** the consumer submits:

```
ix[0] = Ed25519SigVerify   (provider's signature over payload)
ix[1] = create_job         (re-derives the same payload, calls get_instruction_relative(-1, …))
```

`create_job` reconstructs the exact 64 bytes from its own arguments, then asserts that the Ed25519 instruction at `index - 1`:

1. targets the canonical `Ed25519SigVerify` program ID,
2. references the same pubkey (`provider.authority`),
3. references the same signature (`quote_signature`),
4. references the same message (the reconstructed payload).

If anything mismatches, the program returns `InvalidQuoteSignature`. This means the bridge cannot forge prices, replay outdated quotes, or substitute a different provider — every `create_job` is cryptographically pinned to a quote the provider chose to sign.

> **Note:** the signed payload binds *price commitments* (`amount`, `payment_mint`, `valid_until`, `quote_nonce`) but **not** `request_hash`. Quotes are flat-rate price commitments valid for any request hash until expiry. Providers should keep validity windows short (≤5 min, the SDK default) to limit exposure.

---

## Constants

| Name | Value | Where it bites |
|------|-------|----------------|
| `JOB_TIMEOUT`     | 600s        | `refund_job` becomes callable after `created_at + JOB_TIMEOUT` |
| `CONFIRM_WINDOW`  | 300s        | After `provider_done_at + CONFIRM_WINDOW`, *anyone* can call `consumer_confirm` |
| `MIN_AMOUNT`      | 1,000 lamp. | Minimum per-job escrow                                          |
| `MIN_NAME_LEN`    | 3 bytes     | Provider name lower bound (UTF-8)                              |
| `MAX_NAME_LEN`    | 50 bytes    | Provider name upper bound (UTF-8)                              |

---

## Task types

`Provider.task_types` is a `u16` bitmask. Bit *N* set means task type *N* is supported.

| Bit | Task | Description                       |
|----:|------|-----------------------------------|
| 0   | TEXT  | Text completion (default in MVP) |
| 1   | EMBED | Embeddings                        |
| 2   | TRANS | Translation                       |
| 3   | STT   | Speech-to-text                    |
| 4   | TTS   | Text-to-speech                    |
| 5   | OCR   | Optical character recognition     |
| 6   | IMG   | Image generation                  |
| 7   | MULTI | Multimodal                        |
| 8   | RAG   | Retrieval-augmented generation    |
| 9   | VOICE | Voice assistant                   |

Example: a provider supporting TEXT + EMBED sets `task_types = (1<<0) | (1<<1) = 3`.

---

## Build, test, deploy

```bash
# Build (writes IDL → target/idl/qvac_marketplace.json)
anchor build

# Run the integration test suite (39 tests against local validator)
anchor test

# Deploy to devnet (requires upgrade authority funded with SOL)
anchor deploy --provider.cluster devnet
```

> The program keypair lives at `target/deploy/qvac_marketplace-keypair.json`. **Back it up.** Losing it means you cannot upgrade the program; you'd have to redeploy at a new address and migrate the entire ecosystem.

---

## Security posture

- **Checked arithmetic.** All counter updates use `checked_add` / `checked_sub`. Overflow → tx fails with `ArithmeticOverflow`.
- **Explicit account constraints.** Every account is bound by either PDA re-derivation, `has_one`, or an explicit `address` constraint. No discriminator-only checks.
- **Version gates.** `Provider.version` and `Job.version` are validated on every read; future-incompatible builds reject old data with `UnsupportedAccountVersion`.
- **No unwrap / expect.** Errors propagate via `Result<>`. Instruction handlers return typed `MarketplaceError` codes.
- **Sibling-only Ed25519.** The verification routine requires the precompile reference indices to be `u16::MAX` (self-instruction); cross-instruction lookup is rejected to prevent payload smuggling.

See the security audit notes in the project history for the full review.

---

## Generated TypeScript client

Anchor → Codama → `clients/js/src/generated/`. See [clients/README.md](../clients/README.md) for usage and regeneration.
