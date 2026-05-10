use anchor_lang::prelude::*;

use crate::constants::{MAX_NAME_LEN, MIN_NAME_LEN};
use crate::error::MarketplaceError;
use crate::state::{Provider, PROVIDER_VERSION};

/// Accounts for `register_provider`.
#[derive(Accounts)]
pub struct RegisterProvider<'info> {
    /// New Provider PDA, seeded by the authority pubkey. Anchor's `init`
    /// constraint enforces single-registration per authority — a second
    /// call with the same authority will fail with `AccountAlreadyInUse`.
    #[account(
        init,
        payer = authority,
        space = 8 + Provider::INIT_SPACE,
        seeds = [Provider::SEED_PREFIX, authority.key().as_ref()],
        bump,
    )]
    pub provider: Account<'info, Provider>,

    /// Wallet registering the provider. Pays for account creation and
    /// becomes the provider's controlling identity.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Initialize a new Provider account.
///
/// Validates that `name` is 3..=50 bytes and `task_types` is non-zero,
/// then writes all fields and stamps `registered_at` from the on-chain
/// clock. Reputation counters start at zero; `reserved` is zeroed for
/// future-version forward compatibility.
pub fn handler(
    ctx: Context<RegisterProvider>,
    name: String,
    task_types: u16,
    qvac_peer_id: [u8; 32],
) -> Result<()> {
    require!(name.len() >= MIN_NAME_LEN, MarketplaceError::NameTooShort);
    require!(name.len() <= MAX_NAME_LEN, MarketplaceError::NameTooLong);
    require!(task_types != 0, MarketplaceError::NoTaskTypesSpecified);
    // Reject bits above TaskType::MAX (bit 9). VALID_MASK = 0b11_1111_1111 = 0x03FF.
    const VALID_MASK: u16 = (1u16 << (crate::state::TaskType::MAX as u32 + 1)) - 1;
    require!(
        task_types & !VALID_MASK == 0,
        MarketplaceError::InvalidTaskType,
    );
    require!(
        qvac_peer_id != [0u8; 32],
        MarketplaceError::InvalidQvacPeerId,
    );

    let now = Clock::get()?.unix_timestamp;

    let provider = &mut ctx.accounts.provider;
    provider.version = PROVIDER_VERSION;
    provider.task_types = task_types;
    provider.authority = ctx.accounts.authority.key();
    provider.qvac_peer_id = qvac_peer_id;
    provider.name = name;
    provider.jobs_completed = 0;
    provider.jobs_disputed = 0;
    provider.total_earned = 0;
    provider.registered_at = now;
    provider.bump = ctx.bumps.provider;
    provider.reserved = [0u8; 30];

    Ok(())
}
