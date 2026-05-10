import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createSignerFromKeyPair,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
} from "@solana/kit";
// The generated client compiles as CJS under the root tsconfig; default import
// is required in ESM context — named imports fail static analysis.
import generatedClient from "../clients/js/src/generated/index.js";
const {
  getRegisterProviderInstructionAsync,
  getUpdateProviderInstructionAsync,
  getRotatePeerIdInstructionAsync,
  getProviderCompleteInstructionAsync,
  fetchMaybeProvider,
  findProviderPda,
} = generatedClient;
import { readFile } from "fs/promises";
import { homedir } from "os";
import { resolve } from "path";

/** Derive WebSocket URL from an HTTP(S) RPC URL. SOLANA_WS_URL overrides. */
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

// DER header for PKCS8-encoded Ed25519 private key (RFC 8410).
// Must prefix the 32-byte seed before importing via SubtleCrypto.
const PKCS8_ED25519_HEADER = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Load a Solana keypair from a JSON file (64-byte array format from `solana-keygen`).
 * Defaults to ~/.config/solana/id.json when filePath is null/undefined.
 */
export async function loadKeypairSigner(filePath) {
  const path = filePath ?? resolve(homedir(), ".config", "solana", "id.json");
  const bytes = new Uint8Array(JSON.parse(await readFile(path, "utf8")));
  const seed = bytes.slice(0, 32);
  const pubBytes = bytes.slice(32);

  // SubtleCrypto requires PKCS8 wrapping for Ed25519 private keys; "raw" is public-only.
  const pkcs8 = new Uint8Array(PKCS8_ED25519_HEADER.length + seed.length);
  pkcs8.set(PKCS8_ED25519_HEADER);
  pkcs8.set(seed, PKCS8_ED25519_HEADER.length);

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    "Ed25519",
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    pubBytes,
    "Ed25519",
    true,
    ["verify"],
  );
  return createSignerFromKeyPair({ privateKey, publicKey });
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
  await sendAndConfirm(signed, { commitment: "confirmed" });
}

/**
 * Create RPC + sendAndConfirm clients from env vars.
 * Called once at startup; passed into startQuoteChannel so the quote
 * handler can submit provider_complete without re-creating connections.
 */
export function createSolanaClients() {
  const rpcUrl = process.env.SOLANA_RPC ?? "http://localhost:8899";
  const wsUrl = deriveWsUrl(rpcUrl);
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  return { rpc, sendAndConfirm };
}

/**
 * Submit the provider_complete instruction for a finished job.
 * responseHash: Uint8Array(32) — SHA256 of the inference response.
 */
export async function submitProviderComplete({ rpc, sendAndConfirm, authority, jobPda, providerPda, responseHash }) {
  const ix = await getProviderCompleteInstructionAsync({
    job: jobPda,
    provider: providerPda,
    authority,
    responseHash,
  });
  await sendTx(rpc, sendAndConfirm, authority, [ix]);
  console.log(`[solana] provider_complete: ${jobPda}`);
}

/**
 * Idempotently register or update this provider on-chain.
 *
 * - PDA absent → calls register_provider
 * - PDA present, name/taskTypes changed → calls update_provider
 * - PDA present and unchanged → no-op
 *
 * Reads SOLANA_RPC, SOLANA_WS_URL, SOLANA_KEYPAIR_PATH from the environment.
 * Returns { authority: TransactionSigner, providerPda: Address }.
 */
export async function ensureProviderRegistered({ qvacPeerId, taskTypes, name }) {
  const rpcUrl = process.env.SOLANA_RPC ?? "http://localhost:8899";
  const wsUrl = deriveWsUrl(rpcUrl);
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH ?? null;

  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  const authority = await loadKeypairSigner(keypairPath);
  const [providerPda] = await findProviderPda({ authority: authority.address });

  const maybeProvider = await fetchMaybeProvider(rpc, providerPda);

  if (!maybeProvider.exists) {
    console.log("Registering provider on-chain...");
    const ix = await getRegisterProviderInstructionAsync({
      authority,
      name,
      taskTypes,
      qvacPeerId,
    });
    await sendTx(rpc, sendAndConfirm, authority, [ix]);
    console.log(`Provider registered.`);
  } else {
    const on = maybeProvider.data;
    const onPeerIdHex = Buffer.from(on.qvacPeerId).toString("hex");
    const newPeerIdHex = Buffer.from(qvacPeerId).toString("hex");
    const peerIdChanged = onPeerIdHex !== newPeerIdHex;
    const metaChanged = on.name !== name || on.taskTypes !== taskTypes;

    if (peerIdChanged) {
      console.log("Rotating qvacPeerId on-chain...");
      const ix = await getRotatePeerIdInstructionAsync({ authority, qvacPeerId });
      await sendTx(rpc, sendAndConfirm, authority, [ix]);
      console.log(`qvacPeerId rotated.`);
    }
    if (metaChanged) {
      console.log("Updating provider on-chain...");
      const ix = await getUpdateProviderInstructionAsync({ authority, name, taskTypes });
      await sendTx(rpc, sendAndConfirm, authority, [ix]);
      console.log(`Provider updated.`);
    }
    if (!peerIdChanged && !metaChanged) {
      console.log(`Provider already up-to-date.`);
    }
  }

  return { authority, providerPda };
}
