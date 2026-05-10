import assert from "assert";
import { generateKeyPairSigner, type Instruction } from "@solana/kit";
import {
  getConsumerConfirmInstruction,
  getProviderCompleteInstructionAsync,
  fetchProvider,
  QVAC_MARKETPLACE_ERROR__JOB_NOT_PROVIDER_DONE,
  QVAC_MARKETPLACE_ERROR__CONFIRM_WINDOW_NOT_ELAPSED,
  QVAC_MARKETPLACE_ERROR__PROVIDER_MISMATCH,
  QVAC_MARKETPLACE_ERROR__CONSUMER_ACCOUNT_MISMATCH,
  QVAC_MARKETPLACE_ERROR__PROVIDER_AUTHORITY_ACCOUNT_MISMATCH,
} from "../clients/js/src/generated";
import {
  rpc,
  airdrop,
  sendTx,
  expectCustomError,
  setupProvider,
  setupJob,
} from "./helpers";

async function makeProviderDoneJob(
  ctx: Awaited<ReturnType<typeof setupProvider>>,
  nonce: bigint,
): Promise<{ consumer: Awaited<ReturnType<typeof generateKeyPairSigner>>; jobPda: string }> {
  const consumer = await generateKeyPairSigner();
  await airdrop(consumer.address);
  const jobPda = await setupJob(consumer, ctx.providerPda, ctx.keyPair, nonce);

  const completeIx = await getProviderCompleteInstructionAsync({
    job: jobPda as any,
    authority: ctx.providerSigner,
    responseHash: new Uint8Array(32).fill(0x11),
  });
  await sendTx(ctx.providerSigner, [completeIx as unknown as Instruction]);

  return { consumer, jobPda };
}

describe("consumer_confirm", () => {
  let ctx: Awaited<ReturnType<typeof setupProvider>>;

  before(async () => {
    ctx = await setupProvider(1);
  });

  it("consumer confirms immediately — pays provider and closes job", async () => {
    const { consumer, jobPda } = await makeProviderDoneJob(ctx, 0n);

    const providerBefore = await fetchProvider(rpc, ctx.providerPda);
    const jobsCompletedBefore = providerBefore.data.jobsCompleted;
    const totalEarnedBefore = providerBefore.data.totalEarned;

    const ix = getConsumerConfirmInstruction({
      job: jobPda as any,
      provider: ctx.providerPda,
      consumer: consumer.address,
      providerAuthority: ctx.providerSigner.address,
      signer: consumer, // consumer may confirm any time
    });
    await sendTx(consumer, [ix as unknown as Instruction]);

    const providerAfter = await fetchProvider(rpc, ctx.providerPda);
    assert.strictEqual(
      providerAfter.data.jobsCompleted,
      jobsCompletedBefore + 1n,
    );
    assert.ok(providerAfter.data.totalEarned > totalEarnedBefore);
  });

  it.skip(
    "auto-releases to provider after CONFIRM_WINDOW (300s) — requires clock manipulation",
    // Omitted: CONFIRM_WINDOW = 300s cannot be fast-forwarded on a live validator.
    // Cover via litesvm Rust tests.
    async () => {},
  );

  it("rejects confirm when job is still Pending (not ProviderDone)", async () => {
    const freshConsumer = await generateKeyPairSigner();
    await airdrop(freshConsumer.address);
    const pendingJob = await setupJob(freshConsumer, ctx.providerPda, ctx.keyPair, 10n);

    await expectCustomError(async () => {
      const ix = getConsumerConfirmInstruction({
        job: pendingJob as any,
        provider: ctx.providerPda,
        consumer: freshConsumer.address,
        providerAuthority: ctx.providerSigner.address,
        signer: freshConsumer,
      });
      await sendTx(freshConsumer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__JOB_NOT_PROVIDER_DONE);
  });

  it("rejects third-party confirm before CONFIRM_WINDOW elapses", async () => {
    const { consumer, jobPda } = await makeProviderDoneJob(ctx, 20n);
    const thirdParty = await generateKeyPairSigner();
    await airdrop(thirdParty.address);

    await expectCustomError(async () => {
      const ix = getConsumerConfirmInstruction({
        job: jobPda as any,
        provider: ctx.providerPda,
        consumer: consumer.address,
        providerAuthority: ctx.providerSigner.address,
        signer: thirdParty, // not the consumer, and window hasn't elapsed
      });
      await sendTx(thirdParty, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__CONFIRM_WINDOW_NOT_ELAPSED);
  });

  it("rejects wrong provider PDA", async () => {
    const { consumer, jobPda } = await makeProviderDoneJob(ctx, 30n);
    const otherCtx = await setupProvider(1);

    await expectCustomError(async () => {
      const ix = getConsumerConfirmInstruction({
        job: jobPda as any,
        provider: otherCtx.providerPda, // wrong provider
        consumer: consumer.address,
        providerAuthority: ctx.providerSigner.address,
        signer: consumer,
      });
      await sendTx(consumer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__PROVIDER_MISMATCH);
  });

  it("rejects wrong consumer account", async () => {
    const { consumer, jobPda } = await makeProviderDoneJob(ctx, 40n);
    const impostor = await generateKeyPairSigner();
    await airdrop(impostor.address);

    await expectCustomError(async () => {
      const ix = getConsumerConfirmInstruction({
        job: jobPda as any,
        provider: ctx.providerPda,
        consumer: impostor.address, // wrong consumer address
        providerAuthority: ctx.providerSigner.address,
        signer: consumer,
      });
      await sendTx(consumer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__CONSUMER_ACCOUNT_MISMATCH);
  });

  it("rejects wrong provider_authority account", async () => {
    const { consumer, jobPda } = await makeProviderDoneJob(ctx, 50n);
    const wrongAuthority = await generateKeyPairSigner();

    await expectCustomError(async () => {
      const ix = getConsumerConfirmInstruction({
        job: jobPda as any,
        provider: ctx.providerPda,
        consumer: consumer.address,
        providerAuthority: wrongAuthority.address, // wrong payout address
        signer: consumer,
      });
      await sendTx(consumer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__PROVIDER_AUTHORITY_ACCOUNT_MISMATCH);
  });
});
