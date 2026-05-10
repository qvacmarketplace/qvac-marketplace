use anchor_lang::prelude::*;

/// All error codes for the QVAC Marketplace program.
/// Grouped by instruction; numbers auto-assigned starting at 6000.
#[error_code]
pub enum MarketplaceError {
    // ── register_provider / update_provider ────────────────────────
    #[msg("Provider name must be at least 3 characters")]
    NameTooShort,
    #[msg("Provider name must not exceed 50 characters")]
    NameTooLong,
    #[msg("task_types bitmask must specify at least one supported task")]
    NoTaskTypesSpecified,
    #[msg("Signer is not the registered authority for this provider")]
    UnauthorizedProvider,

    // ── create_job ─────────────────────────────────────────────────
    #[msg("Quote has expired (valid_until < current time)")]
    QuoteExpired,
    #[msg("Provider does not support the requested task_type")]
    TaskTypeNotSupported,
    #[msg("task_type value is outside the TaskType enum range")]
    InvalidTaskType,
    #[msg("Job amount is below the minimum allowed")]
    AmountBelowMinimum,
    #[msg("Quote signature did not verify against provider authority")]
    InvalidQuoteSignature,
    #[msg("Ed25519 sibling instruction not found or malformed")]
    QuoteSignatureMissing,
    #[msg("Quote signature payload could not be reconstructed")]
    QuotePayloadMalformed,
    #[msg("payment_mint does not match a supported payment route")]
    PaymentMintMismatch,

    // ── provider_complete ──────────────────────────────────────────
    #[msg("Job is not in Pending state")]
    JobNotPending,
    #[msg("Job is not associated with the provider account passed in")]
    ProviderMismatch,
    #[msg("Job's provider_authority does not match the signer")]
    ProviderAuthorityMismatch,
    #[msg("response_hash cannot be all zeros")]
    InvalidResponseHash,

    // ── consumer_confirm ───────────────────────────────────────────
    #[msg("Job is not in ProviderDone state")]
    JobNotProviderDone,
    #[msg("Auto-release window has not elapsed; only the consumer may confirm now")]
    ConfirmWindowNotElapsed,
    #[msg("provider_authority account does not match job.provider_authority")]
    ProviderAuthorityAccountMismatch,
    #[msg("consumer account does not match job.consumer")]
    ConsumerAccountMismatch,

    // ── refund_job ─────────────────────────────────────────────────
    #[msg("Only the consumer who created this job may refund it")]
    UnauthorizedRefund,
    #[msg("Job cannot be refunded once provider has delivered (ProviderDone)")]
    RefundBlockedProviderDelivered,
    #[msg("Job is not in a refundable state")]
    JobNotRefundable,
    #[msg("Refund timeout has not yet elapsed")]
    RefundTimeoutNotElapsed,

    // ── cross-cutting ──────────────────────────────────────────────
    #[msg("Account version is unsupported by this program build")]
    UnsupportedAccountVersion,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Insufficient lamports in escrow for this operation")]
    InsufficientEscrow,
    #[msg("qvac_peer_id cannot be all zeros")]
    InvalidQvacPeerId,
    #[msg("request_hash cannot be all zeros")]
    InvalidRequestHash,
}
