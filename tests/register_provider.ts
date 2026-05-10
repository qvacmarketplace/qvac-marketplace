import assert from "assert";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
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
  type Address,
  type TransactionSigner,
  type Instruction,
} from "@solana/kit";
import {
  getRegisterProviderInstructionAsync,
  fetchProvider,
  findProviderPda,
  QVAC_MARKETPLACE_ERROR__NAME_TOO_SHORT,
  QVAC_MARKETPLACE_ERROR__NAME_TOO_LONG,
  QVAC_MARKETPLACE_ERROR__NO_TASK_TYPES_SPECIFIED,
  QVAC_MARKETPLACE_ERROR__INVALID_TASK_TYPE,
  QVAC_MARKETPLACE_ERROR__INVALID_QVAC_PEER_ID,
} from "../clients/js/src/generated";

const RPC_URL = "http://localhost:8899";
const WS_URL = "ws://localhost:8900";

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

async function airdrop(address: Address, sol = 2): Promise<void> {
  const sig = await rpc
    .requestAirdrop(address, lamports(BigInt(sol) * 1_000_000_000n))
    .send();
  // Poll getSignatureStatuses until confirmed
  for (let i = 0; i < 30; i++) {
    const { value: statuses } = await rpc.getSignatureStatuses([sig]).send();
    if (statuses[0] && statuses[0].confirmationStatus === "confirmed") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Airdrop to ${address} not confirmed after 15s`);
}

async function sendTx(
  feePayer: TransactionSigner,
  ixs: Instruction[],
): Promise<void> {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], {
    commitment: "confirmed",
  });
}

function extractCustomErrorCode(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const err = e as Record<string, unknown>;
  if (isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
    return (err.context as Record<string, number> | undefined)?.code;
  }
  if (err.cause !== undefined) return extractCustomErrorCode(err.cause);
  return undefined;
}

async function expectCustomError(
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

describe("register_provider", () => {
  let authority: TransactionSigner;

  before(async () => {
    authority = await generateKeyPairSigner();
    await airdrop(authority.address);
  });

  it("registers a provider successfully", async () => {
    const qvacPeerId = new Uint8Array(32).fill(0xab);
    const ix = await getRegisterProviderInstructionAsync({
      authority,
      name: "my-provider",
      taskTypes: 1, // bit 0 = Completion
      qvacPeerId,
    });

    await sendTx(authority, [ix as unknown as Instruction]);

    const [providerPda] = await findProviderPda({ authority: authority.address });
    const account = await fetchProvider(rpc, providerPda);

    assert.strictEqual(account.data.name, "my-provider");
    assert.strictEqual(account.data.taskTypes, 1);
    assert.strictEqual(account.data.authority, authority.address);
    assert.strictEqual(account.data.version, 1);
    assert.strictEqual(account.data.jobsCompleted, 0n);
    assert.strictEqual(account.data.totalEarned, 0n);
    assert.deepEqual(
      Array.from(account.data.qvacPeerId),
      Array.from(qvacPeerId),
    );
  });

  it("rejects name shorter than 3 characters", async () => {
    const signer = await generateKeyPairSigner();
    await airdrop(signer.address);

    await expectCustomError(async () => {
      const ix = await getRegisterProviderInstructionAsync({
        authority: signer,
        name: "ab",
        taskTypes: 1,
        qvacPeerId: new Uint8Array(32),
      });
      await sendTx(signer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__NAME_TOO_SHORT);
  });

  it("rejects name longer than 50 characters", async () => {
    const signer = await generateKeyPairSigner();
    await airdrop(signer.address);

    await expectCustomError(async () => {
      const ix = await getRegisterProviderInstructionAsync({
        authority: signer,
        name: "a".repeat(51),
        taskTypes: 1,
        qvacPeerId: new Uint8Array(32),
      });
      await sendTx(signer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__NAME_TOO_LONG);
  });

  it("rejects zero task_types bitmask", async () => {
    const signer = await generateKeyPairSigner();
    await airdrop(signer.address);

    await expectCustomError(async () => {
      const ix = await getRegisterProviderInstructionAsync({
        authority: signer,
        name: "valid-name",
        taskTypes: 0,
        qvacPeerId: new Uint8Array(32),
      });
      await sendTx(signer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__NO_TASK_TYPES_SPECIFIED);
  });

  it("rejects duplicate registration for the same authority", async () => {
    const ix = await getRegisterProviderInstructionAsync({
      authority,
      name: "my-provider",
      taskTypes: 1,
      qvacPeerId: new Uint8Array(32).fill(0xab),
    });

    try {
      await sendTx(authority, [ix as unknown as Instruction]);
      assert.fail("Expected duplicate registration to fail");
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      // Account already initialized — Anchor's `init` fails at the system program level
      assert.ok(true, "Duplicate registration correctly rejected");
    }
  });

  it("rejects task_types bitmask with bits above TaskType::MAX (bit 9)", async () => {
    const signer = await generateKeyPairSigner();
    await airdrop(signer.address);

    await expectCustomError(async () => {
      const ix = await getRegisterProviderInstructionAsync({
        authority: signer,
        name: "valid-name",
        taskTypes: 0x0400, // bit 10 — above MAX
        qvacPeerId: new Uint8Array(32).fill(0x01),
      });
      await sendTx(signer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__INVALID_TASK_TYPE);
  });

  it("rejects all-zero qvac_peer_id", async () => {
    const signer = await generateKeyPairSigner();
    await airdrop(signer.address);

    await expectCustomError(async () => {
      const ix = await getRegisterProviderInstructionAsync({
        authority: signer,
        name: "valid-name",
        taskTypes: 1,
        qvacPeerId: new Uint8Array(32), // all zeros
      });
      await sendTx(signer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__INVALID_QVAC_PEER_ID);
  });
});
