# Algorithmic budget for honest warp

Snapshot as of 2026-09-30. Read-only analysis of pinned source and saved measurements; no new runs
or client changes. PTC is considered separately. The upstream source below is pinned to Gloas
`2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`; links to `.cache/warp-native/gloas` refer to the local
overlay of the bake under study. Execution settings are not a variable in this investigation.

**8192 slots in 60 s is not yet substantiated.** 7.324219 ms/slot is the upper average bound before
subtracting the first subsequent transaction and fixed costs. The actual available budget is
smaller.

## Practical answer: how long will 8192 slots take?

This prototype has not yet changed the integrated client, so there is no measured network speedup
from it. The current 2.956 s for 32 slots extrapolates linearly to **756.8 s, about 12 min 37 s**
for 8192. This is an estimate from a short run; the exact advance duration in the earlier long test
was not saved.

If the isolated sync crypto reduction of **27.816 → 1.563 ms** transferred fully to each slot's
sequential path, the result would be `(92.382 − 27.816 + 1.563) ×8192 /1000` = **541.7 s, about 9
min 2 s**. This is a conditional model: approximately **1.40×** for the entire warp, or **28.4% less
time**, versus **17.8×** for one component. Stage overlap and new integration costs are unknown; the
model is not a measured forecast. It also excludes the first subsequent transaction, which must be
measured together with the integrated warp.

Thus, even this conditional estimate does not approach the one-minute requirement. The component
result cannot be presented as a 17.8-fold speedup of the entire network or as meeting the ≤60 s
target.

## Measurements

| Observation                                                            |                                              Time | What it establishes                            |
| ---------------------------------------------------------------------- | ------------------------------------------------: | ---------------------------------------------- |
| Full sync, ordinary 64 signatures + batch64 + 512-position aggregation |                                 27.816214 ms mean | Original isolated component                    |
| Full sync, ephemeral sum + 1 signature + general batch1                |                 1.562515 ms mean; 1.611750 ms p95 | Real cryptographic improvement; 14 tests PASS  |
| Including sign + secret sums / required verification                   |                            0.415114 / 1.127026 ms | Sequential stages of one harness batch         |
| Cold public committee preparation                                      | 0.266209 ms, including 0.233208 ms PK aggregation | Separate preparation, outside the steady total |
| Direct-sync network, 32 slots                                          |                 2956.230250 ms, 92.382195 ms/slot | Old bake with 64 individual sync signatures    |

Sources: [full baseline](../reports/warp-tdd/group-sync/full-baseline.json),
[full candidate](../reports/warp-tdd/group-sync/full-candidate.json),
[environment/provenance](../reports/warp-tdd/group-sync/environment.json),
[direct-sync network](../reports/warp-tdd/native/metrics-gloas-direct-sync.json). The last report is
bound to bake `e41c863b…`; it is **not** a network measurement after group signer integration.
Subtracting 26.253699 ms from 92.382195 ms would give 66.128496 ms, but even this arithmetic is not
a forecast: the component and network were measured through different paths, and their overlap is
unknown.

Deltas between [BN before](../reports/warp-tdd/native/metrics-direct-sync-bn-before.txt) and
[after](../reports/warp-tdd/native/metrics-direct-sync-bn-after.txt), divided by 32:

| Stage                                           |       ms/slot | Nesting                                                           |
| ----------------------------------------------- | ------------: | ----------------------------------------------------------------- |
| Entire block production                         |         7.269 | Includes payload retrieval and nested stages                      |
| ↳ production process / state root               | 0.996 / 0.599 | Do not add to the production row                                  |
| Entire block import                             |         7.679 | Includes verification, transition, writes, and related work       |
| ↳ import core / state root                      | 0.111 / 0.620 | Do not add to the import row                                      |
| Entire envelope processing                      |         3.489 | Do not add to the internal newPayload RPC                         |
| Unaggregated attestation verification, 64 calls |         7.678 | Includes the 7.593 BLS timer; this is not another independent sum |
| Aggregated attestation verification, 64 calls   |         1.878 | Separate aggregate/proof checks                                   |
| Sync pool application, 16384 calls              |         2.527 | Includes insert 1.538 and aggregation 0.933                       |

Block production returns an unsigned block before that same block is signed and published/imported:
[block_service.rs:614](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/validator_client/validator_services/src/block_service.rs#L614),
[sign_and_publish_block:532](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/validator_client/validator_services/src/block_service.rs#L532).
Production and import are therefore separate sequential stages of the current same-slot path,
approximately 14.948 ms in this window. This is **not a physical lower bound** for a new algorithm:
the outer timers include waits and repeated work. But the measurements already show that speeding up
sync alone does not prove that the target budget is achievable.

The `newPayload`, `getPayload`, `forkchoiceUpdated`, envelope, fork-choice, API, and VC service
timers are partly nested or overlapping. The sum of latency across all VC signing jobs is not
sequential time. A sync per-message signature timer of only 0.142 ms/slot does not imply a cheap
batch64: the batch runs **before** these timers, in
[http_api/sync_committees.rs:186](../.cache/warp-native/gloas/beacon_node/http_api/src/sync_committees.rs#L186),
[chronix_sync_batch.rs:8](../.cache/warp-native/gloas/beacon_node/beacon_chain/src/chronix_sync_batch.rs#L8),
and subsequent checks use the positive cache. Existing counters do not isolate the cost of batch64
itself within the network.

The old honest-v3 [phase trace](../reports/warp-tdd/native/critical-path-gloas-honest-v3.json) is
not a direct-sync trace. `clock`/`mark`/`consistency` are measured inside `move`
([instrumentation](../reports/warp-tdd/profile_phases.ts#L19)); they cannot be added to phase totals
or used to carry over 13.53 ms clock/slot as a lower bound for the new network.

## Narrow algorithmic opportunities

1. **One aggregate — one ordinary BLS verification.** The full helper currently calls a general
   randomized batch even for one element. With one equation, there is no cancellation between
   different batch members: ordinary `Signature::verify(true, root, DST, [], aggregate_pk, false)`
   checks the same signature, including the subgroup check. The public aggregate PK must be built
   from verified exact positions; infinity/zero retain ordinary rejection. Multiple groups still
   require a randomized batch. In one candidate report, general verify = 1.126787 ms, and the next,
   excluded ordinary oracle = 0.773787 ms. The **0.353 ms difference is a reference point**, not a
   controlled A/B comparison: measurement order differs. Even hypothetically eliminating ALL
   required verification saves only 1.127026 ms in this component. This is the smallest next crypto
   experiment, with no new helper/store/API.

2. **Do not sum 512 public keys again when all sync bits are set.**
   [sync_aggregate_signature_set:794](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_block_processing/signature_sets.rs#L794)
   currently selects all 512 PKs, and
   [verify_signature_sets:36](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/crypto/bls/src/impls/blst.rs#L36)
   sums them again. The consensus state already contains `SyncCommittee.aggregate_pubkey`, computed
   with multiplicities in
   [get_next_sync_committee:1769](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/types/src/state/beacon_state.rs#L1769).
   A narrow all-bits branch can use this public key with ordinary decompression/verification;
   partial/empty bits retain the old path. The exact committee from the inclusion-slot epoch is
   required, while the signing domain remains based on the previous slot. Cold 512-PK aggregation in
   the harness takes 0.233208 ms; this estimates the scale of the opportunity, not a proven native
   saving or a strict bound. No state-machine change or secret cache is needed.

3. **Repeated verification of an identical crypto tuple.** The current positive cache stores
   `(domain-bound signing root, canonical PK, canonical signature)` only after successful
   verification
   ([chronix_verified_signature.rs:13](../.cache/warp-native/gloas/crypto/bls/src/impls/chronix_verified_signature.rs#L13)).
   But the bulk block verifier does not read it. After group admission, the same sync tuple is
   checked again in `include_sync_aggregate`; RANDAO is also checked during production and bulk
   import. A narrow extension would look up known tuples before the existing batch, batch only
   misses, and remember results only after the entire batch succeeds. All membership/root/time/state
   checks still run. The aggregate PK must first be derived from the exact positions; the cache does
   not prove membership. Do not count the proposer signature again: upstream already excludes it
   after gossip in
   [from_gossip_verified_block:1210](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/beacon_node/beacon_chain/src/block_verification.rs#L1210).
   This opportunity is unverified: there is currently no separate bulk setup/crypto timer or
   hit/miss evidence. The cost of a single pairing cannot be claimed as the marginal cost of an
   element in a shared batch.

## Why an SSZ macro-step does not close the gap

Gloas production performs a real transition and computes the state root
([gloas.rs:809](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/beacon_node/beacon_chain/src/block_production/gloas.rs#L809));
import repeats the transition without already verified signatures and checks the root
([block_verification.rs:1666](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/beacon_node/beacon_chain/src/block_verification.rs#L1666)).
This is real duplication. However, `update_tree_hash_cache` already applies pending changes to
persistent structures
([beacon_state.rs:3030](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/types/src/state/beacon_state.rs#L3030)),
rather than serializing and hashing the entire state again.

Even perfect reuse of the producer result instead of repeating import core + root would remove about
**0.731 ms/slot** in the measured window. Both root timers together total 1.219 ms/slot; removing
both is incompatible with preserving ordinary history. A safe result cache would require the exact
pre-state root, full block input, fork/spec, saved post-state, verified signature/EL results, and
fallbacks. Given this limited opportunity, it is not the first narrow change to make.

Even without user txs, each next block depends on the previous state/block root, RANDAO,
rewards/participation, and execution data. `per_slot_processing::cache_state` records the state root
and updates block-root history
([per_slot_processing.rs:121](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/state_processing/src/per_slot_processing.rs#L121)).
Skipping these roots with a formula changes the ordinary verifiable history. The initial state and
target time do not determine the final root without executing these dependencies.

## Conclusions supported by the budget

The conditional sum of the group component + production process/root + import core/root is **3.888
ms/slot**. This is only an incomplete list of work from different measurements, not a forecast or
lower bound: it omits the remaining required signatures and checks, EL, envelope, history, finality,
epoch boundaries, and the first tx. Only 3.436 ms remains within the nominal 7.324 ms for all of
that.

The next justified small experiment is one-signature ordinary verify versus batch1 on the same
inputs, with the same subgroup/zero/root/domain negatives. Then the integrated group path needs a
native measurement with **separate, non-nested** crypto setup/verify, state mutation/hash, and
required request stages. Existing histograms do not provide that breakdown. Positive-cache checks
must include PK/root/signature mutation, eviction/reverify, a failed batch with no warmed prefixes,
and compensating errors. Aggregate-PK checks must include all/partial/empty bits, repeated keys,
committee transitions, and infinity. These additional scenarios have not yet been run.

A narrow algorithm proven to complete all 8192 slots including the first tx in 60 s **has not been
found**. Known repeated PK/hash computations offer savings on the order of fractions of a
millisecond; there is no basis for claiming that they solve the remaining gap of tens of
milliseconds.
