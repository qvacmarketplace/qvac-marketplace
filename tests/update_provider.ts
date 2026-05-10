import assert from "assert";
import {
  generateKeyPair,
  createSignerFromKeyPair,
  type Instruction,
} from "@solana/kit";
import {
  getUpdateProviderInstructionAsync,
  fetchProvider,
  QVAC_MARKETPLACE_ERROR__NAME_TOO_SHORT,
  QVAC_MARKETPLACE_ERROR__NAME_TOO_LONG,
  QVAC_MARKETPLACE_ERROR__NO_TASK_TYPES_SPECIFIED,
  QVAC_MARKETPLACE_ERROR__INVALID_TASK_TYPE,
} from "../clients/js/src/generated";
import { rpc, airdrop, sendTx, expectCustomError, setupProvider } from "./helpers";

describe("update_provider", () => {
  let ctx: Awaited<ReturnType<typeof setupProvider>>;

  before(async () => {
    ctx = await setupProvider(1);
  });

  it("updates name and task_types successfully", async () => {
    const ix = await getUpdateProviderInstructionAsync({
      authority: ctx.providerSigner,
      name: "updated-name",
      taskTypes: 3,
    });
    await sendTx(ctx.providerSigner, [ix as unknown as Instruction]);

    const account = await fetchProvider(rpc, ctx.providerPda);
    assert.strictEqual(account.data.name, "updated-name");
    assert.strictEqual(account.data.taskTypes, 3);
  });

  it("rejects name shorter than 3 characters", async () => {
    await expectCustomError(async () => {
      const ix = await getUpdateProviderInstructionAsync({
        authority: ctx.providerSigner,
        name: "ab",
        taskTypes: 1,
      });
      await sendTx(ctx.providerSigner, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__NAME_TOO_SHORT);
  });

  it("rejects name longer than 50 characters", async () => {
    await expectCustomError(async () => {
      const ix = await getUpdateProviderInstructionAsync({
        authority: ctx.providerSigner,
        name: "a".repeat(51),
        taskTypes: 1,
      });
      await sendTx(ctx.providerSigner, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__NAME_TOO_LONG);
  });

  it("rejects zero task_types", async () => {
    await expectCustomError(async () => {
      const ix = await getUpdateProviderInstructionAsync({
        authority: ctx.providerSigner,
        name: "valid-name",
        taskTypes: 0,
      });
      await sendTx(ctx.providerSigner, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__NO_TASK_TYPES_SPECIFIED);
  });

  it("rejects task_types bitmask with bits above TaskType::MAX (bit 9)", async () => {
    await expectCustomError(async () => {
      const ix = await getUpdateProviderInstructionAsync({
        authority: ctx.providerSigner,
        name: "valid-name",
        taskTypes: 0x0400, // bit 10 — above MAX
      });
      await sendTx(ctx.providerSigner, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__INVALID_TASK_TYPE);
  });

  it("rejects update signed by a different authority", async () => {
    // A foreign authority cannot update someone else's provider.
    // The Anchor seed constraint (seeds = [b"provider", authority.key()]) fires
    // before has_one, so the intruder would need a PDA seeded with their own key —
    // which doesn't exist — causing a simulation failure rather than our custom error.
    const intruder = await createSignerFromKeyPair(await generateKeyPair());
    await airdrop(intruder.address);

    try {
      const ix = await getUpdateProviderInstructionAsync({
        provider: ctx.providerPda, // correct PDA
        authority: intruder,       // wrong signer
        name: "evil",
        taskTypes: 1,
      });
      await sendTx(intruder, [ix as unknown as Instruction]);
      assert.fail("Expected foreign-authority update to fail");
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      // Any on-chain rejection is correct — seeds constraint fires
      assert.ok(true);
    }
  });
});
