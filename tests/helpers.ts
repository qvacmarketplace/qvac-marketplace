import assert from "assert";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPair,
  generateKeyPairSigner,
  createSignerFromKeyPair,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  lamports,
  isSolanaError,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  signBytes,
  type Address,
  type TransactionSigner,
  type Instruction,
} from "@solana/kit";
import {
  getRegisterProviderInstructionAsync,
  getCreateJobInstructionAsync,
  findProviderPda,
  findJobPda,
} from "../clients/js/src/generated";

export const RPC_URL = "http://localhost:8899";
export const WS_URL = "ws://localhost:8900";

export const rpc = createSolanaRpc(RPC_URL);
export const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
export const sendAndConfirm = sendAndConfirmTransactionFactory({
  rpc,
  rpcSubscriptions,
});

// Native SOL: Pubkey::default() = all-zero bytes = System Program address
export const DEFAULT_PUBKEY = "11111111111111111111111111111111" as Address;
export const ED25519_PROGRAM_ADDRESS =
  "Ed25519SigVerify111111111111111111111111111" as Address;

export async function airdrop(address: Address, sol = 2): Promise<void> {
  const sig = await rpc
    .requestAirdrop(address, lamports(BigInt(sol) * 1_000_000_000n))
    .send();
  for (let i = 0; i < 30; i++) {
    const { value: statuses } = await rpc.getSignatureStatuses([sig]).send();
    if (statuses[0] && statuses[0].confirmationStatus === "confirmed") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Airdrop to ${address} not confirmed after 15s`);
}

export async function sendTx(
  feePayer: TransactionSigner,
  ixs: readonly Instruction[],
): Promise<void> {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const msg: any = pipe(
    createTransactionMessage({ version: 0 }),
    (m: any) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m: any) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m: any) => appendTransactionMessageInstructions(ixs as any, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  await sendAndConfirm(signed as any, { commitment: "confirmed" });
}

export function extractCustomErrorCode(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const err = e as Record<string, unknown>;
  if (isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
    return (err.context as Record<string, number> | undefined)?.code;
  }
  if (err.cause !== undefined) return extractCustomErrorCode(err.cause);
  return undefined;
}

export async function expectCustomError(
  fn: () => Promise<void>,
  expectedCode: number,
): Promise<void> {
  try {
    await fn();
    assert.fail(`Expected custom error ${expectedCode} but transaction succeeded`);
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    const code = extractCustomErrorCode(e);
    assert.strictEqual(
      code,
      expectedCode,
      `Expected custom error code ${expectedCode}, got ${code}. Error: ${String(e)}`,
    );
  }
}

// Build the 64-byte quote payload signed by the provider:
// amount_le(8) || payment_mint(32) || valid_until_le(8) || quote_nonce(16)
export function buildQuotePayload(
  amount: bigint,
  validUntil: bigint,
  quoteNonce: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(64);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, amount, true); // amount LE
  // payment_mint: 32 zero bytes (SOL default) — already zero
  view.setBigInt64(40, validUntil, true); // valid_until LE
  buf.set(quoteNonce, 48); // quote_nonce
  return buf;
}

// Build an Ed25519SigVerify precompile instruction:
// header(16) + signature(64) + pubkey(32) + message(N)
export function buildEd25519Instruction(
  pubkeyBytes: Uint8Array, // 32 bytes
  sigBytes_: Uint8Array, // 64 bytes
  msgBytes: Uint8Array, // payload
): Instruction {
  const SIG_OFFSET = 16; // right after 16-byte header
  const PK_OFFSET = SIG_OFFSET + 64; // 80
  const MSG_OFFSET = PK_OFFSET + 32; // 112

  const data = new Uint8Array(MSG_OFFSET + msgBytes.length);
  const view = new DataView(data.buffer);

  data[0] = 1; // num_signatures
  data[1] = 0; // padding
  view.setUint16(2, SIG_OFFSET, true); // signature_offset
  view.setUint16(4, 0xffff, true); // sig in this instruction
  view.setUint16(6, PK_OFFSET, true); // public_key_offset
  view.setUint16(8, 0xffff, true); // pubkey in this instruction
  view.setUint16(10, MSG_OFFSET, true); // message_data_offset
  view.setUint16(12, msgBytes.length, true); // message_data_size
  view.setUint16(14, 0xffff, true); // message in this instruction

  data.set(sigBytes_, SIG_OFFSET);
  data.set(pubkeyBytes, PK_OFFSET);
  data.set(msgBytes, MSG_OFFSET);

  return { programAddress: ED25519_PROGRAM_ADDRESS, data } as unknown as Instruction;
}

// Register a provider on-chain; returns [providerPda, providerKeyPair].
// providerKeyPair is the raw CryptoKeyPair so callers can sign quotes.
export async function setupProvider(
  taskTypes = 1,
): Promise<{ providerSigner: TransactionSigner; providerPda: Address; keyPair: CryptoKeyPair }> {
  const keyPair = await generateKeyPair();
  const providerSigner = await createSignerFromKeyPair(keyPair);
  await airdrop(providerSigner.address);

  const ix = await getRegisterProviderInstructionAsync({
    authority: providerSigner,
    name: "test-provider",
    taskTypes,
    qvacPeerId: new Uint8Array(32).fill(0x01),
  });
  await sendTx(providerSigner, [ix as unknown as Instruction]);

  const [providerPda] = await findProviderPda({
    authority: providerSigner.address,
  });
  return { providerSigner, providerPda, keyPair };
}

// Create a job on-chain; returns jobPda.
// consumer must be pre-funded. nonce must be unique per consumer.
export async function setupJob(
  consumer: TransactionSigner,
  providerPda: Address,
  keyPair: CryptoKeyPair,
  nonce = 0n,
  amount = 10_000n,
  taskType = 0,
): Promise<Address> {
  const pubkeyBuf = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const pubkeyBytes = new Uint8Array(pubkeyBuf);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = now + 300n;
  const quoteNonce = crypto.getRandomValues(new Uint8Array(16));
  const payload = buildQuotePayload(amount, validUntil, quoteNonce);
  const sig = await signBytes(keyPair.privateKey, payload);

  const ed25519Ix = buildEd25519Instruction(pubkeyBytes, sig as Uint8Array, payload);
  const createJobIx = await getCreateJobInstructionAsync({
    provider: providerPda,
    consumer,
    requestHash: new Uint8Array(32).fill(0x42),
    nonce,
    amount,
    paymentMint: DEFAULT_PUBKEY,
    quoteSignature: sig as Uint8Array,
    taskType,
    validUntil,
    quoteNonce,
  });

  await sendTx(consumer, [ed25519Ix, createJobIx as unknown as Instruction]);

  const [jobPda] = await findJobPda({ consumer: consumer.address, nonce });
  return jobPda;
}
