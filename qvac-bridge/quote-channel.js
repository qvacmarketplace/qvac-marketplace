import Hyperswarm from "hyperswarm";
import { randomBytes } from "crypto";

const QUOTE_TOPIC_PREFIX = "qvac-quote-v1:";
const CONNECT_TIMEOUT_MS = 60_000;
// Hard cap on a single line-delimited message — protects against a peer
// that streams data without ever sending '\n' (would otherwise grow the
// per-socket buffer without bound).
const MAX_LINE_BYTES = 64 * 1024;

async function computeTopic(authorityAddress) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(QUOTE_TOPIC_PREFIX + authorityAddress),
  );
  return Buffer.from(hash);
}

// Shared Hyperswarm instance — one per bridge process.
let _swarm = null;
// Map topicHex → { resolve, reject, timer } for pending connectToProvider calls.
const _pendingConnects = new Map();

function getSwarm() {
  if (_swarm) return _swarm;
  _swarm = new Hyperswarm();
  _swarm.on("connection", (socket, peerInfo) => {
    for (const t of peerInfo.topics) {
      const hex = Buffer.from(t).toString("hex");
      const pending = _pendingConnects.get(hex);
      if (pending) {
        _pendingConnects.delete(hex);
        clearTimeout(pending.timer);
        pending.resolve({ socket, topicHex: hex });
        break;
      }
    }
  });
  return _swarm;
}

/**
 * Dial the quote channel of a provider identified by their Solana authority address.
 * Returns a QuoteConnection that multiplexes the line-delimited JSON protocol.
 * @param {string} providerAuthority - Solana address of the provider
 * @param {number} [timeoutMs] - connection timeout in ms (default 60s)
 */
export async function connectToProvider(providerAuthority, timeoutMs = CONNECT_TIMEOUT_MS) {
  const swarm = getSwarm();
  const topic = await computeTopic(providerAuthority);
  const topicHex = topic.toString("hex");

  const { socket } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pendingConnects.delete(topicHex);
      reject(new Error(`Quote channel connect timeout for ${providerAuthority}`));
    }, timeoutMs);
    _pendingConnects.set(topicHex, { resolve, reject, timer });
    swarm.join(topic, { server: false, client: true });
  });

  return new QuoteConnection(socket, providerAuthority);
}

export async function destroySwarm() {
  if (_swarm) {
    await _swarm.destroy();
    _swarm = null;
  }
}

class QuoteConnection {
  constructor(socket, providerAuthority) {
    this.providerAuthority = providerAuthority;
    this._socket = socket;
    this._pending = new Map(); // requestId → { resolve, reject }
    this._buf = "";

    socket.on("data", (chunk) => {
      this._buf += chunk.toString();
      if (this._buf.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      const lines = this._buf.split("\n");
      this._buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        this._dispatch(msg);
      }
    });

    socket.on("error", () => {});
    socket.on("close", () => {
      for (const { reject } of this._pending.values()) {
        reject(new Error("Quote channel disconnected"));
      }
      this._pending.clear();
    });
  }

  _send(obj) {
    if (!this._socket.destroyed) {
      this._socket.write(JSON.stringify(obj) + "\n");
    }
  }

  _dispatch(msg) {
    const pend = this._pending.get(msg.requestId);
    if (!pend) return;
    if (msg.type === "quote_response" || msg.type === "job_ack") {
      this._pending.delete(msg.requestId);
      pend.resolve(msg);
    } else if (msg.type === "quote_rejected") {
      this._pending.delete(msg.requestId);
      pend.reject(new Error(`Provider rejected quote request: ${msg.reason ?? "unknown"}`));
    }
  }

  /**
   * Request a price quote from the provider.
   * Returns the full quote_response message including amount, validUntil,
   * quoteNonce, signature, providerAuthority, qvacPeerId.
   */
  requestQuote(consumerAuthority) {
    const requestId = randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject });
      this._send({ type: "quote_request", requestId, consumerAuthority });
    });
  }

  /**
   * Notify the provider that the on-chain job was created.
   * Returns the job_ack (provider confirmed they saw it).
   */
  notifyJobCreated(requestId, jobPda, requestHashHex) {
    return new Promise((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject });
      this._send({ type: "job_created", requestId, jobPda, requestHash: requestHashHex });
    });
  }

  /** Notify the provider that the response was observed (Phase 4). */
  notifyResponseObserved(jobPda, responseHashHex) {
    this._send({ type: "response_observed", jobPda, responseHash: responseHashHex });
  }

  destroy() {
    this._socket.destroy();
  }
}
