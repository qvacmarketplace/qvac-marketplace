use anchor_lang::prelude::*;

/// Current on-chain layout version for `Provider`.
/// Increment whenever the `Provider` struct layout changes; old accounts
/// are then either migrated or rejected via the `version` field check.
pub const PROVIDER_VERSION: u8 = 1;

/// Current on-chain layout version for `Job`.
/// Increment whenever the `Job` struct layout changes.
pub const JOB_VERSION: u8 = 1;

// ────────────────────────────────────────────────────────────────────
// Provider PDA — seeds: ["provider", authority]
// ────────────────────────────────────────────────────────────────────

/// Registered AI inference provider.
///
/// One Provider per wallet (authority). The PDA is derived from the
/// authority pubkey, which doubles as the provider's identity in the
/// marketplace. `qvac_peer_id` is the Hyperdht public key consumers
/// connect to via `dht.connect(publicKey)` — required because the QVAC
/// SDK is key-based, not topic-based.
#[account]
#[derive(InitSpace)]
pub struct Provider {
    /// Layout version. Must equal `PROVIDER_VERSION`; otherwise reject.
    pub version: u8,

    /// Bitmask of supported `TaskType` values: `1u16 << (TaskType as u8)`.
    /// Must be non-zero. Bit N set means task_type N is supported.
    pub task_types: u16,

    /// Wallet that registered and controls this provider. Also the
    /// destination for completed-job payouts. PDA seed.
    pub authority: Pubkey,

    /// Hyperdht public key (Ed25519, 32 bytes). Consumers use this with
    /// the QVAC SDK as `loadModel({ delegate: { providerPublicKey } })`.
    /// Updatable via the V2 `update_provider_peer_id` ix when the
    /// provider's `QVAC_HYPERSWARM_SEED` rotates.
    pub qvac_peer_id: [u8; 32],

    /// Display name. Validated to 3..=50 UTF-8 bytes at write time.
    #[max_len(50)]
    pub name: String,

    /// Lifetime count of jobs successfully completed and paid out.
    pub jobs_completed: u64,

    /// Lifetime count of jobs that ended in dispute (V2; unused in MVP).
    pub jobs_disputed: u64,

    /// Lifetime lamports earned across all completed jobs. `checked_add` only.
    pub total_earned: u64,

    /// Unix timestamp at `register_provider`.
    pub registered_at: i64,

    /// Cached PDA bump for cheap re-derivation in subsequent ixs.
    pub bump: u8,

    /// Reserved bytes for forward compatibility. Planned use:
    /// stake_amount (8) | reputation_score (8) | last_active_at (8) |
    /// tier (1) | is_verified (1) | spare (4).
    pub reserved: [u8; 30],
}

impl Provider {
    /// PDA seed prefix. Pair with `authority.key().as_ref()`.
    pub const SEED_PREFIX: &'static [u8] = b"provider";
}

// ────────────────────────────────────────────────────────────────────
// Job PDA — seeds: ["job", consumer, nonce_le]
// ────────────────────────────────────────────────────────────────────

/// Escrowed inference job.
///
/// Holds the consumer's payment in its own lamports balance until
/// `consumer_confirm` (releases to provider) or `refund_job` (returns
/// to consumer). Closed in either terminal path; rent returns to consumer.
#[account]
#[derive(InitSpace)]
pub struct Job {
    /// Layout version. Must equal `JOB_VERSION`; otherwise reject.
    pub version: u8,

    /// `TaskType` discriminant (0..=`TaskType::MAX`). Validated against
    /// `provider.task_types` bitmask at create time.
    pub task_type: u8,

    /// Consumer who funded the escrow. Sole valid refund destination
    /// and rent recipient on close. PDA seed.
    pub consumer: Pubkey,

    /// Provider PDA bound to this job. Verified against the Provider
    /// account passed to `provider_complete` and `consumer_confirm`.
    pub provider: Pubkey,

    /// Provider's payout wallet (= `provider.authority` at create time).
    /// Snapshotted so that even if Provider is updated mid-job, payment
    /// still goes to the originally agreed authority.
    pub provider_authority: Pubkey,

    /// SHA256(input_bytes || nonce.to_le_bytes()). Binds the job to a
    /// specific off-chain payload. Provider verifies via bridge.js
    /// before serving inference.
    pub request_hash: [u8; 32],

    /// SHA256 of the response. Zeros until `provider_complete` sets it.
    pub response_hash: [u8; 32],

    /// Lamports escrowed. Snapshot of the price agreed in the signed
    /// quote — protects consumer from price changes mid-flight.
    pub amount: u64,

    /// `Pubkey::default()` = native SOL (MVP).
    /// Any other value = SPL mint (returns `PaymentMintMismatch` in MVP;
    /// reserved field for V2 SPL implementation).
    pub payment_mint: Pubkey,

    /// Consumer-supplied uniqueness seed. PDA seed; allows multiple
    /// concurrent jobs from the same consumer.
    pub nonce: u64,

    /// Unix timestamp at `create_job`. Refund eligible once
    /// `now >= created_at + JOB_TIMEOUT`.
    pub created_at: i64,

    /// Unix timestamp at `provider_complete`. Auto-release eligible once
    /// `now >= provider_done_at + CONFIRM_WINDOW`. Zero until set.
    pub provider_done_at: i64,

    /// Lifecycle state. See `JobState`.
    pub state: JobState,

    /// Cached PDA bump.
    pub bump: u8,

    /// Reserved bytes for forward compatibility. Planned use:
    /// token_count (4) | consumer_rating (1) | dispute_reason (1) |
    /// response_ms (4) | spare (21).
    pub reserved: [u8; 31],
}

impl Job {
    /// PDA seed prefix. Pair with `consumer.as_ref()` and `nonce.to_le_bytes()`.
    pub const SEED_PREFIX: &'static [u8] = b"job";
}

// ────────────────────────────────────────────────────────────────────
// Enums
// ────────────────────────────────────────────────────────────────────

/// Job lifecycle. Stored as a single byte on-chain.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum JobState {
    /// Escrowed, awaiting inference. Refund eligible after `JOB_TIMEOUT`.
    Pending,
    /// Provider has submitted `response_hash`. `CONFIRM_WINDOW` now applies;
    /// after it elapses, anyone may call `consumer_confirm`.
    ProviderDone,
    /// Payment released to provider; account closed.
    Completed,
    /// Reserved for V2 dispute flow. Not reachable in MVP.
    Disputed,
    /// Consumer refunded; account closed.
    Refunded,
}

/// Supported task discriminants. Stored as `u8` in `Job.task_type`.
/// `Provider.task_types` is a bitmask: `1u16 << (TaskType as u8)`.
///
/// Not serialized as an enum on-chain — kept here as a Rust-side helper
/// for clients and validation.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TaskType {
    /// Text in, streaming text out. MVP-only task type.
    Completion = 0,
    Embeddings = 1,
    Translation = 2,
    Transcription = 3,
    TextToSpeech = 4,
    Ocr = 5,
    ImageGeneration = 6,
    Multimodal = 7,
    Rag = 8,
    VoiceAssistant = 9,
}

impl TaskType {
    /// Highest valid discriminant. Used for range validation.
    pub const MAX: u8 = 9;

    /// Returns the bitmask bit for a given task discriminant.
    /// Caller must ensure `value <= TaskType::MAX`.
    pub const fn bit(value: u8) -> u16 {
        1u16 << value
    }

    /// Validates that `value` is a known task discriminant.
    pub const fn is_valid(value: u8) -> bool {
        value <= Self::MAX
    }
}
