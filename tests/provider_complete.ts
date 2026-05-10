import assert from "assert";
import {
  generateKeyPair,
  createSignerFromKeyPair,
  generateKeyPairSigner,
  type Instruction,
} from "@solana/kit";
import {
  getProviderCompleteInstructionAsync,
  fetchJob,
  findJobPda,
  QVAC_MARKETPLACE_ERROR__JOB_NOT_PENDING,
  QVAC_MARKETPLACE_ERROR__PROVIDER_MISMATCH,
  QVAC_MARKETPLACE_ERROR__PROVIDER_AUTHORITY_MISMATCH,
  QVAC_MARKETPLACE_ERROR__INVALID_RESPONSE_HASH,
} from "../clients/js/src/generated";
import { JobState } from "../clients/js/src/generated/types/jobState";
import {
  rpc,
  airdrop,
  sendTx,
  expectCustomError,
  setupProvider,
  setupJob,
} from "./helpers";

const RESPONSE_HASH = new Uint8Array(32).fill(0xca);

describe("provider_complete", () => {
  let ctx: Awaited<ReturnType<typeof setupProvider>>;
  let consumer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let jobPda: string;

  before(async () => {
    ctx = await setupProvider(1); // bit 0 = Completion
    consumer = await generateKeyPairSigner();
    await airdrop(consumer.address);
    jobPda = await setupJob(consumer, ctx.providerPda, ctx.keyPair, 0n);
  });

  it("transitions job from Pending to ProviderDone", async () => {
    const ix = await getProviderCompleteInstructionAsync({
      job: jobPda as any,
      authority: ctx.providerSigner,
      responseHash: RESPONSE_HASH,
    });
    await sendTx(ctx.providerSigner, [ix as unknown as Instruction]);

    const account = await fetchJob(rpc, jobPda as any);
    assert.strictEqual(account.data.state, JobState.ProviderDone);
    assert.deepEqual(Array.from(account.data.responseHash), Array.from(RESPONSE_HASH));
    assert.ok(account.data.providerDoneAt > 0n);
  });

  it("rejects completing a job that is already ProviderDone", async () => {
    // jobPda is now in ProviderDone state from the previous test
    await expectCustomError(async () => {
      const ix = await getProviderCompleteInstructionAsync({
        job: jobPda as any,
        authority: ctx.providerSigner,
        responseHash: RESPONSE_HASH,
      });
      await sendTx(ctx.providerSigner, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__JOB_NOT_PENDING);
  });

  it("rejects all-zero response_hash", async () => {
    // Fresh job in Pending state
    const freshConsumer = await generateKeyPairSigner();
    await airdrop(freshConsumer.address);
    const freshJob = await setupJob(freshConsumer, ctx.providerPda, ctx.keyPair, 1n);

    await expectCustomError(async () => {
      const ix = await getProviderCompleteInstructionAsync({
        job: freshJob as any,
        authority: ctx.providerSigner,
        responseHash: new Uint8Array(32), // all zeros
      });
      await sendTx(ctx.providerSigner, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__INVALID_RESPONSE_HASH);
  });

  it("rejects wrong provider authority", async () => {
    const freshConsumer = await generateKeyPairSigner();
    await airdrop(freshConsumer.address);
    const freshJob = await setupJob(freshConsumer, ctx.providerPda, ctx.keyPair, 2n);

    // A different signer trying to call provider_complete
    const wrongAuthority = await createSignerFromKeyPair(await generateKeyPair());
    await airdrop(wrongAuthority.address);

    try {
      const ix = await getProviderCompleteInstructionAsync({
        job: freshJob as any,
        provider: ctx.providerPda,
        authority: wrongAuthority,
        responseHash: RESPONSE_HASH,
      });
      await sendTx(wrongAuthority, [ix as unknown as Instruction]);
      assert.fail("Expected wrong-authority complete to fail");
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      // ProviderAuthorityMismatch OR seeds constraint failure — both correct
      assert.ok(true);
    }
  });

  it("rejects mismatched provider PDA", async () => {
    const freshConsumer = await generateKeyPairSigner();
    await airdrop(freshConsumer.address);
    const freshJob = await setupJob(freshConsumer, ctx.providerPda, ctx.keyPair, 3n);

    // Register a second provider and try to complete with it
    const otherCtx = await setupProvider(1);

    await expectCustomError(async () => {
      const ix = await getProviderCompleteInstructionAsync({
        job: freshJob as any,
        provider: otherCtx.providerPda, // wrong provider
        authority: otherCtx.providerSigner,
        responseHash: RESPONSE_HASH,
      });
      await sendTx(otherCtx.providerSigner, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__PROVIDER_MISMATCH);
  });
});
