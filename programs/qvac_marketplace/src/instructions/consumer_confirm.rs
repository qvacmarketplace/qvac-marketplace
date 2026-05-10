use anchor_lang::prelude::*;

use crate::constants::CONFIRM_WINDOW;
use crate::error::MarketplaceError;
use crate::state::{Job, JobState, Provider, JOB_VERSION};

/// Accounts for `consumer_confirm`.
#[derive(Accounts)]
pub struct ConsumerConfirm<'info> {
    /// Job being settled. Closed after settlement; rent → consumer.
    #[account(
        mut,
        seeds = [Job::SEED_PREFIX, job.consumer.as_ref(), &job.nonce.to_le_bytes()],
        bump = job.bump,
        constraint = job.version == JOB_VERSION
            @ MarketplaceError::UnsupportedAccountVersion,
        constraint = job.state == JobState::ProviderDone
            @ MarketplaceError::JobNotProviderDone,
        constraint = job.payment_mint == Pubkey::default()
            @ MarketplaceError::PaymentMintMismatch,
        close = consumer,
    )]
    pub job: Account<'info, Job>,

    /// Provider whose counters get incremented (`jobs_completed`, `total_earned`).
    /// PDA re-derivation guarantees `provider.authority` matches the seed,
    /// and the constraint binds it to the original Job.
    #[account(
        mut,
        seeds = [Provider::SEED_PREFIX, provider.authority.as_ref()],
        bump = provider.bump,
        constraint = provider.key() == job.provider
            @ MarketplaceError::ProviderMismatch,
    )]
    pub provider: Account<'info, Provider>,

    /// Rent recipient on close. Must equal `job.consumer`. May or may
    /// not be the signer — when the signer is someone else (auto-release),
    /// the consumer still gets the rent back.
    /// CHECK: address-checked against `job.consumer`.
    #[account(
        mut,
        address = job.consumer @ MarketplaceError::ConsumerAccountMismatch,
    )]
    pub consumer: UncheckedAccount<'info>,

    /// Payment recipient. Must equal `job.provider_authority` (snapshotted
    /// at `create_job` so a Provider authority change after the fact does
    /// not redirect funds).
    /// CHECK: address-checked against `job.provider_authority`.
    #[account(
        mut,
        address = job.provider_authority @ MarketplaceError::ProviderAuthorityAccountMismatch,
    )]
    pub provider_authority: UncheckedAccount<'info>,

    /// Either the consumer (any time) or anyone (after CONFIRM_WINDOW).
    /// The window check lives in the handler body.
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Release escrow to the provider authority and close the Job PDA.
///
/// Direct lamport mutation is used to drain `amount` from Job → provider_authority.
/// Using `system_program::transfer` from a PDA would require signer seeds AND
/// would trip the per-instruction rent-exempt guard on the source account.
/// After the drain, Anchor's `close = consumer` constraint sweeps the
/// remaining rent-exempt minimum to consumer at account-exit.
pub fn handler(ctx: Context<ConsumerConfirm>) -> Result<()> {
    // Permission gate: consumer may confirm any time; anyone else must
    // wait for CONFIRM_WINDOW after `provider_done_at`.
    if ctx.accounts.signer.key() != ctx.accounts.job.consumer {
        let now = Clock::get()?.unix_timestamp;
        let release_at = ctx
            .accounts
            .job
            .provider_done_at
            .checked_add(CONFIRM_WINDOW)
            .ok_or(MarketplaceError::ArithmeticOverflow)?;
        require!(now >= release_at, MarketplaceError::ConfirmWindowNotElapsed);
    }

    let amount = ctx.accounts.job.amount;

    // Drain `amount` lamports: Job → provider_authority.
    let job_info = ctx.accounts.job.to_account_info();
    let payout_info = ctx.accounts.provider_authority.to_account_info();

    let new_job_lamports = job_info
        .lamports()
        .checked_sub(amount)
        .ok_or(MarketplaceError::InsufficientEscrow)?;
    **job_info.try_borrow_mut_lamports()? = new_job_lamports;

    let new_payout_lamports = payout_info
        .lamports()
        .checked_add(amount)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;
    **payout_info.try_borrow_mut_lamports()? = new_payout_lamports;

    // Update Provider reputation/earnings counters.
    let provider = &mut ctx.accounts.provider;
    provider.jobs_completed = provider
        .jobs_completed
        .checked_add(1)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;
    provider.total_earned = provider
        .total_earned
        .checked_add(amount)
        .ok_or(MarketplaceError::ArithmeticOverflow)?;

    // No-op in practice: Anchor's `close = consumer` zeros the account on
    // exit, so this write is never read by anyone. Kept for defensive clarity
    // in case future code paths inspect the Job before close.
    ctx.accounts.job.state = JobState::Completed;

    Ok(())
}
