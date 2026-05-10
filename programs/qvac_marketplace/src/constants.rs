/// Program-wide constants for the QVAC Marketplace.

/// Refund eligibility delay after job creation, in seconds.
/// Consumer may call `refund_job` once `now >= job.created_at + JOB_TIMEOUT`.
pub const JOB_TIMEOUT: i64 = 600;

/// Auto-release window after `provider_complete`, in seconds.
/// Within this window only the consumer may call `consumer_confirm`.
/// After it elapses, anyone may call `consumer_confirm` to release escrow.
pub const CONFIRM_WINDOW: i64 = 300;

/// Minimum lamports that may be escrowed in a single job.
pub const MIN_AMOUNT: u64 = 1_000;

/// Minimum length, in UTF-8 bytes, of `Provider.name`.
pub const MIN_NAME_LEN: usize = 3;

/// Maximum length, in UTF-8 bytes, of `Provider.name`. Must match the
/// `#[max_len(...)]` attribute on `Provider.name` in `state.rs`.
pub const MAX_NAME_LEN: usize = 50;
