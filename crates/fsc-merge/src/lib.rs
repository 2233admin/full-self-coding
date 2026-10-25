//! Serialized commit merging with tiered conflict resolution
//! (port of `packages/core/src/execution/sequencer.ts` and `utils/conflictParser.ts`).

pub mod conflict;
pub mod git;
pub mod sequencer;

pub use conflict::{
    has_contentful_canonical, parse_conflict_markers, resolve_keep_incoming, ConflictChunk,
};
pub use sequencer::{
    CommitSequencer, MergeHistory, MergeHistoryEntry, MergeInput, SequencerResult,
};
