"""Shared, byte-identical BLS verification reuse for controlled-clock bakes."""
from pathlib import Path
import shutil


def apply(root):
    source = root / 'crypto/bls/src/impls/blst.rs'
    text = source.read_text()
    before = '        // Public keys are already valid due to PoP\n'
    if text.count(before) != 1:
        raise RuntimeError('BLS fast_aggregate_verify upstream drift')
    text = text.replace(before, '''        if pubkeys.len() == 1 && std::env::var_os("CHRONIX_CLOCK_START_MS").is_some() {
            return chronix_verified_signature::verify(&signature, pubkeys[0], msg.0);
        }
''' + before)
    text += '\n#[path = "chronix_verified_signature.rs"]\nmod chronix_verified_signature;\n'
    text += '''
/// Devnet preverification. No caller can insert an unchecked result into the success cache.
pub fn chronix_preverify_single_key_sets(sets: &[SignatureSet<'_>]) -> bool {
    let inputs: Option<Vec<_>> = sets.iter().map(|set| {
        let [public_key] = set.signing_keys.as_slice() else { return None; };
        let signature = set.signature.point()?.0.to_signature();
        Some((signature, public_key.point().clone(), set.message.0))
    }).collect();
    inputs.is_some_and(|inputs| chronix_verified_signature::verify_batch(&inputs))
}
'''
    source.write_text(text)
    shutil.copyfile(Path(__file__).parent / 'native/verified_signature.rs',
                    source.parent / 'chronix_verified_signature.rs')
    tests = root / 'crypto/bls/tests'
    tests.mkdir(exist_ok=True)
    (tests / 'chronix_verified_signature.rs').write_text(
        'use bls::impls::blst::DST;\n'
        '#[path = "../src/impls/chronix_verified_signature.rs"]\nmod verification;\n')

    chain = root / 'beacon_node/beacon_chain/src'
    module = chain / 'lib.rs'
    text = module.read_text()
    if text.count('mod beacon_chain;') != 1:
        raise RuntimeError('BeaconChain module upstream drift')
    module.write_text(text.replace('mod beacon_chain;', 'mod beacon_chain;\npub mod chronix_sync_batch;'))
    shutil.copyfile(Path(__file__).parent / 'native/sync_batch.rs', chain / 'chronix_sync_batch.rs')
    api = root / 'beacon_node/http_api/src/sync_committees.rs'
    text = api.read_text()
    start = text.index('pub fn process_sync_committee_signatures')
    start = text.index('    let mut failures = vec![];', start)
    text = text[:start] + '''    if std::env::var_os("CHRONIX_CLOCK_START_MS").is_some() {
        beacon_chain::chronix_sync_batch::preverify(chain, &sync_committee_signatures);
    }
''' + text[start:]
    api.write_text(text)
    with (tests / 'chronix_verified_signature.rs').open('a') as test:
        test.write('''
#[test]
fn upstream_signature_sets_reject_swapped_signers_and_changed_roots() {
    use bls::{Hash256, SecretKey, SignatureSet};
    use bls::impls::blst::chronix_preverify_single_key_sets;
    use std::borrow::Cow;
    let keys: Vec<_> = (1u8..=2).map(|seed| SecretKey::deserialize(&[seed; 32]).unwrap()).collect();
    let public: Vec<_> = keys.iter().map(SecretKey::public_key).collect();
    let root = Hash256::from([7; 32]);
    let signatures: Vec<_> = keys.iter().map(|key| key.sign(root)).collect();
    let valid: Vec<_> = (0..2).map(|i|
        SignatureSet::single_pubkey(&signatures[i], Cow::Borrowed(&public[i]), root)).collect();
    assert!(chronix_preverify_single_key_sets(&valid));
    assert!(valid.iter().all(|set| set.clone().verify()));
    let swapped: Vec<_> = (0..2).map(|i|
        SignatureSet::single_pubkey(&signatures[1-i], Cow::Borrowed(&public[i]), root)).collect();
    assert!(!chronix_preverify_single_key_sets(&swapped));
    assert!(swapped.iter().all(|set| !set.clone().verify()));
    let wrong_root = [SignatureSet::single_pubkey(&signatures[0], Cow::Borrowed(&public[0]), Hash256::from([8; 32]))];
    assert!(!chronix_preverify_single_key_sets(&wrong_root));
    assert!(!chronix_preverify_single_key_sets(&[]));
}
''')
