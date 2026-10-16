//! Component regression; real EL/CL compatibility is checked by the profile suites.
use beacon_chain::test_utils::{BeaconChainHarness, RelativeSyncCommittee};
use bls::SecretKey;
use state_processing::{
    per_block_processing::{altair::sync_committee::process_sync_aggregate, VerifySignatures},
    state_advance::complete_state_advance,
};
use std::collections::HashSet;
use types::{EthSpec, Hash256, MainnetEthSpec, Slot, SyncContributionData, SyncSelectionProof, SyncSubnetId};

#[tokio::test]
async fn verified_messages_without_aggregator_wrappers() {
    // Separate processes keep the controlled clock's OnceLock and environment isolated.
    let Ok(mode) = std::env::var("CHRONIX_SYNC_TEST_MODE") else {
        for mode in ["ordinary", "controlled"] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "verified_messages_without_aggregator_wrappers", "--nocapture"])
                .env("CHRONIX_SYNC_TEST_MODE", mode)
                .env_remove("CHRONIX_CLOCK_START_MS")
                .env_remove("CHRONIX_CLOCK_PORT");
            if mode == "controlled" {
                command.env("CHRONIX_CLOCK_START_MS", "1567552690000").env("CHRONIX_CLOCK_PORT", "0");
            }
            assert!(command.status().unwrap().success(), "{mode} sync delivery failed");
        }
        return;
    };
    check_votes(&mode, 64).await;
    check_votes(&mode, 1).await;
}

async fn check_votes(mode: &str, validator_count: usize) {
    type E = MainnetEthSpec;
    let mut spec = E::default_spec();
    spec.altair_fork_epoch = Some(0u64.into());
    // A pre-merge component fixture needs no execution service, mocked or otherwise.
    spec.bellatrix_fork_epoch = None;
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.into())
        .keypairs(types::test_utils::generate_deterministic_keypairs(validator_count))
        .fresh_ephemeral_store()
        .build();
    let genesis = harness.get_current_state();
    let slot = if validator_count == 1 {
        // A real mainnet-preset selection with no elected aggregator on ANY subnet.
        // Repeated positions of a key share a proof; they are not independent elections.
        (1..32).map(Slot::new).find(|&slot| (0..4).all(|subnet| {
            !SyncSelectionProof::new::<E>(slot, subnet, &harness.validator_keypairs[0].sk,
                &genesis.fork(), genesis.genesis_validators_root(), &harness.spec)
                .is_aggregator::<E>().unwrap()
        })).expect("fixture needs a slot with no elected aggregator")
    } else { Slot::new(1) };
    harness.add_attested_block_at_slot(slot, harness.get_current_state(), &[]).await.unwrap();
    let chain = &harness.chain;
    let head = chain.head_snapshot();
    let mut next_state = head.beacon_state.clone();
    complete_state_advance(&mut next_state, Some(head.beacon_state_root()), slot + 1, None, &chain.spec).unwrap();
    let messages = harness.make_sync_committee_messages(
        &head.beacon_state, head.beacon_block_root, slot, RelativeSyncCommittee::Current,
    );
    let mut seen = HashSet::new();
    let unique: Vec<_> = messages.into_iter().enumerate().flat_map(|(subnet, messages)| {
        messages.into_iter().map(move |(message, _)| (message, SyncSubnetId::new(subnet as u64)))
    }).filter(|(message, _)| seen.insert(message.validator_index)).collect();
    assert_eq!(unique.len(), validator_count);
    assert!(chain.op_pool.get_sync_aggregate(&next_state).unwrap().is_none());
    for (index, (message, subnet)) in unique.iter().enumerate() {
        if index == unique.len() - 1 {
            // Incomplete coverage must not become a block aggregate, even with valid partial votes.
            assert!(chain.op_pool.get_sync_aggregate(&next_state).unwrap().is_none());
            let mut corrupt = message.clone();
            corrupt.signature = SecretKey::deserialize(&[42; 32]).unwrap().sign(Hash256::from([0; 32]));
            assert!(chain.verify_sync_committee_message_for_gossip(corrupt, *subnet).is_err());
        }
        let verified = chain.verify_sync_committee_message_for_gossip(message.clone(), *subnet).unwrap();
        chain.add_to_naive_sync_aggregation_pool(verified.clone()).unwrap();
        if index == 0 {
            // A repeated delivery must not add the same signature/positions twice.
            chain.add_to_naive_sync_aggregation_pool(verified).unwrap();
        }
    }
    // Verify the input really contains every position. No SignedContributionAndProof was supplied.
    for subnet in 0..4 {
        let contribution = chain.get_aggregated_sync_committee_contribution(&SyncContributionData {
            slot, beacon_block_root: head.beacon_block_root, subcommittee_index: subnet,
        }).unwrap().unwrap();
        assert_eq!(contribution.aggregation_bits.num_set_bits(), 128);
    }
    let aggregate = chain.op_pool.get_sync_aggregate(&next_state).unwrap();
    if mode == "ordinary" {
        assert!(aggregate.is_none(), "ordinary gossip path must remain unchanged");
        return;
    }
    let aggregate = aggregate.expect("full verified sync messages must reach block production without an elected aggregator");
    assert_eq!(aggregate.sync_committee_bits.num_set_bits(), 512);
    process_sync_aggregate(&mut next_state, &aggregate, 0, VerifySignatures::True, &chain.spec).unwrap();
}
