import Hyperswarm from "hyperswarm";
import { signBytes } from "@solana/kit";
import { submitProviderComplete } from "./solana.js";
import generatedClient from "../clients/js/src/generated/index.js";
const { fetchMaybeJob: fetchMaybeJobOnChain } = generatedClient;

const QUOTE_TOPIC_PREFIX = "qvac-quote-v1:";
const QUOTE_VALIDITY_SECS = 300n;
// Hard cap on a single line-delimited message — protects against a peer
// that streams data without ever sending '\n' (would otherwise grow the
// per-socket buffer without bound).
const MAX_LINE_BYTES = 64 * 1024;
// Per-socket rate limit for quote_request: at most N signatures per window.
// Each quote_request triggers an Ed25519 signature; without a cap, a peer
// could spam to burn CPU.
const QUOTE_RATE_LIMIT = 10;
const QUOTE_RATE_WINDOW_MS = 10_000;

async function computeTopic(authorityAddress) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(QUOTE_TOPIC_PREFIX + authorityAddress),
  );
  return Buffer.from(hash);
}

function buildQuotePayload(amount, validUntil, quoteNonce) {
  // amount_le(8) || payment_mint(32) || valid_until_le(8) || quote_nonce(16)
  const buf = Buffer.alloc(64);
  buf.writeBigUInt64LE(amount, 0);
  // bytes 8-39: payment_mint = native SOL (all zeros, already zeroed)
  buf.writeBigInt64LE(validUntil, 40);
  Buffer.from(quoteNonce).copy(buf, 48);
  return buf;
}

function sendLine(socket, obj) {
  if (!socket.destroyed) socket.write(JSON.stringify(obj) + "\n");
}

async function handleMessage(socket, msg, ctx) {
  const { authority, providerPda, qvacPeerIdHex, amount, rpc, sendAndConfirm } = ctx;

  if (msg.type === "quote_request") {
    const { requestId } = msg;

    // Rate-limit per socket. socket._quoteHits is an array of recent timestamps.
    const now = Date.now();
    const hits = (socket._quoteHits ??= []);
    while (hits.length && now - hits[0] > QUOTE_RATE_WINDOW_MS) hits.shift();
    if (hits.length >= QUOTE_RATE_LIMIT) {
      console.warn(`[quote] rate-limited socket (>${QUOTE_RATE_LIMIT} req/${QUOTE_RATE_WINDOW_MS}ms)`);
      sendLine(socket, { type: "quote_rejected", requestId, reason: "rate_limited" });
      return;
    }
    hits.push(now);

    const validUntil =
      BigInt(Math.floor(Date.now() / 1000)) + QUOTE_VALIDITY_SECS;
    const quoteNonce = crypto.getRandomValues(new Uint8Array(16));
    const payload = buildQuotePayload(BigInt(amount), validUntil, quoteNonce);
    const sig = await signBytes(authority.keyPair.privateKey, payload);

    console.log(`[quote] request ${requestId} → ${amount} lamports, valid +${QUOTE_VALIDITY_SECS}s`);
    sendLine(socket, {
      type: "quote_response",
      requestId,
      amount: amount.toString(),
      paymentMint: "11111111111111111111111111111111",
      validUntil: validUntil.toString(),
      quoteNonce: Buffer.from(quoteNonce).toString("hex"),
      signature: Buffer.from(sig).toString("hex"),
      providerAuthority: authority.address,
      qvacPeerId: qvacPeerIdHex,
    });
    return;
  }

  if (msg.type === "job_created") {
    const { requestId, jobPda, requestHash } = msg;
    console.log(`[quote] job created ${jobPda} (req ${requestId})`);

    const maybeJob = await fetchMaybeJobOnChain(rpc, jobPda);
    if (!maybeJob.exists) {
      console.error(`[quote] job_created: PDA ${jobPda} not found on-chain`);
      return;
    }
    const job = maybeJob.data;
    if (job.state !== 0 /* Pending */) {
      console.error(`[quote] job_created: unexpected state ${job.state} for ${jobPda}`);
      return;
    }
    if (job.provider !== providerPda) {
      console.error(`[quote] job_created: provider mismatch — got ${job.provider}, expected ${providerPda}`);
      return;
    }
    const storedHash = Buffer.from(job.requestHash).toString("hex");
    if (storedHash !== requestHash) {
      console.error(`[quote] job_created: requestHash mismatch for ${jobPda}`);
      return;
    }

    sendLine(socket, { type: "job_ack", requestId });
    return;
  }

  if (msg.type === "response_observed") {
    const { jobPda, responseHash } = msg;
    if (typeof responseHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(responseHash)) {
      console.error(`[quote] response_observed: malformed responseHash for ${jobPda}`);
      return;
    }
    console.log(`[quote] response observed ${jobPda}: ${responseHash.slice(0, 16)}…`);
    const responseHashBytes = new Uint8Array(Buffer.from(responseHash, "hex"));
    await submitProviderComplete({
      rpc,
      sendAndConfirm,
      authority,
      jobPda,
      providerPda,
      responseHash: responseHashBytes,
    });
    return;
  }
}

/**
 * Open a Hyperswarm server for the quote channel.
 * topic = SHA256("qvac-quote-v1:" + authority.address)
 * Returns the Hyperswarm instance (call swarm.destroy() to shut down).
 */
export async function startQuoteChannel({ authority, providerPda, qvacPeerId, amount = 10_000, rpc, sendAndConfirm }) {
  const qvacPeerIdHex = Buffer.from(qvacPeerId).toString("hex");
  const topic = await computeTopic(authority.address);
  const ctx = { authority, providerPda, qvacPeerIdHex, amount, rpc, sendAndConfirm };

  const swarm = new Hyperswarm();

  swarm.on("connection", (socket) => {
    let buf = "";
    socket.on("data", async (chunk) => {
      buf += chunk.toString();
      if (buf.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        await handleMessage(socket, msg, ctx).catch((err) =>
          console.error("[quote] handler error:", err.message),
        );
      }
    });
    socket.on("error", () => {});
  });

  const discovery = swarm.join(topic, { server: true, client: false });
  await discovery.flushed();
  console.log(`Quote channel: open (authority ${authority.address})`);
  return swarm;
}
