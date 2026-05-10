# QVAC Marketplace — TypeScript Client

Auto-generated TypeScript SDK for the QVAC Marketplace Anchor program. Built with [Codama](https://github.com/codama-idl/codama) from the program IDL, with `@solana/kit` v6 as the runtime.

> **Generated code — do not edit by hand.**
> Files under `js/src/generated/` are regenerated from `target/idl/qvac_marketplace.json`. Manual edits will be overwritten on the next build.

---

## What's inside

```
clients/js/src/generated/
├── accounts/        fetchMaybeProvider, fetchMaybeJob
├── instructions/    builders for all 7 program ixs
├── pdas/            findProviderPda, findJobPda
├── programs/        program address constant
├── types/           JobState, TaskType (enums)
└── errors/          typed MarketplaceError variants
```

The generated client compiles as **CommonJS** under the root `tsconfig.json`. In ESM context (Node.js with `"type": "module"`) you must use the **default import** form — named imports fail static analysis:

```js
import generatedClient from '../clients/js/src/generated/index.js'
const { getCreateJobInstructionAsync, fetchMaybeProvider } = generatedClient
```

---

## Installation

The SDK requires `@solana/kit` ≥ 6.4 as a peer dependency:

```bash
npm install @solana/kit
```

The generated client itself isn't published to npm; consume it directly from this repo (`qvac-bridge/` and `qvac-provider/` both do).

---

## End-to-end example

Reading a Provider, then creating and confirming a Job:

```ts
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createSignerFromKeyPair,
  sendAndConfirmTransactionFactory,
} from '@solana/kit'
import generatedClient from '../clients/js/src/generated/index.js'
const {
  getCreateJobInstructionAsync,
  getConsumerConfirmInstruction,
  fetchMaybeProvider,
  findProviderPda,
  findJobPda,
} = generatedClient

const rpc = createSolanaRpc('https://api.devnet.solana.com')
const rpcSubs = createSolanaRpcSubscriptions('wss://api.devnet.solana.com')
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: rpcSubs })

// 1. Look up a provider by their authority address
const providerAuthority = 'G2VLzNG1DipSkfaHEYn4y1Eh5x4MBYyqcEK9p1v9FXx2'
const [providerPda] = await findProviderPda({ authority: providerAuthority })
const maybeProvider = await fetchMaybeProvider(rpc, providerPda)
if (!maybeProvider.exists) throw new Error('not registered')
console.log('Found provider:', maybeProvider.data.name)

// 2. Create a job (escrow SOL, verify provider's signed quote)
const consumer = /* TransactionSigner */
const ix = await getCreateJobInstructionAsync({
  provider: providerPda,
  consumer,
  requestHash: /* SHA256(payload || nonce_le8) */,
  nonce: 1n,
  amount: 10_000n,                       // lamports
  paymentMint: 'So11111111111111111111111111111111111111112', // native SOL
  quoteSignature: /* 64-byte Ed25519 sig from provider */,
  taskType: 0,                           // TEXT
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 300),
  quoteNonce: /* 16-byte nonce from quote */,
})
// (build + send a versioned tx with [Ed25519SigVerify ix, ix] — see qvac-bridge/solana.js)

// 3. After provider commits response_hash, confirm to release escrow
const [jobPda] = await findJobPda({ consumer: consumer.address, nonce: 1n })
const confirmIx = getConsumerConfirmInstruction({
  job: jobPda,
  provider: providerPda,
  consumer: consumer.address,
  providerAuthority,
  signer: consumer,
})
```

For complete working code, see:
- **[qvac-bridge/solana.js](../qvac-bridge/solana.js)** — consumer side (`createJob`, `confirmJob`, `refundJob`)
- **[qvac-provider/solana.js](../qvac-provider/solana.js)** — provider side (`registerProvider`, `submitProviderComplete`)

---

## Regenerating after program changes

If you modify `programs/qvac_marketplace/src/`:

```bash
# 1. Rebuild — produces a fresh IDL at target/idl/qvac_marketplace.json
anchor build

# 2. Run Codama — reads codama.json at the repo root
npx codama
```

This regenerates everything under `clients/js/src/generated/`. Commit those files alongside the program changes so consumers stay in sync.

---

## Why generated?

Hand-written clients drift from the program. Codama reads the canonical IDL and produces typed builders, fetchers, and PDA derivers in one step — no chance of a mismatch between how the program decodes accounts and how the client encodes instructions. When the program adds a field or instruction, regenerate and the type system tells you exactly where to update.
