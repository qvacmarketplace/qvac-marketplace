import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createSignerFromKeyPair,
  createNoopSigner,
  getAddressEncoder,
  getSignatureFromTransaction,
  getTransactionEncoder,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  partiallySignTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
} from "@solana/kit";
import generatedClient from "../clients/js/src/generated/index.js";
const {
  getCreateJobInstructionAsync,
  getConsumerConfirmInstruction,
  getRefundJobInstruction,
  fetchMaybeProvider,
  fetchMaybeJob,
  findProviderPda,
  findJobPda,
  JobState,
} = generatedClient;
import { readFile } from "fs/promises";
import { homedir } from "os";
import { resolve } from "path";

// Ed25519 PKCS8 header (RFC 8410) — required by SubtleCrypto on Node.js 26+.
const PKCS8_ED25519_HEADER = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

// Ed25519SigVerify precompile address.
const ED25519_PROGRAM_ADDRESS = "Ed25519SigVerify111111111111111111111111111";

/**
 * Decode a hex string to Buffer, requiring the exact byte length.
 * `Buffer.from(s, "hex")` silently truncates on invalid input — this catches
 * malformed values from the network instead of failing later with a confusing
 * "wrong signature length" deep in the program.
 */
function decodeHexExact(s, expectedBytes, label) {
  if (typeof s !== "string" || !/^[0-9a-fA-F]*$/.test(s) || s.length !== expectedBytes * 2) {
    throw new Error(`Invalid ${label}: expected ${expectedBytes}-byte hex string`);
  }
  return Buffer.from(s, "hex");
}

function deriveWsUrl(rpcUrl) {
  if (process.env.SOLANA_WS_URL) return process.env.SOLANA_WS_URL;
  const url = new URL(rpcUrl);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    url.protocol = "ws:";
    url.port = String(parseInt(url.port || "8899") + 1);
    return url.toString();
  }
  return rpcUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}

/**
 * Load a Solana keypair from a JSON file (64-byte array from solana-keygen).
 * Defaults to ~/.config/solana/id.json.
 */
export async function loadKeypairSigner(filePath) {
  const path = filePath ?? resolve(homedir(), ".config", "solana", "id.json");
  const bytes = new Uint8Array(JSON.parse(await readFile(path, "utf8")));
  const seed = bytes.slice(0, 32);
  const pubBytes = bytes.slice(32);

  const pkcs8 = new Uint8Array(PKCS8_ED25519_HEADER.length + seed.length);
  pkcs8.set(PKCS8_ED25519_HEADER);
  pkcs8.set(seed, PKCS8_ED25519_HEADER.length);

  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  const publicKey = await crypto.subtle.importKey("raw", pubBytes, "Ed25519", true, ["verify"]);
  return createSignerFromKeyPair({ privateKey, publicKey });
}

/** Create RPC + subscriptions + sendAndConfirm from env vars. */
export function createSolanaClients() {
  const rpcUrl = process.env.SOLANA_RPC ?? "http://localhost:8899";
  const wsUrl = deriveWsUrl(rpcUrl);
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  return { rpc, rpcSubscriptions, sendAndConfirm };
}

async function sendTx(rpc, sendAndConfirm, feePayer, ixs) {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const txSig = getSignatureFromTransaction(signed);
  await sendAndConfirm(signed, { commitment: "confirmed" });
  return txSig;
}

/**
 * Build an unsigned (partially-signed with noop) transaction and return base64 wire bytes.
 * Used to send to the browser for Phantom signing.
 */
async function buildUnsignedTxBase64(rpc, consumerAddress, ixs) {
  const noopSigner = createNoopSigner(consumerAddress);
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(noopSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await partiallySignTransactionMessageWithSigners(msg);
  const bytes = getTransactionEncoder().encode(tx);
  return Buffer.from(bytes).toString("base64");
}

/** Poll until the given signature is confirmed or finalized on-chain. */
async function pollConfirmation(rpc, signature, { maxWaitMs = 60_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Transaction ${signature} did not confirm in ${maxWaitMs}ms`);
}

/** Submit pre-signed base64 transaction bytes and wait for confirmation. Returns signature. */
async function submitAndConfirm(rpc, signedTxBase64) {
  const signature = await rpc.sendTransaction(signedTxBase64, {
    encoding: "base64",
    skipPreflight: false,
  }).send();
  await pollConfirmation(rpc, String(signature));
  return String(signature);
}

/**
 * Fetch the on-chain Provider account by the provider's Solana authority address.
 * Returns { providerPda, qvacPeerId (Uint8Array), name, taskTypes }.
 */
export async function fetchProvider(rpc, authorityAddress) {
  const [providerPda] = await findProviderPda({ authority: authorityAddress });
  const maybeProvider = await fetchMaybeProvider(rpc, providerPda);
  if (!maybeProvider.exists) {
    throw new Error(`Provider not found on-chain for authority ${authorityAddress}`);
  }
  const { qvacPeerId, name, taskTypes } = maybeProvider.data;
  return { providerPda, qvacPeerId: new Uint8Array(qvacPeerId), name, taskTypes };
}

/**
 * Compute the 64-byte quote payload that the provider signs.
 * Format: amount_le(8) || payment_mint(32) || valid_until_le(8) || quote_nonce(16)
 */
export function buildQuotePayload(amount, validUntil, quoteNonce) {
  const buf = Buffer.alloc(64);
  buf.writeBigUInt64LE(BigInt(amount), 0);
  // bytes 8-39: payment_mint = native SOL (all zeros)
  buf.writeBigInt64LE(BigInt(validUntil), 40);
  Buffer.from(quoteNonce).copy(buf, 48);
  return buf;
}

/**
 * Build an Ed25519SigVerify precompile instruction.
 * header(16) | signature(64) | pubkey(32) | message(N)
 */
export function buildEd25519Instruction(pubkeyBytes, sigBytes, msgBytes) {
  const SIG_OFF = 16;
  const PK_OFF = SIG_OFF + 64; // 80
  const MSG_OFF = PK_OFF + 32; // 112
  const data = new Uint8Array(MSG_OFF + msgBytes.length);
  const v = new DataView(data.buffer);
  data[0] = 1; // num_signatures
  data[1] = 0; // padding
  v.setUint16(2, SIG_OFF, true);   // signature_offset
  v.setUint16(4, 0xffff, true);    // sig instruction index (this ix)
  v.setUint16(6, PK_OFF, true);    // public_key_offset
  v.setUint16(8, 0xffff, true);    // pubkey instruction index (this ix)
  v.setUint16(10, MSG_OFF, true);  // message_data_offset
  v.setUint16(12, msgBytes.length, true); // message_data_size
  v.setUint16(14, 0xffff, true);   // message instruction index (this ix)
  data.set(sigBytes, SIG_OFF);
  data.set(pubkeyBytes, PK_OFF);
  data.set(msgBytes, MSG_OFF);
  return { programAddress: ED25519_PROGRAM_ADDRESS, data };
}

/**
 * Compute requestHash = SHA256(UTF8(JSON.stringify(messages)) || nonce_le8)
 */
export async function computeRequestHash(messages, nonce) {
  const msgBytes = new TextEncoder().encode(JSON.stringify(messages));
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  const combined = new Uint8Array(msgBytes.length + 8);
  combined.set(msgBytes, 0);
  combined.set(nonceBuf, msgBytes.length);
  const hash = await crypto.subtle.digest("SHA-256", combined);
  return new Uint8Array(hash);
}

/**
 * Create a job on-chain using the quote received from the provider.
 * quote: { requestId, amount, paymentMint, validUntil, quoteNonce (hex),
 *           signature (hex), providerAuthority }
 * Returns { jobPda, requestHash (hex) }.
 *
 * When remoteSign is provided (Phantom flow):
 *   - consumer may be null; consumerAddress must be supplied
 *   - remoteSign(txBase64, description) → signedTxBase64 (bridge submits)
 */
export async function createJob({
  rpc,
  sendAndConfirm,
  consumer,                // TransactionSigner | null — null in Phantom flow
  consumerAddress,         // string | undefined — Phantom pubkey when consumer is null
  providerPda,
  providerAuthority,
  quote,
  messages,
  nonce,
  taskType = 0,
  remoteSign = null,       // async (txBase64, desc) => signedTxBase64
}) {
  const addr = consumerAddress ?? consumer.address;
  const requestHash = await computeRequestHash(messages, nonce);
  const quoteNonce = decodeHexExact(quote.quoteNonce, 16, "quoteNonce");
  const sig = decodeHexExact(quote.signature, 64, "quote signature");
  const payload = buildQuotePayload(quote.amount, quote.validUntil, quoteNonce);
  const providerPubkeyBytes = getAddressEncoder().encode(providerAuthority);
  const ed25519Ix = buildEd25519Instruction(providerPubkeyBytes, sig, payload);

  const consumerSigner = remoteSign ? createNoopSigner(addr) : consumer;
  const createJobIx = await getCreateJobInstructionAsync({
    provider: providerPda,
    consumer: consumerSigner,
    requestHash,
    nonce: BigInt(nonce),
    amount: BigInt(quote.amount),
    paymentMint: quote.paymentMint,
    quoteSignature: sig,
    taskType,
    validUntil: BigInt(quote.validUntil),
    quoteNonce,
  });

  if (remoteSign) {
    const txBase64 = await buildUnsignedTxBase64(rpc, addr, [ed25519Ix, createJobIx]);
    const signedTxBase64 = await remoteSign(txBase64, "create job");
    await submitAndConfirm(rpc, signedTxBase64);
  } else {
    await sendTx(rpc, sendAndConfirm, consumer, [ed25519Ix, createJobIx]);
  }

  const [jobPda] = await findJobPda({ consumer: addr, nonce: BigInt(nonce) });
  const requestHashHex = Buffer.from(requestHash).toString("hex");
  console.log(`[solana] job created: ${jobPda}`);
  return { jobPda, requestHashHex };
}

/**
 * Compute the response hash the bridge sends to the provider after inference.
 * responseHash = SHA256(UTF8(tokens_concatenated) || nonce_le8)
 */
export async function computeResponseHash(tokens, nonce) {
  const textBytes = new TextEncoder().encode(tokens);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  const combined = new Uint8Array(textBytes.length + 8);
  combined.set(textBytes, 0);
  combined.set(nonceBuf, textBytes.length);
  const hash = await crypto.subtle.digest("SHA-256", combined);
  return new Uint8Array(hash);
}

/**
 * Poll the job PDA until its state transitions to ProviderDone.
 * Returns the job data once the state is reached.
 */
export async function pollJobUntilProviderDone(rpc, jobPda, { maxWaitMs = 90_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const maybeJob = await fetchMaybeJob(rpc, jobPda);
    if (maybeJob.exists && maybeJob.data.state === JobState.ProviderDone) {
      return maybeJob.data;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Job ${jobPda} did not reach ProviderDone within ${maxWaitMs}ms`);
}

/**
 * Confirm a completed job on-chain (consumer_confirm).
 * Returns the transaction signature string.
 *
 * When remoteSign is provided (Phantom flow):
 *   - signer may be null; consumer (address string) is used to build a noopSigner
 *   - remoteSign(txBase64, description) → signedTxBase64 (bridge submits)
 */
export async function confirmJob({
  rpc,
  sendAndConfirm,
  signer,              // TransactionSigner | null — null in Phantom flow
  job,
  provider,
  consumer,            // string address
  providerAuthority,
  remoteSign = null,   // async (txBase64, desc) => signedTxBase64
}) {
  const signerToUse = remoteSign ? createNoopSigner(consumer) : signer;
  const ix = getConsumerConfirmInstruction({
    job,
    provider,
    consumer,
    providerAuthority,
    signer: signerToUse,
  });

  if (remoteSign) {
    const txBase64 = await buildUnsignedTxBase64(rpc, consumer, [ix]);
    const signedTxBase64 = await remoteSign(txBase64, "confirm job");
    const txSig = await submitAndConfirm(rpc, signedTxBase64);
    console.log(`[solana] job confirmed: ${job}`);
    return txSig;
  } else {
    const txSig = await sendTx(rpc, sendAndConfirm, signer, [ix]);
    console.log(`[solana] job confirmed: ${job}`);
    return txSig;
  }
}

// JOB_TIMEOUT from the on-chain program constants (600 seconds).
const JOB_TIMEOUT = 600n;

/**
 * Refund an expired Pending job back to the consumer.
 * Validates eligibility (state == Pending, timeout elapsed) before submitting.
 * Returns the transaction signature.
 */
export async function refundJob({ rpc, sendAndConfirm, consumer, jobPda }) {
  const maybeJob = await fetchMaybeJob(rpc, jobPda);
  if (!maybeJob.exists) {
    throw new Error(`Job ${jobPda} not found on-chain`);
  }
  const job = maybeJob.data;
  if (job.state !== JobState.Pending) {
    throw new Error(`Job ${jobPda} is not Pending (state: ${job.state})`);
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const refundAvailableAt = job.createdAt + JOB_TIMEOUT;
  if (nowSec < refundAvailableAt) {
    const secsLeft = Number(refundAvailableAt - nowSec);
    throw new Error(`Refund not yet available — ${secsLeft}s remaining`);
  }

  const ix = getRefundJobInstruction({ job: jobPda, consumer });
  const txSig = await sendTx(rpc, sendAndConfirm, consumer, [ix]);
  console.log(`[solana] job refunded: ${jobPda}`);
  return txSig;
}
