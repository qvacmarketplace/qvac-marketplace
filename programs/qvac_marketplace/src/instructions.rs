pub mod register_provider;
pub mod update_provider;
pub mod rotate_peer_id;
pub mod create_job;
pub mod provider_complete;
pub mod consumer_confirm;
pub mod refund_job;

// Glob re-exports are required by Anchor's `#[program]` macro, which
// expands to references on auto-generated `__client_accounts_*` types
// nested inside each instruction module. The trade-off is a benign
// `ambiguous_glob_reexports` warning on the per-module `handler` fn —
// we never call it via the glob, only via the explicit module path
// (e.g. `instructions::register_provider::handler(...)`), so the
// ambiguity is harmless.
#[allow(ambiguous_glob_reexports)]
pub use register_provider::*;
#[allow(ambiguous_glob_reexports)]
pub use update_provider::*;
#[allow(ambiguous_glob_reexports)]
pub use rotate_peer_id::*;
#[allow(ambiguous_glob_reexports)]
pub use create_job::*;
#[allow(ambiguous_glob_reexports)]
pub use provider_complete::*;
#[allow(ambiguous_glob_reexports)]
pub use consumer_confirm::*;
#[allow(ambiguous_glob_reexports)]
pub use refund_job::*;
