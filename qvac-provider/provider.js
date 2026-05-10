import { startQVACProvider } from "@qvac/sdk";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createSolanaClients, ensureProviderRegistered } from "./solana.js";
import { startQuoteChannel } from "./quote-channel.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const seed = process.argv[2];
if (seed) {
  process.env["QVAC_HYPERSWARM_SEED"] = seed;
}

if (!process.env["QVAC_HYPERSWARM_SEED"]) {
  const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  process.env["QVAC_HYPERSWARM_SEED"] = generated;
  console.log(`Generated QVAC_HYPERSWARM_SEED=${generated}`);
  console.log(`Add to .env to keep this identity across restarts.\n`);
}

const config = JSON.parse(
  await readFile(resolve(__dirname, "qvac.config.json"), "utf8"),
);
const { name: _name = "my-provider", taskTypes = 1, pricePerRequest = 10_000 } = config.marketplace ?? {};
const name = process.env.PROVIDER_NAME ?? _name;

console.log("Starting QVAC provider...");
const response = await startQVACProvider();

// QVAC publicKey is a 64-char hex string (32-byte Ed25519 hyperdht key).
const qvacPeerId = new Uint8Array(
  response.publicKey.match(/.{2}/g).map((b) => parseInt(b, 16)),
);

console.log(`QVAC peer ID: ${response.publicKey}`);

const solanaClients = createSolanaClients();
const { authority, providerPda } = await ensureProviderRegistered({
  qvacPeerId,
  taskTypes,
  name,
});

console.log(`Authority:    ${authority.address}`);
console.log(`Provider PDA: ${providerPda}`);

await startQuoteChannel({
  authority,
  providerPda,
  qvacPeerId,
  amount: pricePerRequest,
  rpc: solanaClients.rpc,
  sendAndConfirm: solanaClients.sendAndConfirm,
});

console.log("\nRunning... Press Ctrl+C to stop");

process.on("SIGINT", () => {
  console.log("Provider stopped");
  process.exit(0);
});

process.stdin.resume();
