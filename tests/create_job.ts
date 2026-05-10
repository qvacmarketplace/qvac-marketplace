import assert from "assert";
import {
  generateKeyPairSigner,
  generateKeyPair,
  createSignerFromKeyPair,
  signBytes,
  type Instruction,
  type Address,
} from "@solana/kit";
import {
  getCreateJobInstructionAsync,
  fetchJob,
  findJobPda,
  QVAC_MARKETPLACE_ERROR__QUOTE_EXPIRED,
  QVAC_MARKETPLACE_ERROR__QUOTE_SIGNATURE_MISSING,
  QVAC_MARKETPLACE_ERROR__INVALID_QUOTE_SIGNATURE,
  QVAC_MARKETPLACE_ERROR__AMOUNT_BELOW_MINIMUM,
  QVAC_MARKETPLACE_ERROR__PAYMENT_MINT_MISMATCH,
  QVAC_MARKETPLACE_ERROR__TASK_TYPE_NOT_SUPPORTED,
  QVAC_MARKETPLACE_ERROR__INVALID_TASK_TYPE,
  QVAC_MARKETPLACE_ERROR__INVALID_REQUEST_HASH,
} from "../clients/js/src/generated";
import { JobState } from "../clients/js/src/generated/types/jobState";
import {
  rpc,
  airdrop,
  sendTx,
  expectCustomError,
  setupProvider,
  buildQuotePayload,
  buildEd25519Instruction,
  DEFAULT_PUBKEY,
} from "./helpers";

// Build a valid (or intentionally broken) create_job + Ed25519 instruction pair.
async function buildCreateJobTx(opts: {
  providerPda: Address;
  consumer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  keyPair: CryptoKeyPair; // provider's signing keypair
  nonce?: bigint;
  amount?: bigint;
  taskType?: number;
  paymentMint?: Address;
  requestHash?: Uint8Array;
  validUntilOverride?: bigint; // override to test expiry
  // Tampering options
  tamperSig?: boolean; // put random bytes as signature in Ed25519 instruction
  wrongSigningKey?: CryptoKeyPair; // sign with a different key
  wrongMessage?: boolean; // sign a different message than what create_job will reconstruct
  omitEd25519?: boolean; // skip the Ed25519 precompile instruction entirely
}): Promise<Instruction[]> {
  const {
    providerPda,
    consumer,
    keyPair,
    nonce = 0n,
    amount = 10_000n,
    taskType = 0,
    paymentMint = DEFAULT_PUBKEY,
    requestHash = new Uint8Array(32).fill(0x42),
    validUntilOverride,
    tamperSig = false,
    wrongSigningKey,
    wrongMessage = false,
    omitEd25519 = false,
  } = opts;

  const now = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = validUntilOverride ?? now + 300n;
  const quoteNonce = crypto.getRandomValues(new Uint8Array(16));

  // Payload that create_job will reconstruct from its args
  const correctPayload = buildQuotePayload(amount, validUntil, quoteNonce);

  // Payload actually signed (may be tampered for error tests)
  const signingPayload = wrongMessage
    ? new Uint8Array(64).fill(0xde) // different from correctPayload
    : correctPayload;

  const signingKeyPair = wrongSigningKey ?? keyPair;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sig: any = await signBytes(signingKeyPair.privateKey, signingPayload);
  if (tamperSig) {
    sig = new Uint8Array(64).fill(0xff);
  }

  // The Ed25519 instruction must be internally consistent so the precompile
  // passes — our program then does the semantic checks (pubkey vs authority,
  // message vs reconstructed payload).
  //
  // wrongSigningKey: put the impostor pubkey in the Ed25519 ix so the
  //   precompile verifies it; our program then rejects because it ≠ provider.authority.
  //
  // wrongMessage: put the signed (wrong) message in the Ed25519 ix so the
  //   precompile verifies it; our program reconstructs the correct payload from
  //   create_job args and rejects when they don't match.
  const pubkeyKeyPair = wrongSigningKey ?? keyPair;
  const pubkeyBuf = await crypto.subtle.exportKey("raw", pubkeyKeyPair.publicKey);
  const pubkeyBytes = new Uint8Array(pubkeyBuf);
  // Use signingPayload (what was actually signed) as the message in the Ed25519 ix.
  const ed25519Message = signingPayload;

  const createJobIx = await getCreateJobInstructionAsync({
    provider: providerPda,
    consumer,
    requestHash,
    nonce,
    amount,
    paymentMint,
    quoteSignature: sig as Uint8Array,
    taskType,
    validUntil,
    quoteNonce,
  });

  if (omitEd25519) {
    return [createJobIx as unknown as Instruction];
  }

  const ed25519Ix = buildEd25519Instruction(pubkeyBytes, sig as Uint8Array, ed25519Message);
  return [ed25519Ix, createJobIx as unknown as Instruction];
}

describe("create_job", () => {
  let ctx: Awaited<ReturnType<typeof setupProvider>>;
  let consumer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let nonce = 0n;

  before(async () => {
    // Provider supports Completion (bit 0) only
    ctx = await setupProvider(1);
    consumer = await generateKeyPairSigner();
    await airdrop(consumer.address, 10); // extra SOL for many jobs
  });

  const nextNonce = () => ++nonce;

  it("creates a job with valid Ed25519 quote signature", async () => {
    const n = nextNonce();
    const amount = 10_000n;
    const ixs = await buildCreateJobTx({
      providerPda: ctx.providerPda,
      consumer,
      keyPair: ctx.keyPair,
      nonce: n,
      amount,
    });
    await sendTx(consumer, ixs);

    const [jobPda] = await findJobPda({ consumer: consumer.address, nonce: n });
    const job = await fetchJob(rpc, jobPda);
    assert.strictEqual(job.data.state, JobState.Pending);
    assert.strictEqual(job.data.amount, amount);
    assert.strictEqual(job.data.consumer, consumer.address);
    assert.strictEqual(job.data.provider, ctx.providerPda);
  });

  it("rejects an expired quote (valid_until in the past)", async () => {
    await expectCustomError(async () => {
      const ixs = await buildCreateJobTx({
        providerPda: ctx.providerPda,
        consumer,
        keyPair: ctx.keyPair,
        nonce: nextNonce(),
        validUntilOverride: BigInt(Math.floor(Date.now() / 1000)) - 60n, // 1 minute ago
      });
      await sendTx(consumer, ixs);
    }, QVAC_MARKETPLACE_ERROR__QUOTE_EXPIRED);
  });

  it("rejects when Ed25519 sibling instruction is missing", async () => {
    await expectCustomError(async () => {
      const ixs = await buildCreateJobTx({
        providerPda: ctx.providerPda,
        consumer,
        keyPair: ctx.keyPair,
        nonce: nextNonce(),
        omitEd25519: true,
      });
      await sendTx(consumer, ixs);
    }, QVAC_MARKETPLACE_ERROR__QUOTE_SIGNATURE_MISSING);
  });

  it("rejects a tampered signature in the Ed25519 instruction", async () => {
    // The Ed25519 precompile itself rejects a bad sig, causing simulation failure.
    // We just verify any error is thrown.
    try {
      const ixs = await buildCreateJobTx({
        providerPda: ctx.providerPda,
        consumer,
        keyPair: ctx.keyPair,
        nonce: nextNonce(),
        tamperSig: true,
      });
      await sendTx(consumer, ixs);
      assert.fail("Expected tampered-signature tx to fail");
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      assert.ok(true);
    }
  });

  it("rejects when quote is signed by a different key (not provider.authority)", async () => {
    await expectCustomError(async () => {
      const impostor = await generateKeyPair();
      const ixs = await buildCreateJobTx({
        providerPda: ctx.providerPda,
        consumer,
        keyPair: ctx.keyPair,
        nonce: nextNonce(),
        wrongSigningKey: impostor,
      });
      await sendTx(consumer, ixs);
    }, QVAC_MARKETPLACE_ERROR__INVALID_QUOTE_SIGNATURE);
  });

  it("rejects when quote message doesn't match the reconstructed payload", async () => {
    await expectCustomError(async () => {
      const ixs = await buildCreateJobTx({
        providerPda: ctx.providerPda,
        consumer,
        keyPair: ctx.keyPair,
        nonce: nextNonce(),
        wrongMessage: true,
      });
      await sendTx(consumer, ixs);
    }, QVAC_MARKETPLACE_ERROR__INVALID_QUOTE_SIGNATURE);
  });

  it("rejects amount below minimum (1000 lamports)", async () => {
    await expectCustomError(async () => {
      const ixs = await buildCreateJobTx({
        providerPda: ctx.providerPda,
        consumer,
        keyPair: ctx.keyPair,
        nonce: nextNonce(),
        amount: 999n,
      });
      await sendTx(consumer, ixs);
    }, QVAC_MARKETPLACE_ERROR__AMOUNT_BELOW_MINIMUM);
  });

  it("rejects non-default payment_mint (SPL not supported in MVP)", async () => {
    await expectCustomError(async () => {
      const splMint = "So11111111111111111111111111111111111111112" as Address;
      const ixs = await buildCreateJobTx({
        providerPda: ctx.providerPda,
        consumer,
        keyPair: ctx.keyPair,
        nonce: nextNonce(),
        paymentMint: splMint,
      });
      await sendTx(consumer, ixs);
    }, QVAC_MARKETPLACE_ERROR__PAYMENT_MINT_MISMATCH);
  });

  it("rejects task_type not in provider's supported bitmask", async () => {
    // Provider supports only bit 0 (Completion). Request bit 1 (Embeddings).
    await expectCustomError(async () => {
      const ixs = await buildCreateJobTx({
        providerPda: ctx.providerPda,
        consumer,
        keyPair: ctx.keyPair,
        nonce: nextNonce(),
        taskType: 1, // Embeddings — not in bitmask 0b0001
      });
      await sendTx(consumer, ixs);
    }, QVAC_MARKETPLACE_ERROR__TASK_TYPE_NOT_SUPPORTED);
  });

  it("rejects task_type > TaskType::MAX (10)", async () => {
    await expectCustomError(async () => {
      const ixs = await buildCreateJobTx({
        providerPda: ctx.providerPda,
        consumer,
        keyPair: ctx.keyPair,
        nonce: nextNonce(),
        taskType: 10, // MAX is 9
      });
      await sendTx(consumer, ixs);
    }, QVAC_MARKETPLACE_ERROR__INVALID_TASK_TYPE);
  });

  it("rejects all-zero request_hash", async () => {
    await expectCustomError(async () => {
      const ixs = await buildCreateJobTx({
        providerPda: ctx.providerPda,
        consumer,
        keyPair: ctx.keyPair,
        nonce: nextNonce(),
        requestHash: new Uint8Array(32), // all zeros
      });
      await sendTx(consumer, ixs);
    }, QVAC_MARKETPLACE_ERROR__INVALID_REQUEST_HASH);
  });
});
