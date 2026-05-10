use anchor_lang::prelude::*;

use crate::error::MarketplaceError;
use crate::state::{Provider, PROVIDER_VERSION};

/// Accounts for `rotate_peer_id`.
#[derive(Accounts)]
pub struct RotatePeerId<'info> {
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

/// Replace the provider's QVAC DHT peer ID.
///
/// Called when the provider restarts with a different Hyperswarm seed.
/// Only the authority that owns the PDA may rotate the key.
pub fn handler(ctx: Context<RotatePeerId>, qvac_peer_id: [u8; 32]) -> Result<()> {
    require!(
        qvac_peer_id != [0u8; 32],
        MarketplaceError::InvalidQvacPeerId,
    );

    ctx.accounts.provider.qvac_peer_id = qvac_peer_id;

    Ok(())
}
