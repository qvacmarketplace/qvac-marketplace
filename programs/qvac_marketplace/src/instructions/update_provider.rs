use anchor_lang::prelude::*;

use crate::constants::{MAX_NAME_LEN, MIN_NAME_LEN};
use crate::error::MarketplaceError;
use crate::state::{Provider, PROVIDER_VERSION};

/// Accounts for `update_provider`.
#[derive(Accounts)]
pub struct UpdateProvider<'info> {
    /// Existing Provider PDA. `has_one` enforces that the signer matches
    /// `provider.authority`. Version check rejects accounts created by a
    /// future incompatible build.
    #[account(
        mut,
        seeds = [Provider::SEED_PREFIX, authority.key().as_ref()],
        bump = provider.bump,
        has_one = authority @ MarketplaceError::UnauthorizedProvider,
        constraint = provider.version == PROVIDER_VERSION
            @ MarketplaceError::UnsupportedAccountVersion,
    )]
    pub provider: Account<'info, Provider>,

    pub authority: Signer<'info>,
}

/// Update the mutable fields of an existing Provider.
///
/// MVP scope: `name` and `task_types`. Rotation of `qvac_peer_id` is
/// reserved for a future V2 instruction (`update_provider_peer_id`).
pub fn handler(
    ctx: Context<UpdateProvider>,
    name: String,
    task_types: u16,
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

    let provider = &mut ctx.accounts.provider;
    provider.name = name;
    provider.task_types = task_types;

    Ok(())
}
