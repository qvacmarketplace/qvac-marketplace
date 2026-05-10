use anchor_lang::prelude::*;

use crate::error::MarketplaceError;
use crate::state::{Job, JobState, Provider, JOB_VERSION};

/// Accounts for `provider_complete`.
#[derive(Accounts)]
pub struct ProviderComplete<'info> {
    /// Job to mark as ProviderDone. Must be in Pending state and bound
    /// to the Provider account passed in. The seed constraint
    /// re-derives the Job PDA from its stored consumer + nonce so a
    /// caller cannot pass an arbitrary look-alike account.
    #[account(
        mut,
        seeds = [Job::SEED_PREFIX, job.consumer.as_ref(), &job.nonce.to_le_bytes()],
        bump = job.bump,
        constraint = job.version == JOB_VERSION
            @ MarketplaceError::UnsupportedAccountVersion,
        constraint = job.state == JobState::Pending
            @ MarketplaceError::JobNotPending,
        constraint = job.provider == provider.key()
            @ MarketplaceError::ProviderMismatch,
        constraint = job.provider_authority == authority.key()
            @ MarketplaceError::ProviderAuthorityMismatch,
    )]
    pub job: Account<'info, Job>,

    /// Provider PDA, re-derived from `authority` so we know the signer
    /// is the legitimate authority for THIS Provider record.
    #[account(
        seeds = [Provider::SEED_PREFIX, authority.key().as_ref()],
        bump = provider.bump,
    )]
    pub provider: Account<'info, Provider>,

    /// Provider authority — must sign and must match `job.provider_authority`.
    pub authority: Signer<'info>,
}

/// Provider declares the job complete by submitting `response_hash`.
///
/// Transitions Job from `Pending` to `ProviderDone` and starts the
/// CONFIRM_WINDOW timer (`provider_done_at = now`). The actual escrow
/// release happens later in `consumer_confirm`.
pub fn handler(ctx: Context<ProviderComplete>, response_hash: [u8; 32]) -> Result<()> {
    require!(
        response_hash != [0u8; 32],
        MarketplaceError::InvalidResponseHash,
    );

    let now = Clock::get()?.unix_timestamp;

    let job = &mut ctx.accounts.job;
    job.response_hash = response_hash;
    job.provider_done_at = now;
    job.state = JobState::ProviderDone;

    Ok(())
}
