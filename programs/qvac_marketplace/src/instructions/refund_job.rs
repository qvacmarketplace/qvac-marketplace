use anchor_lang::prelude::*;

use crate::constants::JOB_TIMEOUT;
use crate::error::MarketplaceError;
use crate::state::{Job, JobState, JOB_VERSION};

/// Accounts for `refund_job`.
#[derive(Accounts)]
pub struct RefundJob<'info> {
    /// Job to refund. `has_one = consumer` enforces the signer is the
    /// original consumer; only the original consumer can refund.
    /// State and timeout checks live in the handler body to provide
    /// granular error variants.
    #[account(
        mut,
        seeds = [Job::SEED_PREFIX, consumer.key().as_ref(), &job.nonce.to_le_bytes()],
        bump = job.bump,
        constraint = job.version == JOB_VERSION
            @ MarketplaceError::UnsupportedAccountVersion,
        constraint = job.payment_mint == Pubkey::default()
            @ MarketplaceError::PaymentMintMismatch,
        has_one = consumer @ MarketplaceError::UnauthorizedRefund,
        close = consumer,
    )]
    pub job: Account<'info, Job>,

    /// Original consumer. Receives both the escrowed `amount` (drained
    /// manually below) and the rent-exempt minimum (via Anchor close).
    #[account(mut)]
    pub consumer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Refund the consumer's escrow once the timeout has elapsed.
///
/// Reachable only when the job is still in `Pending` state — if the
/// provider has already delivered (`ProviderDone`), refund is blocked
/// and the consumer must use `consumer_confirm` instead. Distinct error
/// variants distinguish the three failure modes (state-blocked,
/// terminal-state, timeout-not-elapsed) for client-side UX.
pub fn handler(ctx: Context<RefundJob>) -> Result<()> {
    match ctx.accounts.job.state {
        JobState::Pending => {}
        JobState::ProviderDone => {
            return Err(error!(MarketplaceError::RefundBlockedProviderDelivered));
        }
        _ => return Err(error!(MarketplaceError::JobNotRefundable)),
    }

    let now = Clock::get()?.unix_timestamp;
    let deadline = ctx
        .accounts
        .job
        .created_at
        .checked_add(JOB_TIMEOUT)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;
    require!(
        now >= deadline,
        MarketplaceError::RefundTimeoutNotElapsed
    );

    // Drain `amount` lamports: Job → consumer. Anchor's `close = consumer`
    // sweeps the remaining rent-exempt minimum to consumer at account-exit.
    let amount = ctx.accounts.job.amount;
    let job_info = ctx.accounts.job.to_account_info();
    let consumer_info = ctx.accounts.consumer.to_account_info();

    let new_job_lamports = job_info
        .lamports()
        .checked_sub(amount)
        .ok_or(MarketplaceError::InsufficientEscrow)?;
    **job_info.try_borrow_mut_lamports()? = new_job_lamports;

    let new_consumer_lamports = consumer_info
        .lamports()
        .checked_add(amount)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;
    **consumer_info.try_borrow_mut_lamports()? = new_consumer_lamports;

    ctx.accounts.job.state = JobState::Refunded;

    Ok(())
}
