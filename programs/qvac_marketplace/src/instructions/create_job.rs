use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};
use solana_instructions_sysvar::get_instruction_relative;
use solana_sdk_ids::ed25519_program;
use solana_sdk_ids::sysvar::instructions as instructions_sysvar;

use crate::constants::MIN_AMOUNT;
use crate::error::MarketplaceError;
use crate::state::{Job, JobState, Provider, TaskType, JOB_VERSION, PROVIDER_VERSION};

/// Accounts for `create_job`.
#[derive(Accounts)]
#[instruction(request_hash: [u8; 32], nonce: u64)]
pub struct CreateJob<'info> {
    /// New Job PDA. Seeded by `(consumer, nonce)` so the same consumer
    /// can have multiple concurrent jobs without collision.
    #[account(
        init,
        payer = consumer,
        space = 8 + Job::INIT_SPACE,
        seeds = [Job::SEED_PREFIX, consumer.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub job: Account<'info, Job>,

    /// Provider being engaged. The seed constraint re-derives the PDA
    /// from `provider.authority` and rejects any account that wasn't
    /// genuinely created by `register_provider`.
    #[account(
        seeds = [Provider::SEED_PREFIX, provider.authority.as_ref()],
        bump = provider.bump,
        constraint = provider.version == PROVIDER_VERSION
            @ MarketplaceError::UnsupportedAccountVersion,
    )]
    pub provider: Account<'info, Provider>,

    /// Consumer paying for the job. Funds the escrow and the Job PDA rent.
    #[account(mut)]
    pub consumer: Signer<'info>,

    /// Instructions sysvar — used to read the Ed25519Program sibling
    /// instruction that carries the provider's signed quote.
    /// CHECK: address-checked against the canonical instructions sysvar id.
    #[account(address = instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Create an escrowed inference job.
///
/// Verifies the provider's signed quote (Ed25519 sibling instruction),
/// transfers `amount` lamports from the consumer to the Job PDA, and
/// initializes the Job to `Pending`.
///
/// MVP: SOL only. Any non-default `payment_mint` returns `PaymentMintMismatch`.
///
/// # Quote binding
/// The signed payload binds `amount`, `payment_mint`, `valid_until`, and
/// `quote_nonce` but NOT `request_hash`. Quotes are flat-rate price
/// commitments valid for any `request_hash` until `valid_until` — providers
/// must use short validity windows (≤5 min) to limit exposure.
#[allow(clippy::too_many_arguments)]
pub fn handler(
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
    require!(
        request_hash != [0u8; 32],
        MarketplaceError::InvalidRequestHash,
    );

    let now = Clock::get()?.unix_timestamp;
    require!(valid_until >= now, MarketplaceError::QuoteExpired);

    require!(
        TaskType::is_valid(task_type),
        MarketplaceError::InvalidTaskType
    );
    require!(
        ctx.accounts.provider.task_types & TaskType::bit(task_type) != 0,
        MarketplaceError::TaskTypeNotSupported,
    );

    require!(amount >= MIN_AMOUNT, MarketplaceError::AmountBelowMinimum);

    // MVP: SOL only. Field is preserved for V2 SPL implementation.
    require!(
        payment_mint == Pubkey::default(),
        MarketplaceError::PaymentMintMismatch,
    );

    // Reconstruct the canonical signed payload (raw concatenation; no
    // SHA256 wrapping — Ed25519 hashes internally).
    // Layout: amount_le (8) || payment_mint (32) || valid_until_le (8) || quote_nonce (16)
    let mut payload = Vec::with_capacity(64);
    payload.extend_from_slice(&amount.to_le_bytes());
    payload.extend_from_slice(payment_mint.as_ref());
    payload.extend_from_slice(&valid_until.to_le_bytes());
    payload.extend_from_slice(&quote_nonce);

    let authority_bytes = ctx.accounts.provider.authority.to_bytes();
    verify_ed25519_sibling(
        ctx.accounts.instructions.as_ref(),
        &authority_bytes,
        &quote_signature,
        &payload,
    )?;

    // Native SOL transfer: consumer → Job PDA.
    invoke(
        &system_instruction::transfer(
            ctx.accounts.consumer.key,
            &ctx.accounts.job.key(),
            amount,
        ),
        &[
            ctx.accounts.consumer.to_account_info(),
            ctx.accounts.job.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // Populate Job.
    let provider_key = ctx.accounts.provider.key();
    let provider_authority = ctx.accounts.provider.authority;
    let consumer_key = ctx.accounts.consumer.key();

    let job = &mut ctx.accounts.job;
    job.version = JOB_VERSION;
    job.task_type = task_type;
    job.consumer = consumer_key;
    job.provider = provider_key;
    job.provider_authority = provider_authority;
    job.request_hash = request_hash;
    job.response_hash = [0u8; 32];
    job.amount = amount;
    job.payment_mint = payment_mint;
    job.nonce = nonce;
    job.created_at = now;
    job.provider_done_at = 0;
    job.state = JobState::Pending;
    job.bump = ctx.bumps.job;
    job.reserved = [0u8; 31];

    Ok(())
}

/// Inspect the instruction immediately preceding the current one, assert
/// it targets the Ed25519Program, and verify that the public key,
/// signature, and message contained therein match the expected values.
///
/// The Ed25519Program has already cryptographically verified the
/// signature by the time this fn runs; our job is only to bind that
/// verification to OUR specific (pubkey, message) pair.
fn verify_ed25519_sibling(
    instructions_sysvar: &AccountInfo,
    expected_pubkey: &[u8; 32],
    expected_signature: &[u8; 64],
    expected_message: &[u8],
) -> Result<()> {
    let ix = get_instruction_relative(-1, instructions_sysvar)
        .map_err(|_| error!(MarketplaceError::QuoteSignatureMissing))?;

    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        MarketplaceError::QuoteSignatureMissing,
    );

    let data = ix.data.as_slice();

    // Ed25519 instruction header layout (Solana SDK):
    //   [0]      num_signatures (u8)
    //   [1]      padding        (u8)
    //   [2..4]   signature_offset             (u16 LE)
    //   [4..6]   signature_instruction_index  (u16 LE)
    //   [6..8]   public_key_offset            (u16 LE)
    //   [8..10]  public_key_instruction_index (u16 LE)
    //   [10..12] message_data_offset          (u16 LE)
    //   [12..14] message_data_size            (u16 LE)
    //   [14..16] message_instruction_index    (u16 LE)
    require!(data.len() >= 16, MarketplaceError::QuotePayloadMalformed);
    require!(data[0] == 1, MarketplaceError::QuotePayloadMalformed);

    let signature_offset = read_u16_le(data, 2)? as usize;
    let signature_ix_index = read_u16_le(data, 4)?;
    let public_key_offset = read_u16_le(data, 6)? as usize;
    let public_key_ix_index = read_u16_le(data, 8)?;
    let message_data_offset = read_u16_le(data, 10)? as usize;
    let message_data_size = read_u16_le(data, 12)? as usize;
    let message_ix_index = read_u16_le(data, 14)?;

    // u16::MAX (0xFFFF) means "this instruction's data". We require all
    // three references to be self-contained — no cross-instruction lookup.
    require!(
        signature_ix_index == u16::MAX
            && public_key_ix_index == u16::MAX
            && message_ix_index == u16::MAX,
        MarketplaceError::QuotePayloadMalformed,
    );

    // Signature
    let sig_end = signature_offset
        .checked_add(64)
        .ok_or_else(|| error!(MarketplaceError::QuotePayloadMalformed))?;
    let sig_bytes = data
        .get(signature_offset..sig_end)
        .ok_or_else(|| error!(MarketplaceError::QuotePayloadMalformed))?;
    require!(
        sig_bytes == expected_signature.as_slice(),
        MarketplaceError::InvalidQuoteSignature,
    );

    // Public key
    let pk_end = public_key_offset
        .checked_add(32)
        .ok_or_else(|| error!(MarketplaceError::QuotePayloadMalformed))?;
    let pk_bytes = data
        .get(public_key_offset..pk_end)
        .ok_or_else(|| error!(MarketplaceError::QuotePayloadMalformed))?;
    require!(
        pk_bytes == expected_pubkey.as_slice(),
        MarketplaceError::InvalidQuoteSignature,
    );

    // Message
    let msg_end = message_data_offset
        .checked_add(message_data_size)
        .ok_or_else(|| error!(MarketplaceError::QuotePayloadMalformed))?;
    let msg_bytes = data
        .get(message_data_offset..msg_end)
        .ok_or_else(|| error!(MarketplaceError::QuotePayloadMalformed))?;
    require!(
        msg_bytes == expected_message,
        MarketplaceError::InvalidQuoteSignature,
    );

    Ok(())
}

fn read_u16_le(data: &[u8], offset: usize) -> Result<u16> {
    let bytes = data
        .get(offset..offset + 2)
        .ok_or_else(|| error!(MarketplaceError::QuotePayloadMalformed))?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}
