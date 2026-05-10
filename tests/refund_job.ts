import assert from "assert";
import { generateKeyPairSigner, type Instruction } from "@solana/kit";
import {
  getRefundJobInstruction,
  getProviderCompleteInstructionAsync,
  getConsumerConfirmInstruction,
  QVAC_MARKETPLACE_ERROR__REFUND_TIMEOUT_NOT_ELAPSED,
  QVAC_MARKETPLACE_ERROR__REFUND_BLOCKED_PROVIDER_DELIVERED,
  QVAC_MARKETPLACE_ERROR__JOB_NOT_REFUNDABLE,
  QVAC_MARKETPLACE_ERROR__UNAUTHORIZED_REFUND,
} from "../clients/js/src/generated";
import { airdrop, sendTx, expectCustomError, setupProvider, setupJob } from "./helpers";

describe("refund_job", () => {
  let ctx: Awaited<ReturnType<typeof setupProvider>>;
  let consumer: Awaited<ReturnType<typeof generateKeyPairSigner>>;

  before(async () => {
    ctx = await setupProvider(1);
    consumer = await generateKeyPairSigner();
    await airdrop(consumer.address);
  });

  it.skip(
    "refunds consumer after JOB_TIMEOUT (600s) — requires clock manipulation",
    // Test omitted: JOB_TIMEOUT = 600s cannot be fast-forwarded on a live validator.
    // Cover this path via litesvm Rust tests (can set Clock.unix_timestamp directly).
    async () => {},
  );

  it("rejects refund before JOB_TIMEOUT elapses", async () => {
    const jobPda = await setupJob(consumer, ctx.providerPda, ctx.keyPair, 100n);

    await expectCustomError(async () => {
      const ix = getRefundJobInstruction({
        job: jobPda as any,
        consumer,
      });
      await sendTx(consumer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__REFUND_TIMEOUT_NOT_ELAPSED);
  });

  it("rejects refund when provider has already delivered (ProviderDone)", async () => {
    const freshConsumer = await generateKeyPairSigner();
    await airdrop(freshConsumer.address);
    const jobPda = await setupJob(freshConsumer, ctx.providerPda, ctx.keyPair, 200n);

    // Move job to ProviderDone
    const completeIx = await getProviderCompleteInstructionAsync({
      job: jobPda as any,
      authority: ctx.providerSigner,
      responseHash: new Uint8Array(32).fill(0xbe),
    });
    await sendTx(ctx.providerSigner, [completeIx as unknown as Instruction]);

    await expectCustomError(async () => {
      const ix = getRefundJobInstruction({
        job: jobPda as any,
        consumer: freshConsumer,
      });
      await sendTx(freshConsumer, [ix as unknown as Instruction]);
    }, QVAC_MARKETPLACE_ERROR__REFUND_BLOCKED_PROVIDER_DELIVERED);
  });

  it("rejects refund when job is already Completed", async () => {
    const freshConsumer = await generateKeyPairSigner();
    await airdrop(freshConsumer.address);
    const jobPda = await setupJob(freshConsumer, ctx.providerPda, ctx.keyPair, 300n);

    // provider_complete → consumer_confirm → Completed
    const completeIx = await getProviderCompleteInstructionAsync({
      job: jobPda as any,
      authority: ctx.providerSigner,
      responseHash: new Uint8Array(32).fill(0xdf),
    });
    await sendTx(ctx.providerSigner, [completeIx as unknown as Instruction]);

    const confirmIx = getConsumerConfirmInstruction({
      job: jobPda as any,
      provider: ctx.providerPda,
      consumer: freshConsumer.address,
      providerAuthority: ctx.providerSigner.address,
      signer: freshConsumer,
    });
    await sendTx(freshConsumer, [confirmIx as unknown as Instruction]);

    // Job is now closed (Completed). Trying to refund should fail with
    // AccountNotFound / discriminator mismatch since the account is gone.
    try {
      const ix = getRefundJobInstruction({ job: jobPda as any, consumer: freshConsumer });
      await sendTx(freshConsumer, [ix as unknown as Instruction]);
      assert.fail("Expected refund of Completed job to fail");
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      assert.ok(true, "Correctly rejected refund of closed job");
    }
  });

  it("rejects refund by a non-consumer signer", async () => {
    const jobPda = await setupJob(consumer, ctx.providerPda, ctx.keyPair, 400n);
    const impostor = await generateKeyPairSigner();
    await airdrop(impostor.address);

    // UNAUTHORIZED_REFUND (6020) is unreachable in practice:
    // the seed constraint (seeds = ["job", consumer.key(), nonce]) fires first
    // with a ConstraintSeeds (2006) error whenever consumer.key() ≠ job.consumer.
    // has_one = consumer @ UnauthorizedRefund is defense-in-depth.
    // We just assert the tx fails.
    try {
      const ix = getRefundJobInstruction({
        job: jobPda as any,
        consumer: impostor, // wrong consumer
      });
      await sendTx(impostor, [ix as unknown as Instruction]);
      assert.fail("Expected non-consumer refund to fail");
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      assert.ok(true);
    }
  });
});
