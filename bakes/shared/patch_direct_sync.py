"""Controlled-only delivery of verified sync votes; no new signing or consensus rules."""
from pathlib import Path


def apply(root, *, profile):
    def edit(path, before, after):
        file = root / path
        text = file.read_text()
        if text.count(before) != 1:
            raise RuntimeError(f'{path}: direct sync upstream drift: {before!r}')
        file.write_text(text.replace(before, after))

    edit('beacon_node/beacon_chain/src/beacon_chain.rs',
         '        Ok(verified_sync_committee_message)\n', '''        // Local votes have already passed ordinary signature and membership checks. As with
        // gossip contributions, this is candidate-pool admission, not an EL-validity assertion.
        // The controller separately requires the envelope/EL agreement before continuing.
        if std::env::var_os("CHRONIX_CLOCK_START_MS").is_some()
            && self.slot_clock.now() == Some(sync_message.slot)
            && self.head_snapshot().beacon_block_root == sync_message.beacon_block_root
        {
            let mut contributions = Vec::with_capacity(4);
            for subnet in 0..types::consts::altair::SYNC_COMMITTEE_SUBNET_COUNT {
                let Some(contribution) = self.naive_sync_aggregation_pool.read().get(&SyncContributionData {
                    slot: sync_message.slot,
                    beacon_block_root: sync_message.beacon_block_root,
                    subcommittee_index: subnet,
                }) else { return Ok(verified_sync_committee_message); };
                if contribution.aggregation_bits.num_set_bits() != T::EthSpec::sync_subcommittee_size() {
                    return Ok(verified_sync_committee_message);
                }
                contributions.push(contribution);
            }
            for contribution in contributions {
                self.op_pool.insert_sync_contribution(contribution).map_err(Error::from)?;
            }
            slot_clock::controlled::mark_root("sync_contributions",
                &format!("{:?}", sync_message.beacon_block_root), sync_message.slot.as_u64());
        }
        Ok(verified_sync_committee_message)
''')
    edit('validator_client/validator_services/src/sync.rs',
         '    // Start at the next slot, as aggregation proofs for the duty at the current slot are no longer',
         '''    // Controlled BN delivers verified votes directly to the block operation pool.
    // Membership polling for both current and next periods still runs normally.
    if std::env::var_os("CHRONIX_CLOCK_START_MS").is_some() { return; }
    // Start at the next slot, as aggregation proofs for the duty at the current slot are no longer''')
    path = root / 'validator_client/validator_services/src/sync_committee_service.rs'
    text = path.read_text()
    start = text.index('    async fn publish_sync_committee_aggregates(')
    body = text.index(' {\n', start) + len(' {\n')
    text = text[:body] + '        if std::env::var_os("CHRONIX_CLOCK_START_MS").is_some() { return; }\n' + text[body:]
    path.write_text(text)
    cargo = root / 'beacon_node/beacon_chain/Cargo.toml'
    text = cargo.read_text()
    if 'name = "chronix_direct_sync"' not in text:
        cargo.write_text(text + '\n[[test]]\nname = "chronix_direct_sync"\npath = "tests/chronix_direct_sync.rs"\n')
    install_test(root, profile=profile)


def install_test(root, *, profile):
    source = (Path(__file__).parent / 'native/direct_sync_test.rs').read_text()
    if profile == 'pectra':
        # The older harness accepts an explicit state root; it has no Gloas builder cache.
        source = source.replace(
            '    harness.add_attested_block_at_slot(slot, harness.get_current_state(), &[])',
            '    let (state, state_root) = harness.get_current_state_and_root();\n'
            '    harness.add_attested_block_at_slot(slot, state, state_root, &[])')
        source = source.replace('slot + 1, None, &chain.spec)', 'slot + 1, &chain.spec)')
    elif profile != 'gloas':
        raise ValueError(f'unsupported direct sync fixture profile: {profile}')
    (root / 'beacon_node/beacon_chain/tests/chronix_direct_sync.rs').write_text(source)
