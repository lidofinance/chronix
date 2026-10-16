//! Prepare a controlled clock jump once, persisting authentic empty-slot states
//! through the normal store for duties, proposals and verification. Never changes head.
use crate::{BeaconChain, BeaconChainTypes, BeaconChainError};
use state_processing::{per_slot_processing, GloasVerificationContext};
use std::sync::Arc;
use types::{EthSpec, Slot};

impl<T: BeaconChainTypes> BeaconChain<T> {
    pub async fn prepare_controlled_skip(self: &Arc<Self>) -> Result<(), String> {
        if std::env::var_os("CHRONIX_CLOCK_START_MS").is_none() { return Ok(()); }
        let slot = self.slot().map_err(|e| format!("{e:?}"))?;
        if self.best_slot() + T::EthSpec::slots_per_epoch() >= slot { return Ok(()); }
        let chain = self.clone();
        tokio::task::spawn_blocking(move || chain.cache_controlled_skip(slot + 1))
            .await.map_err(|e| format!("{e:?}"))?
            .map_err(|e| format!("{e:?}"))
    }

    fn cache_controlled_skip(&self, target: Slot) -> Result<(), BeaconChainError> {
        let head = self.head_snapshot();
        let block_root = head.beacon_block_root;
        let (mut root, mut state) = if let Some(cached) = self.store
            .get_advanced_hot_state_from_cache(block_root, target) {
            cached
        } else {
            let mut state = head.beacon_state.clone();
            (state.update_tree_hash_cache()?, state)
        };
        drop(head);
        if state.slot() >= target { return Ok(()); }
        while state.slot() < target {
            per_slot_processing(&mut state, Some(root),
                GloasVerificationContext::from_cache(self.builder_onboarding_cache.as_deref()),
                &self.spec)?;
            root = state.update_tree_hash_cache()?;
            // Import and finalization need the intermediate summaries and HDiff bases,
            // even if the destination pre-state is already cached. This is the same
            // persistence path as ordinary block-verification catchup.
            self.store.put_state(&root, &state)?;
        }
        Ok(())
    }
}
