# Honest warp: ephemeral group signer for sync committee

2026-09-30. The isolated crypto probe passed RED → GREEN; the client does not yet implement this
path. Results were read from saved reports; preparing this document does not change production code.
Related research: [worker/transport](warp-worker-research.md),
[overall one-minute budget](warp-one-minute-research.md), [TDD acceptance](warp-tdd-acceptance.md).

## Rationale and measurement budget

Same-message randomized MSM passed 14 isolated correctness tests, but its ≤2 ms component gate
remained RED: mean 3.329 ms cold / 4.229 ms warm, including the required subgroup check of every
individual signature. Sources: [candidate.json](../reports/warp-tdd/same-message/candidate.json),
[correctness](../reports/warp-tdd/same-message/candidate-correctness.txt). A 3.6–4.7× verifier gain
does not prove the same gain for the whole warp.

From the [signing baseline](../reports/warp-tdd/shared-hash/baseline.json): 64 ordinary signatures
of different roots took mean 20.234 ms with one persistent worker, 14.081 ms with two; p95 20.515 /
27.891 ms. Serial mean was 19.929 ms. This is a standalone surrogate executor, not a direct
measurement of the Lighthouse Rayon pool. Key generation is excluded; signing/serialization/job
scheduling are included. The shared hash-to-curve candidate then passed 7 tests: 64 signatures in
5.508 ms under the same two-worker configuration. Its ≤1 ms gate remained RED. At the user's
request, further investigation is limited to algorithms: thread count is no longer under study.

The preliminary gate established in advance for all sync crypto is **mean ≤3 ms per slot**.
Diagnostic allocation: 1 ms signing + 2 ms verification. The signing component includes lookup of
all live keys, construction of four sums, four signatures, serialization, and scheduling; the
verification component checks four contributions. Show both separately; retain p95 and the first
batch too. Sub-budgets do not replace the overall gate and are not separate passing release checks.
Cold aggregate-PK construction is measured and reported separately; it cannot be hidden in fixture
setup or omitted from the end-to-end total. Non-overlapping cold membership/PK preparation cost must
be added to the full slot path. A component PASS does not mean 8192 slots + the first tx already fit
within 60 s.

Saved [group-sync evidence](../reports/warp-tdd/group-sync/README.md):

| Result form       | Baseline mean | Candidate mean / p95 | Cold preparation | Mean ≤3 ms  |
| ----------------- | ------------: | -------------------: | ---------------: | ----------- |
| 4 × 128 positions |     26.020 ms |     2.331 / 2.458 ms |         0.307 ms | RED → GREEN |
| 1 × 512 positions |     27.816 ms |     1.563 / 1.612 ms |         0.266 ms | RED → GREEN |

Four-group candidate: 12 tests PASS. Full-shape candidate: 12 library + 2 CLI tests PASS. Checks
covered byte equality, multiplicities, live-key replacement/missing keys, zero cases, subgroup, and
zeroization. This is standalone blst 0.3.17, 8 timed batches with different roots in an unchanged
Linux ARM64 test environment. It does not check Lighthouse API/pool, actual keymanager lifecycle,
production guard, restart/skip, Pectra native compatibility, or whole warp. Cold preparation is
reported separately; component gains do not automatically transfer to the network.

## Original option: four contributions

| Representation                                | Compatibility with the existing client                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four real `SyncCommitteeContribution` objects | Standard `op_pool.insert_sync_contribution` already accepts this type; production assembles `SyncAggregate` normally.                                                         |
| One real full `SyncAggregate`                 | Fewer crypto operations, but the pool stores contributions. Four subnet signatures cannot be recovered from one full signature; an additional pool/production path is needed. |

The four-contribution candidate was investigated first; a full aggregate is assessed separately
below, and the choice between them is not yet made. In Gloas,
`beacon_node/operation_pool/src/lib.rs:119` accepts a contribution without a
`VerifiedSyncContribution` wrapper and assumes the caller has already verified its signature.
`get_sync_aggregate` (`:165`) selects the pool by `(state.slot − 1, block_root)` and calls
`SyncAggregate::from_contributions`. In Pectra, the same insertion point is around `:110`. The pool
itself, its pruning, and production remain unchanged.

Do not fabricate a `VerifiedSyncContribution`: the ordinary verifier also checks the selection proof
and aggregator-wrapper signature. The controlled endpoint accepts local contributions for block
inclusion without pretending they are verified gossip `SignedContributionAndProof` objects.

## Algorithm and mathematical equivalence

For one slot, all sync committee positions sign one full signing root `m`. Let `c[j,i]` be the
number of positions of key `i` in subnet `j`. Within one call, the VC computes:

```text
s[j] = Σ_i c[j,i] · sk[i] mod r
signature[j] = s[j] · H(m)
             = Σ_i c[j,i] · Sign(sk[i], m)
```

This is the same BLS aggregate signature, including byte-for-byte canonical serialization, as
aggregating ordinary individual signatures with the same multiplicities. It does not authorize
publishing arbitrary individual signatures or treating invalid original messages as valid. The new
path's inputs are actually available VC keys and exact protocol duties.

The VC receives the existing `SyncDuty`: `pubkey`, `validator_index`, and
`validator_sync_committee_indices`. The last field describes positions, not unique keys. First
validate ranges and exact once-only coverage of 512 positions; repeated pubkeys are valid, repeated
positions in the description are an error. Do not replace 512 positions with a list of 64 unique
validators without accounting for multiplicities.

One blocking job takes a read lock on current `InitializedValidators`, resolves each participating
pubkey through `signing_method()`, checks that the key is local, and performs ephemeral sums/signing
before releasing the lock. `initialized_validators/src/lib.rs:570` returns a signer only for known
enabled validators. The lock is not held across an async await; it is acquired inside the blocking
closure. Only four contributions leave that closure, not scalar/secret-key material.

This defines a linearization point with keymanager DELETE/disable: disabling completed before lookup
already prevents signing a new batch; disabling during the short read lock waits for the batch to
finish. After successful deletion, the next batch performs lookup again. Do not retain key groups,
scalar sums, or Arc signing methods across slots. An ordinary cached public committee does not
authorize use of a disabled private key.

## Secret arithmetic and zero cases

Secret arithmetic must live in a small private BLS helper. Prefer blst field operations over Fr to
variable-length BigInt. Borrow original secret keys; temporary scalar/Fr/byte buffers use Drop
zeroize, with no Debug/serialization/logging or implicit Clone of a secret accumulator. Return only
the public signature. If an adapter needs secret serialization, keep it in a zeroizing buffer until
conversion; an ordinary `[u8;32]` without clearing is unsuitable.

An intermediate sum may be zero while the final sum is nonzero. Checking each step as valid
SecretKey construction is therefore wrong: `crypto/bls/src/generic_secret_key.rs:80` rejects zero.
The accumulator must allow zero as an ordinary Fr element. A final nonzero value becomes a
short-lived SecretKey and signs the standard root.

A final zero in any subnet sends the **entire batch** through the previous individual-message /
direct-sync path. Do not send an infinity contribution to the new endpoint: a separate contribution
verifier will reject it. This does not prove the final full SyncAggregate is invalid. For example,
subnet 0 formed from pairs `sk=1` and `sk=r−1` gives infinity, but the other subnets with `sk=2`
produce a nonzero full signature. The old direct-sync path assembles contributions from verified
individual messages and can construct a normally valid full aggregate without separate contribution
verification.

If the full nonempty committee has zero aggregate PK/signature, ordinary upstream rejection applies.
This is not the empty-aggregate exception: `generic_aggregate_signature.rs:191–214` permits the
special infinity case only for an empty set in `eth_fast_aggregate_verify`. Controlled full-coverage
mode itself does not permit an empty set. Do not introduce a signature bypass for a zero fixture.

Confirmed primary APIs already exist in Pectra blst 0.3.14:
[exports.c](https://github.com/supranational/blst/blob/v0.3.14/src/exports.c#L22) contains
`blst_fr_add` (:22), `blst_fr_from_scalar` (:67), `blst_scalar_from_fr` (:83), and `blst_sk_check`
(:104). Fr addition allows zero; `blst_sk_add_n_check` (:107) must not justify aborting summation on
a zero prefix. Required example: `1 + (r−1) + 2`.
[Rust bindings](https://github.com/supranational/blst/blob/v0.3.14/bindings/rust/src/lib.rs) provide
`From<&SecretKey> for &blst_scalar` and checked `TryFrom<&blst_scalar> for &SecretKey`; the latter
rejects zero. Lighthouse's original `GenericSecretKey::point()` borrows the underlying key. This
avoids serializing original SKs and allows signing through a borrowed final scalar.

Although an owned blst SecretKey has `#[zeroize(drop)]`, a borrowed view of the final scalar clears
nothing itself. Our Drop guard must clear the created `fr.l` and `scalar.b`, including scratch, on
success and error. Do not return that borrow or make unprotected by-value copies. These APIs were
confirmed from source; the standalone group implementation with blst 0.3.17 has already compiled and
passed tests in the probe above. Gloas integration and native compatibility with Pectra blst 0.3.14
remain release gates.

## BN admission: independent participant verification

Expose the new route only in controlled mode; example name `/lighthouse/chronix/sync_contributions`.
Use the existing BeaconNodeHttpClient and contribution types, without sending keys or a VC-proposed
aggregate public key. Bound JSON size and limit the count to four elements.

The BN derives root, committee, fork, and genesis root from **one pinned head snapshot**. Select the
committee with `snapshot.beacon_state.get_built_sync_committee((slot + 1).epoch(...), spec)`.
`BeaconChain::sync_committee_at_next_slot(slot)` (`beacon_chain.rs:1408` in Gloas) confirms the
epoch-selection rule, but rereads canonical head itself: two separate root checks around it do not
bind committee to root across an A→B→A transition. Admission must therefore not mix these reads.
Membership belongs to **slot + 1**, while sync signing epoch belongs to **slot**.
Fork/domain/genesis root come through the standard path from the same snapshot. For each subnet, the
BN independently obtains all 128 public-key positions with multiplicities and calls
`sync_committee_contribution_signature_set_from_pubkeys(...).verify()`
(`consensus/state_processing/src/per_block_processing/signature_sets.rs:738`). This is ordinary
verification of a real aggregate signature, including signature subgroup checks; public keys come
from the BN's own validated pubkey cache.

Before changing the pool, validate all four elements: same slot/root, current controlled slot,
canonical root, subnet indices exactly 0–3 without duplicates, all bits set, and all signatures
valid. After verification, recheck current root and controlled slot. Then insert four contributions
using the existing method and set the existing `sync_contributions_<root>` mark. Any element's
failure prevents full completion. An identical valid batch may be idempotent: the existing pool does
not replace a contribution with one having the same bit count.

Admission to a candidate pool does not prove EL VALID. The existing independent controller barrier
checks Gloas envelope/EL agreement and the exact root before phase completion; it must not be
removed. The root mark confirms sync coverage, not payload execution.

## Additional opportunity: the aggregate public key is already in state

`SyncCommittee` stores `aggregate_pubkey` alongside the full list
(`types/src/sync_committee/
sync_committee.rs:39`). Gloas
`types/src/state/beacon_state.rs:1770–1794` computes it by ordinary aggregation of all selected
pubkeys, including repeats. `get_built_sync_committee` (:1677; Pectra
`types/src/beacon_state.rs:1154`) selects the current/next committee for the requested epoch.

Currently, `sync_aggregate_signature_set` gathers all 512 participant keys again when all bits are
set (Gloas `signature_sets.rs:814–850`, Pectra `:627–661`). A separate controlled-only fullbits
branch can decompress `committee.aggregate_pubkey` and construct `SignatureSet::single_pubkey` with
the same signature, message, and domain. Partial bits and the empty/infinity special case retain the
ordinary path. No shared mutable public-key cache is required.

Use `PublicKeyBytes::decompress()` specifically, with normal validation: the `decompressor` callback
normally looks up a validator-registry key, and the whole-committee aggregate PK is not in that
registry. Also, `get_built_sync_committee` does not itself check that the stored aggregate matches
the pubkey list. Equivalence relies on the invariant of real, locally computed consensus state; this
shortcut cannot be applied to arbitrary untrusted supplied state without separate justification or
verification. The oracle must compare both paths on real states before/after a period transition,
repeated keys, and corrupted signatures, including fallback for an unusable aggregate PK.

This opportunity applies to full-aggregate verification inside a block. It **does not replace** the
four subnet PKs when admitting four contributions: checking only their sum can hide compensating
errors in individual contributions. No timings for this shortcut have been measured yet; do not
credit assumed gains to the budget in advance.

## Research alternative: one full SyncAggregate

This variant's crypto component was measured above; client integration is not implemented. The
initial assessment that a full aggregate necessarily requires a major pool redesign was too strong.
`OperationPool::get_sync_aggregate` (Gloas `beacon_node/operation_pool/src/lib.rs:165`, Pectra
`:156`) already derives the exact key `(state.slot() - 1, state.get_block_root(state.slot() - 1))`.
Before the existing contribution assembly, add a lookup of one bounded
`Option<(slot, root, verified_full_aggregate)>`. An exact-key match returns a clone of the prepared
aggregate; a mismatch retains the old path. The signature need not be split into four parts. Both
production call sites remain unchanged: Gloas `block_production/gloas.rs:630` and pre-Gloas
`beacon_chain.rs:6029`.

The VC rechecks live local keys and exact coverage of every committee position, computes one
ephemeral weighted scalar and one real signature. Existing borrow/zeroize, missing-key, remote-key
fallback, exit, and domain rules remain. An intermediate zero scalar is valid; a zero sum in one
subnet no longer needs fallback because there is no separate subnet signature. If the whole
committee's sum is zero, preserve the ordinary upstream result through the old path, without
accepting infinity for a nonempty committee. The new endpoint accepts only slot, block root, and the
full aggregate; it does not accept an aggregate public key from the VC.

The BN takes one snapshot, checks current slot/root and all 512 bits, selects the committee for
slot + 1, decompresses and validates its `aggregate_pubkey`, and performs real BLS verification with
the sync domain for the slot. This is a separate admission boundary for the full result. It does not
try to prove correctness of four individual contributions, which do not exist here. Trust in the
stored aggregate PK is limited to the invariant of the BN's own valid consensus state described
above. After checking current root/slot, the BN stores the result and only then sets the root-bound
coverage mark. Ordinary block import, state-root verification, transitions, and independent EL
agreement remain.

The additional storage contract needs explicit rules:

- Insertion and lookup operate only in explicitly selected controlled full-sync mode; ordinary mode
  and a restored ordinary pool do not use the field. Ordinary partial aggregates retain the previous
  path; honest full-sync production requires a full result under the rule below.
- Check root and slot before replacement. A late request for an old slot cannot evict the current
  entry; an identical valid request is idempotent. A corrupt request changes neither entry nor mark.
- Lookup uses the block root from the **supplied production state**, not the latest clock/head
  value. This protects reorg production from an aggregate belonging to another branch.
- `prune_sync_contributions` (:193; Pectra :184) also clears an entry older than the previous slot.
  A bounded Option limits memory even without pruning, but does not remove the stale-ID check.
- Existing `sync_contributions` are actually persisted in `PersistedOperationPoolV20`
  (`persistence.rs:38,70,112`). Missing persistence for the new entry is therefore an explicit
  difference, not full equivalence to the existing pool. The field may be ephemeral without a schema
  change only under a bounded fault/reset contract. In that case, `persistence.rs:207` and `Default`
  initialize `None`; reset creates an empty pool. Losing this single batch on BN restart before the
  next proposal must cause fault/reset or proven readmission. Do not silently continue with an empty
  aggregate and penalties. If transparent restart is required, persistence/replay becomes a separate
  change.
- Pool `PartialEq` (:887) and observability must explicitly account for the chosen transient
  semantics. Do not falsify `num_sync_contributions()` to report four received contributions;
  coverage is confirmed by the real block/state and a separate correct mark.

The current documented crash contract already requires down/up: [usage](usage.md), limitations
section, and [plan](plan.md), resume item. W16 in [acceptance](warp-tdd-acceptance.md) explicitly
allows fault/reset without automatic resume. The clock is also nonpersistent:
`controlled_clock.rs:11–20,59` keeps time and marks in memory, while `network.ts:96–101` sets the
initial time to genesis + 11.5 s in the launch environment. This supports a limited scope, but does
not yet guarantee that a live controller detects an arbitrary BN restart: `Consensus.connect`
compares clocks only on connection, and a later advance may supply a later time again. The
native/live failure gate must establish a bounded error before the next proposal, or require a
separate minimal restart guard. Until then, the ephemeral variant is not release-ready. Storing a
full signature as fake subnet contributions is prohibited.

### More local protection: production requires a full aggregate

The preferred next investigation is a production precondition, not an end-to-end nonce protocol for
all Clock APIs. In explicitly selected controlled full-sync mode, replace fallback to an empty
aggregate with an error when the required full result is missing. Locations before
`unwrap_or_else(SyncAggregate::new)` are Gloas `block_production/gloas.rs:628`, the same client's
pre-Gloas path `beacon_chain.rs:6027`, and Pectra `beacon_chain.rs:5410`. Both versions already have
`BlockProductionError::MissingSyncAggregate` (`errors.rs:328` and `:293`). Check both `None` and
incomplete bits; mere presence of an object is insufficient.

Take parent slot from `state.latest_block_header().slot` in the same production state after
`complete_state_advance`, and parent root from that production snapshot's context. Do not reread
live head to decide whether an exception is allowed. Pool lookup already binds the aggregate to
`state.slot() - 1` and the corresponding block root. Admission remains real BLS verification; a bit
precondition does not turn an unchecked signature into a verified one. Ordinary import verification
and EL checks remain.

Bootstrap is allowed only when both `proposed_slot == spec.genesis_slot + 1` and
`parent_root == chain.genesis_block_root`. This exception covers absent genesis-slot duties, not
"the first request after startup". In an ordinary consecutive proposal, a missing full aggregate
returns a production error before the VC receives the unsigned block and calls
`validator_store.sign_block` (`validator_services/block_service.rs:546`). A block already obtained
before restart with a real full aggregate remains valid regardless of the pool's lifetime.

**A gap in honest full-sync mode also fails closed.** The condition
`parent_slot < proposed_slot - 1` does not prove explicit skip: it can occur after a failure,
restoration of an old head, or a future-slot request. A `skipSlots` exception needs explicit
authorization for the specific proposal slot and parent root; losing authorization after restart
must block production, not broaden the exception. Ordinary mode retains its existing rules for
empty/partial aggregates and gaps.

Existing Gloas `prepare_controlled_skip` is not such authorization:
`bakes/gloas/native/prepare_skip.rs:9–16` automatically notices a head lag greater than 32 slots and
caches transitions up to `current_slot + 1`. It receives neither the original user command nor an
authorized slot/root pair. The timer sets `skip_ready` after every successful per-slot task
(`bakes/gloas/patch.py:97–102`), including when preparation did nothing. Runtime
`Network.skipValidator` (:330–374) knows the explicit operation and target time, but sends only a
normal BN `/advance` and reads this mark. Small skips ≤32 never enter preparation. Therefore,
neither a large gap, `skip_ready`, nor cached advanced state can serve as a permit. A future
target-bound signal could originate from this explicit runtime call, but none exists yet.

Until separate TDD for explicit skip, the default remains unchanged and the full-sync variant is not
released. Required checks: lost Option after admission/mark, missing/partial/stale root, strict
bootstrap, unexpected gap, explicit skip of 1/32/33 slots and the first subsequent consecutive
proposal, restart before and after receiving the unsigned block, and ordinary mode. A later
Base→Altair transition also needs explicit analysis of the first sync-enabled block; current
Pectra/Gloas start with sync duties at genesis. The production guard itself is estimated at tens of
lines in two production locations, separate from mode wiring, a target-bound skip signal, and tests.
Do not claim savings or completed restart safety yet.

In cryptographic operation count, this is 1 sign + 1 admission verify instead of 4 + 4, without a
subnet PK cache or assembly of 512 signature positions. The diff adds `operation_pool/lib.rs` and
initialization in `persistence.rs`, while simplifying contribution validation and subnet
bookkeeping. The preliminary estimate remains around **300–500 production lines, about 9–11 Rust
files**, including private BLS helper/export, VC trait/store/service, HTTP client/route/admission,
and pool; this is an unverified estimate, excluding tests and profile glue. It may be smaller than
the four-contribution variant with a public-key cache, but only an actual diff can establish that. A
small new storage branch is not a new consensus state machine, yet its restart/reorg contract is
mandatory.

Minimal TDD adds these to shared gates: byte equality of the full aggregate with ordinary
512-position aggregation; zero subnet + nonzero full aggregate; final full zero; stale root/slot,
ABA snapshot, period boundary, corrupt state aggregate PK, partial bits, idempotent duplicates, and
out-of-order replacement; prune/reset/BN restart after admission; ordinary mode; a block accepted by
an unchanged clean-upstream verifier. Measure whole-crypto-path speed separately from correctness
and from 8192-slot warp. Standalone mean ≤3 ms is already confirmed; the integrated slot path and
≤60 s are not proven.

## Research opportunity: reuse exact BLS results

Current `crypto/bls/src/impls/blst.rs:257` uses the positive cache only for single-key
`fast_aggregate_verify`. Batch `verify_signature_sets` (:36–119), called by block import through
`block_signature_verifier.rs:460`, does not read this cache. Even full-aggregate admission with the
same root/domain/signature therefore does not eliminate repeated BLS verification inside the block.

A separate controlled-only candidate: after ordinary aggregate-public-key construction, look up the
canonical tuple `(domain-bound signing root, aggregate PK bytes, signature bytes)` in the bounded
success cache. Only misses go to the previous randomized batch verifier; new successes are added
only after the entire verification succeeds. Do not cache false, expose an external insertion API,
or replace membership/bitfield/state checks with cache presence. An initially empty batch retains
its previous behavior; a nonempty batch consisting only of proven hits may succeed. This reuses an
established cryptographic fact, rather than applying `NoVerification` to an unchecked input.

The fullbits state-PK shortcut lets admission and import obtain the same tuple without summing 512
public keys again. For other sets, the exact aggregate PK must still be obtained normally first.
Differential tests are needed for root/domain/key/signature changes, partial misses, an invalid
batch element, eviction, and ordinary mode. Neither real-warp hit rate nor timing gains from this
extension have been measured; they cannot be credited to the budget in advance.

General-verifier boundaries: cache capacity 512 bounds memory, not the allowed `SignatureSet` batch
size. Existing `chronix_verified_signature::verify_batch` rejects >512 inputs, so it cannot directly
replace the upstream general verifier. A test with 513 valid sets is mandatory. Structural checks,
signature-point presence, subgroup, a nonempty key list, and current aggregate-PK computation occur
before lookup. All-hits is valid for a nonempty batch; an initially empty batch retains its previous
rejection. A failed miss-batch must not warm even its valid prefix.

With fixed Ethereum POP DST and empty augmentation, the full tuple is sufficient for repeated
cryptographic verification. This fact does not distinguish different membership lists with the same
aggregate PK, so membership/bitfield/indices are checked separately. If DST/augmentation become
parameters, the cache namespace must include them. The existing cache also accepts success from a
randomized 64-bit batch: reuse retains that probabilistic guarantee, rather than establishing an
independent recheck. The most conservative first version could read only positives from ordinary
single verification; provenance and the hit rate under this restriction are not yet implemented.

## Separate Gloas PTC opportunity: public-point multiplicities

PTC does not replicate the sync committee workload. `compute_ptc_with_cache`
(`types/src/state/beacon_state.rs:3610–3637`) selects 512 positions from the attestation committees
**of this slot**. With 64 validators and 32 slots, this means two distinct validator keys per slot,
repeated in PTC. The VC takes one `PayloadAttestationData` and signs it for both duties
(`validator_services/payload_attestation_service.rs:370–404`). The direct-sync measurement confirms
this: 64 BN gossip verifications over 32 advanced slots. After registry changes, derive the key
count from the actual PTC; do not hard-code "2" in the algorithm.

The message includes root, slot, `payload_present`, and `blob_data_available`
(`types/src/attestation/payload_attestation_data.rs`). In general, four different flag combinations
are possible; they cannot be aggregated as one signing root. The VC currently gets flags through the
standard API from actual envelope/availability observations (`beacon_chain.rs:2200–2260`). Do not
substitute expected true/true values in advance.

The pinned signer uses `Domain::PTCAttester`, live-key lookup, and
`doppelganger_bypassed_signing_method` (`lighthouse_validator_store/src/lib.rs:1442–1469`). This
helper is explicitly intended for non-slashable messages (:265), and the PTC path does not call the
slashing DB. This is a property of this pinned PTC path, not permission to bypass protection for
blocks/attestations. Retaining ordinary individual PTC signatures preserves keymanager/remote/exit
lifecycle without a new secret API.

Instead of groupSK, first test a smaller change here:

```text
ordinary: Σ over all occupied PTC positions signature[validator(position)]
candidate: Σ over distinct validators c[i] · signature[i]
```

The same equality holds for public keys. Derive every `c[i]` from exact positions/aggregation bits;
discarding repeated positions would change the signature and is prohibited. Public integer
double-and-add for `c>0` requires `floor(log2(c))` doublings and `popcount(c)-1` additions, followed
by summing results from different keys. For two nonzero weights totaling 512, this is at most 24
group operations instead of about 512, separately in G2 for signatures and G1 for keys. This is an
operation-count estimate, not measured speed: doubles/adds, cloning, and preparation have their own
costs.

Locations: `operation_pool/src/lib.rs:243–266` currently adds a signature once per position;
`state_processing/.../signature_sets.rs:389–406` collects repeated PTC public keys, then
`bls/src/impls/blst.rs:94–103` aggregates the list again. A narrow accumulation change preserves
ordinary messages, API, per-validator verification, vote observation, fork choice, and state. The
signature helper can use existing `AggregateSignature::add_assign_aggregate` and clone; the
public-key helper needs a small safe wrapper over backend point addition. Different messages or an
unusual representation use the old path.

A new direct aggregate API is mathematically possible, but more complex and not the first candidate
here: `PtcDuty` contains only pubkey/index/slot (`common/eth2/src/types.rs:859`), not
multiplicities, so the VC would also need reliable positional context. Further, the ordinary
verifier accepts only the first valid vote for `(slot, validator)`
(`payload_attestation_verification/
gossip_verified_payload_attestation.rs:61–73,147–158`). Fork
choice then **overwrites** flags (`proto_array_fork_choice.rs:727–737`). After accepting
false/false, a later true/true aggregate from the same validators must not bypass the observed
guard. Grouping must account for the full datum. Do not fabricate individual messages/Verified
wrappers from an aggregate.

Indexed PTC also permits repeated validator indices. Passing a weighted 512-entry aggregate to
existing `on_payload_attestation` (:1450–1487) expands each validator into all its positions again;
a new endpoint therefore does not guarantee savings even after reducing BLS work. Deduplicating only
the application of identical vote effects could be a separate equivalent optimization, but must not
change cryptographic attestation weights or declare a modified indexed object verified. The
preferred public-point accumulation path does not change fork choice at all.

Data from `metrics-direct-sync-{bn,vc}-{before,after}.txt`, the same 32-advanced-slot window:

| Timer                                     | Delta / 32 |
| ----------------------------------------- | ---------: |
| VC PTC sign-and-publish, including POST   |   5.966 ms |
| Nested VC POST                            |   5.013 ms |
| Sign-and-publish remainder excluding POST |   0.954 ms |
| BN gossip verification, 64 calls          |   4.378 ms |
| VC data GET                               |  10.872 ms |
| BN data production                        |  0.0049 ms |

Timers are nested/overlapping and cannot be summed into the slot budget. The 0.954 ms remainder
includes signing and other local work; it is not a pure BLS benchmark. Signature/PK accumulation has
not been measured separately. PTC 2→1 signing alone does not look like the main opportunity and does
not prove one-minute warp.

Next isolated TDD probe, not yet executed: the baseline performs standard 512-position signature and
PK additions; the candidate counts exact multiplicities and performs public double-and-add.
Signatures and validated keys are identical in both paths; exclude unchanged signing from both
timers. Show preparation/counting, G2 accumulation, G1 accumulation, and whole construction with the
same required BLS verification separately. Do not charge an independent byte-equality oracle twice
to one path. Proposed gate before running: with 2 and 8 distinct keys, candidate mean construction
must be at most 50% of baseline, and mean construction + verify must not exceed baseline; also
report p95 and the cold batch. This is a usefulness criterion for the microalgorithm, not a promise
of network latency. With 512 distinct keys, the old path must remain without regression. Save the
baseline before implementing the candidate; a realistic warm cycle uses at least 64 distinct signing
roots with all 512 positions in an unchanged test environment.

Correctness: 1/2/8/64/512 distinct keys, weights 0/1/2/255/256/257/511/512, partial/full bits,
permutations, multiple data flags/root/domain, cancellation/infinity, malformed input, and corrupted
signatures. For every case, compare canonical aggregate-signature/PK bytes, bits, and the previous
verification result. Native differential checks: `duplicate_after_valid`, `packs_by_ptc_weight`,
`payload_attestation_sets_all_duplicate_ptc_positions`, `multiple_data_combos_capped`, side-chain
PTC, identical fork-choice votes, and final block/state. No new vote admission or ordering changes.
The absolute gain and effect on 60 s remain unknown.

## Lifecycle and compatibility

- **Missing/disabled key:** diagnostic failure; no substituted key, cached groupSK, or incomplete
  successful batch. If duty polling already excluded the key, full-position coverage still detects
  the shortage. Deleting a file from disk without updating the VC registry is not equivalent to
  keymanager DELETE; do not claim a stronger guarantee than upstream key lifecycle provides.
- **Remote signer:** the narrow group path requires all keys to be local. With Web3Signer, use the
  entire previous individual path. Do not conflate `not local / unsupported` with
  `missing / disabled`.
- **Exit:** do not filter the current sync committee by the active-validator list. An exited
  validator may still be assigned for the current period. Committee/indices are the source of truth.
- **Period/fork/reorg:** retain existing duty polling; rebuild the next group. The BN independently
  checks the committee for slot + 1 and the signed root. Incorrect stale duties do not become a
  successful mark.
- **Slashing protection:** blocks, attestations, SQLite signing history, and PTC are unchanged. Sync
  messages already use the non-slashable signer path in `lighthouse_validator_store/src/lib.rs:768`;
  the new API must not accept arbitrary domains.
- **Observability:** four aggregate signing jobs must not be logged as 64 completed individual jobs.
  Economics/coverage are checked from real state, not the job counter.

## Change scope: estimate before implementation

The estimate of **300–500 production lines, about 8 Rust files / 7 logical modules** has not yet
been checked against an actual diff. Patch/install glue, profile sourceFiles/nativeTests, and tests
are additional. This is neither "20 lines" nor a completed implementation. Expected areas:

1. Private BLS ephemeral scalar helper and its export.
2. `ValidatorStore` method with narrow sync-only arguments.
3. `LighthouseValidatorStore`: live-key lookup, signing context, blocking job.
4. `validator_services/sync_committee_service.rs`: controlled branch, existing fallback.
5. `common/eth2/src/lib.rs`: typed HTTP client method.
6. `beacon_node/http_api/src/lib.rs`: controlled-only routing.
7. BN admission handler next to `http_api/src/sync_committees.rs`, reusing the existing
   signature-set helper and op_pool. Do not change consensus transitions, production, or pool
   representation.

Pectra sends individual sync messages through a different VC service/trait shape; the shared helper
is portable, but the two installation points are checked independently. The default/baseline client
does not use the new route or group signer.

## Executed probe and remaining release gates

Standalone baseline and candidate for both forms are preserved in
[reports/warp-tdd/group-sync](../reports/warp-tdd/group-sync/README.md), including sources and RED →
GREEN. The baseline uses 64 ordinary signatures, ordinary randomized verification, and position
aggregation; the candidate uses ephemeral sums and real result verification. Independent repeated
oracle verifications are excluded from both timers. The probe tests 1/2/64/512 **positions**, with
no more than 64 distinct keys. These tests do not satisfy the native/integration scenarios below.

Remaining acceptance matrix:

- Native byte equality of all four signatures and the final SyncAggregate with ordinary aggregation;
  different multiplicities, roots/domains, and supported validator-registry sizes.
- Intermediate zero → nonzero, final zero, mod-r wrap, empty set, wrong key/root/domain,
  invalid/repeated/out-of-range positions, one corrupted subnet, infinity/non-subgroup signature.
- Zero in one subnet with a nonzero full aggregate: whole-batch fallback through existing
  direct-sync yields the same block/state as ordinary signatures. The standalone oracle with
  mandatory per-subnet verification models a stricter boundary and does not replace this native
  differential check.
- Live lookup with deletion/disabling between batches, concurrent disable, stale duties, and remote
  signer; zeroize on success/error and no retained secrets in result/cache structures.
- Last slot of a period, next slot, fork boundary, exit with a remaining duty, and a deposit that
  becomes part of the next committee. The BN does not trust VC-supplied membership.
- Validate all four contributions before insertion; corruption/partial coverage/timeout prevent a
  full mark. Baseline mode does not expose the route. The existing pool and ordinary block import
  check the final aggregate; independent clean-upstream replay reaches the same consensus state.

Measure live lookup/scalar additions/signatures, serialization/job wait, four-signature
verification, cold/warm public-key aggregation, and the whole crypto path separately; exclude
fixture key generation, but do not hide cold preparation required in real operation. Do not justify
speedup only by signing-job count. After the standalone ≤3 ms component gate passes, a whole-path
32/256-slot gate including the first tx is needed; only then run the full two 8192-slot tests.
Integrated signer/admission cost and its effect on the remaining BN/EL serial path are unknown; **60
s is not proven**.

Each released bake independently requires red→green evidence, profile fingerprint, validator
economics/rewards, full duty coverage, real finality, EL/CL agreement, signing history, bounded
missing-key failure, and post-warp contract operation. W18 permits an aggregate signer with verified
equivalence, but does not waive the other W criteria.
