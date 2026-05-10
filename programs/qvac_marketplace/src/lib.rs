use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

pub use constants::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("6rbgdrQdxziVC25kt1Xmtz36ApiLdUVGpdyDcssmgoec");

#[program]
pub mod qvac_marketplace {
    use super::*;

    /// Register a new AI inference provider.
    /// One provider per authority wallet (PDA seeded by authority).
    pub fn register_provider(
        ctx: Context<RegisterProvider>,
        name: String,
        task_types: u16,
        qvac_peer_id: [u8; 32],
    ) -> Result<()> {
        instructions::register_provider::handler(ctx, name, task_types, qvac_peer_id)
    }

    /// Update a provider's mutable fields (name, task_types).
    pub fn update_provider(
        ctx: Context<UpdateProvider>,
        name: String,
        task_types: u16,
    ) -> Result<()> {
        instructions::update_provider::handler(ctx, name, task_types)
    }

    /// Rotate the provider's QVAC DHT peer ID.
    /// Called when the provider restarts with a new Hyperswarm seed.
    pub fn rotate_peer_id(
        ctx: Context<RotatePeerId>,
        qvac_peer_id: [u8; 32],
    ) -> Result<()> {
        instructions::rotate_peer_id::handler(ctx, qvac_peer_id)
    }

    /// Create an escrowed inference job after verifying the provider's
    /// Ed25519-signed quote (carried in a sibling instruction).
    pub fn create_job(
        ctx: Context<CreateJob>,
        request_hash: [u8; 32],
        nonce: u64,
        amount: u64,
        payment_mint: Pubkey,
        quote_signature: [u8; 64],
        task_type: u8,
        valid_until: i64,
        quote_nonce: [u8; 16],
    ) -> Result<()> {
        instructions::create_job::handler(
            ctx,
            request_hash,
            nonce,
            amount,
            payment_mint,
            quote_signature,
            task_type,
            valid_until,
            quote_nonce,
        )
    }

    /// Provider submits the response_hash, transitioning Job from
    /// Pending to ProviderDone and starting the auto-release window.
    pub fn provider_complete(
        ctx: Context<ProviderComplete>,
        response_hash: [u8; 32],
    ) -> Result<()> {
        instructions::provider_complete::handler(ctx, response_hash)
    }

    /// Release escrow to the provider authority. Callable by the consumer
    /// any time after ProviderDone, or by anyone after CONFIRM_WINDOW.
    /// Closes the Job PDA; rent returns to consumer.
    pub fn consumer_confirm(ctx: Context<ConsumerConfirm>) -> Result<()> {
        instructions::consumer_confirm::handler(ctx)
    }

    /// Refund escrow to the consumer once JOB_TIMEOUT has elapsed and
    /// the provider has not delivered. Closes the Job PDA.
    pub fn refund_job(ctx: Context<RefundJob>) -> Result<()> {
        instructions::refund_job::handler(ctx)
    }
}
