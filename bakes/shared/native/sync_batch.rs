//! Preverify only cryptography in a controlled devnet. Ordinary message validation still runs.
use crate::{BeaconChain, BeaconChainTypes};
use bls::AggregateSignature;
use state_processing::signature_sets::sync_committee_message_set_from_pubkeys;
use std::borrow::Cow;
use types::{EthSpec, SyncCommitteeMessage};

pub fn preverify<T: BeaconChainTypes>(chain: &BeaconChain<T>, messages: &[SyncCommitteeMessage]) {
    if !(2..=512).contains(&messages.len()) {
        return;
    }
    let public_keys = chain.validator_pubkey_cache.read();
    let signatures: Vec<_> = messages
        .iter()
        .map(|message| AggregateSignature::from(&message.signature))
        .collect();
    let sets: Option<Vec<_>> = messages
        .iter()
        .zip(&signatures)
        .map(|(message, signature)| {
            let index = usize::try_from(message.validator_index).ok()?;
            let public_key = public_keys.get(index)?;
            let next_epoch = types::Slot::new(message.slot.as_u64().checked_add(1)?)
                .epoch(T::EthSpec::slots_per_epoch());
            let fork = chain.spec.fork_at_epoch(next_epoch);
            sync_committee_message_set_from_pubkeys::<T::EthSpec>(
                Cow::Borrowed(public_key),
                signature,
                message.slot.epoch(T::EthSpec::slots_per_epoch()),
                message.beacon_block_root,
                &fork,
                chain.genesis_validators_root,
                &chain.spec,
            )
            .ok()
        })
        .collect();
    if let Some(sets) = sets {
        // On any failed batch, the unchanged individual path diagnoses the offending messages.
        let _ = bls::impls::blst::chronix_preverify_single_key_sets(&sets);
    }
}
