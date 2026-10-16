# Research cycle: honest warp in one minute

2026-09-30. Request: 8192 slots including the first subsequent transaction in ≤60 s, without a major
client rewrite. Honesty, economics, real signatures/finality, and failure-safety criteria remain.
The client implementation is unchanged in this cycle. Original results are in the
[experiment log](warp-experiments.md).

**Clarification after the first probes:** the user restricted further investigation to algorithms.
Thread counts and scheduling are no longer considered optimization options. Earlier comparisons are
preserved as measurement history; the next candidate is compared in an unchanged environment.

## Budget and claims already disproved

Current direct-sync: 32 slots in 2.956 s, about 92.38 ms/slot. Reaching 60 s requires ≤7.324
ms/slot, still minus the first tx: roughly a 12.6-fold speedup. Fewer signing jobs alone do not
establish a time saving. Do not repeat the large test that already took 12:40 without short-run
evidence of feasibility.

| Direct-sync observation         |     Value per slot | Interpretation                                                                          |
| ------------------------------- | -----------------: | --------------------------------------------------------------------------------------- |
| BN block production             |           7.269 ms | Includes preparation/cryptography/EL and nested stages.                                 |
| BN block processing             |           7.679 ms | Do not add nested timers again.                                                         |
| Envelope processing             |           3.489 ms | Includes EL; do not add newPayload twice.                                               |
| Production process + state root |   0.996 + 0.599 ms | Part of mandatory sequential work.                                                      |
| Import core + state root        |   0.111 + 0.620 ms | Small reuse opportunity; alone, it does not justify redesigning import.                 |
| Sync HTTP / VC sync publish     | 23.000 / 44.536 ms | These durations are nested/overlapping; do not sum them.                                |
| VC signing jobs                 |                 76 | 64 are individual sync signatures.                                                      |
| Engine getPayload / newPayload  |   1.647 / 3.185 ms | Include transport and real EL; separately measured gate readiness wait was nearly zero. |

CPU snapshots over 32 slots: EL 0.338 s, BN 2.792 s, VC 1.098 s. Retaining all this work under a 2
CPU limit gives conditional estimates of 43/357/141 s for 8192; these are **not physical lower
bounds**, since snapshot windows exceed the call and include background work. Still, a promise to
accelerate everything merely by removing HTTP is unsupported.

Clean upstream replay of 64 slots in 4.390 s is not a floor either. It lacks Chronix's already
applied `weighted_selection`; upstream repeats expensive Gloas rejection sampling. Persistent state
structures already reuse tree branches: the hypothesis of fully rehashing 8192 historical roots on
every slot was not confirmed.

## Rounds with subagents

| Round | Work                                                                             | Result                                                                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Independently: cryptographic mathematics; pipeline/transport; adversarial limits | Identified sync crypto, repeated verification, and host↔VM orchestration. A simple final-state formula does not reproduce history.                                                                                                     |
| 2     | Cross-review of group signer, post-state reuse, native driver                    | A long-lived groupSK would survive keystore deletion without invalidation. Import core + state root take ≈0.73 ms; the benefit of post-state reuse is not yet measured. A native driver must preserve one time source with EngineGate. |
| 3     | Narrower same-message BLS path and upstream API review                           | In blst 0.3.17, `verify_multiple_aggregate_signatures` does not combine identical messages. A 64-bit coefficient-packing risk was found; individual signatures can be preserved.                                                       |
| 4     | Local placement of existing TS runtime and early budget check                    | Consider a worker with the same Timeline/Automine, without a new consensus engine, keys, or Docker socket. Do not retain a second time owner on the host.                                                                              |

These are research findings, not four implemented optimizations. A separate short crypto probe must
distinguish real improvement from a plausible formula.

### Round 5: executed isolated probe

Before candidate implementation, the baseline was saved: 11 correctness tests passed, but
performance violated the preallocated ≤2 ms budget for 64 signatures. Only a research MSM helper was
then implemented, with no client changes. Its 14 tests passed, including a corrupted signature at
each position, wrong coefficient-packing stride, subgroup checks, and zero weighted PK.

| ARM64, 2 CPU, 32 batches of 64 signatures | Empty success cache | Cache filled with other roots |
| ----------------------------------------- | ------------------: | ----------------------------: |
| General batch, mean                       |           15.592 ms |                     15.065 ms |
| Same-message MSM, mean                    |            3.329 ms |                      4.229 ms |
| Same-message MSM, p95                     |            3.433 ms |                      7.660 ms |

RNG, subgroup checks, packing, serialization, and cache population are included. Key and signature
preparation are excluded from both measurements; this measures verification only. A 3.6–4.7-fold
component improvement is confirmed by one paired experiment. **The component gate remains RED**;
full warp was not measured. The subgroup diagnostic ran separately, so its time cannot be subtracted
from parallel MSM. Saved evidence:
[raw data, tests, and both source versions](../reports/warp-tdd/same-message/README.md).

A temporary aggregate signer is therefore reconsidered as the next candidate: the same
mathematically valid final signature, but fewer initial multiplications and objects to verify. There
will be no persistent secret-sum cache. It requires checking the current key set, exact
multiplicities, ordinary aggregate verification on the BN, and key-deletion tests. This is research,
not an implementation selected for release. Transport and the remaining budget are analyzed
separately in the [worker research](warp-worker-research.md).

### Round 6: signature creation cost

A separate ordinary `SK.sign` baseline passed 4 correctness tests. For 64 signatures over successive
changing roots: serial 19.929 ms; one persistent worker 20.234 ms; two workers 14.081 ms (p95 27.891
ms). With a repeated root, two workers gave 10.459 ms, but real blocks change the root. The mean/p95
≤1 ms budget is RED. There are eight samples; the pool models scheduling, not the entire Rayon/Tokio
VC. [Raw data](../reports/warp-tdd/shared-hash/baseline.json).

Test the simplest shared-H variant: compute the public point once inside each batch, then perform
all 64 ordinary secret multiplications. This probe needs no persistent cache. Separately investigate
four real subnet aggregates using a temporary key sum; these need a different controlled delivery
path, since the current 64 individual messages cannot be reconstructed from one aggregate signature.

The shared-H probe then ran: **7 tests PASS**, including byte equality of every signature and
ordinary verification. With changing roots: serial **10.855 ms**, one worker **10.731 ms**, two
workers **5.508 ms** (p95 **5.634 ms**). The public hash point is computed inside every measured
batch; there is no persistent cache. The ≤1 ms gate remains RED. Even this reduced signing cost
consumes much of the entire slot budget, so combining two crypto helpers does not justify promising
one minute. [Candidate, tests, and sources](../reports/warp-tdd/shared-hash/README.md).

### Round 7: ephemeral aggregate and full sync-path verification

Two paired experiments with real BLS cryptography ran in a fixed environment:

| Result form                             | Baseline mean | Candidate mean / p95 | Candidate cold preparation | Gate mean ≤3 ms |
| --------------------------------------- | ------------: | -------------------: | -------------------------: | --------------- |
| Four subnet aggregates of 128 positions |     26.020 ms |     2.331 / 2.458 ms |                   0.307 ms | RED → GREEN     |
| One full aggregate over 512 positions   |     27.816 ms |     1.563 / 1.612 ms |                   0.266 ms | RED → GREEN     |

The first baseline passed 9 tests; the candidate passed 12. Full baseline/candidate each passed 12
library + 2 CLI tests. An executed baseline was saved before enabling each candidate. Measurement
includes live key lookup, temporary scalar summation with exact multiplicities, signing,
serialization, and mandatory randomized BLS verification of results. Additional ordinary oracle
checks are excluded symmetrically. Eight samples do not establish long-run tail latency.

Group secrets are not retained; scratch is cleared on success/error/zero/unwind. Checks covered byte
equality, changed root/domain/key, missing/replaced keys, intermediate zero, a zero subnet with a
valid full aggregate, compensating errors, and non-subgroup inputs. A zero subnet sum requires
fallback of the **entire batch** to the ordinary individual path. These are component checks; native
pool/admission, restart, and post-warp operations have not yet run.
[Sources, errors, RED/GREEN, and reproduction](../reports/warp-tdd/group-sync/README.md).

A full aggregate is faster and uses the existing aggregate_pubkey from real state, but needs an
additional bounded pool entry and a fail-closed production guard. If the entry is lost, the BN must
fail before signing the next block rather than automatically substitute an empty SyncAggregate.
Strict bootstrap and explicitly authorized skip differ from an arbitrary gap. The current
`prepare_controlled_skip` does not establish that authorization.
[Contract and pinned-source locations](warp-group-sync-research.md).

This result provides a measured algorithmic opportunity **only for the sync component**. Standalone
baseline time cannot be subtracted from a 92.38 ms live slot as if it were an independent interval.
Repeated exact BLS checks and public aggregate-PK sums remain separate hypotheses; the remaining
serial budget requires a short integration measurement before any long run.

### Round 8: reviewing the remaining algorithmic budget

Independent reanalysis did not confirm a large hidden SSZ opportunity: the persistent tree cache is
already reused. Production/import are separate sequential stages, but their nested timers cannot be
added again. An exact crypto cache may remove duplicates, but the cost of one batch element is not
the cost of the entire batch. The smallest next reduction — ordinary verification of one aggregate
instead of general batch1 — has only a reference estimate of about 0.35 ms, without a separate A/B
yet. [Full breakdown, sources, and inference limits](warp-algorithm-budget.md).

With 64 validators, PTC and beacon attestations each have two distinct signers per slot. Grouping
them does not provide the former sync-scale reduction of 64→1. PTC contains 512 positions with
repeats; arithmetic can be combined by exact multiplicities without changing individual votes. New
aggregate admission must preserve the first-valid-vote guard: a signature does not authorize a
repeated vote to overwrite fork choice. For slashable attestations, the standard DB already
batch-checks every key and rejects unsafe/SameData; replacing the signer affects that contract and
was not selected as the first optimization.

### Round 9: redundant attestation wrappers

Two independent reviews confirmed that production in both pinned clients already transfers verified
naive aggregates into the ordinary operation pool. A separate direct-attestation API is therefore
probably unnecessary: investigate removing controlled selection proofs and local aggregate wrappers
while preserving individual signatures, the slashing DB, and standard packing. Earlier metrics put
the affected VC work at about **5.243 ms/slot**, not a proven whole-slot saving. The first two
individual BLS checks (**7.593 ms/slot**) remain; their cache entries do not equal the aggregate
tuple.

A significant condition was found: naive insertion may succeed after a fork-choice error, and an
input that is too old may return Ok without storing anything. An exact-data/full-participant BN
barrier with confirmed FC is therefore needed, followed by verification of the actual packed block;
a publication mark or full pool bits alone are insufficient. Restart, pruning, and split Gloas index
remain gates too. TDD must first show that upstream inclusion without wrappers already works, then
find RED in the new readiness/no-redundant-work requirement rather than inventing a broken baseline.
[Algorithm, measurements, and exact native criteria](warp-attestation-research.md).

## Main candidate: same history, less repeated work

### 1. Same-message randomized batch

All 64 sync votes for a given slot sign the same full signing root. Current
`verify_multiple_aggregate_signatures` handles them as the general case of different messages: it
repeats hash-to-curve and adds separate Miller-loop contributions. The library also has
`fast_aggregate_verify` for a shared message, but it checks the aggregate and does not establish
correctness of every original signature. Instead, generate fresh independent nonzero coefficients
`r_i` for a fixed input set, then compute:

```text
P = Σ r_i · PK_i
S = Σ r_i · signature_i
verify(S, P, signing_root)
```

These are two public MSMs and one BLS verification, which retains two Miller-loop pairs. Individual
signatures and membership are not replaced with "signatures on behalf of the network". Every
signature's subgroup check occurs before MSM. Mixed signing roots use the previous batch. A
degenerate weighted PK/infinity is not success; standard fallback is required. The exact positive
cache is populated only after the whole batch succeeds. This randomized verification model is
probabilistic in the same way as current upstream.

**Critical regression:** with `nbits=64`, MSM reads 8 bytes per coefficient. Passing contiguous
32-byte `blst_scalar` values would make most coefficients zero, causing corrupted inputs to
disappear from verification. The test modifies each of the 64 positions in turn. Other negative
scenarios: swapped signatures, compensating errors, wrong root/DST, wrong subgroup, infinity, empty
batch, and a duplicate pubkey with a different signature. A simple sum without random coefficients
is unacceptable.

The local change point is existing `bakes/shared/native/verified_signature.rs`, without a new
consensus state transition. Start with an isolated harness. The API was checked for Gloas blst
0.3.17; Pectra blst 0.3.14 needs a separate compatibility check.

Primary sources:
[pinned Rust API and test_multi_point](https://raw.githubusercontent.com/supranational/blst/v0.3.17/bindings/rust/src/lib.rs),
[pinned C aggregation](https://raw.githubusercontent.com/supranational/blst/v0.3.17/src/aggregate.c),
[BLS CoreSign/Aggregate](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-bls-signature-06).

### 2. Preserve 64 signatures, compute the shared public part once

For one root, compute public `H(root)` once, then perform each key's ordinary secret multiplication.
The cache is bounded and stores only public points and the entire cryptographic context; the first
miss uses single-flight, with the lock released before multiplications. The secret need not be
serialized: blst provides a scalar reference. Existing key lookup, signing jobs, and slashing flow
remain; every signature must match the ordinary one byte for byte.

64 scalar multiplications and 64 Rayon jobs remain. Public MSM does not replace 64 signatures and
must not be used with secret coefficients. This is a candidate for a measured probe, not a promised
64-fold speedup.

### 3. Verify the same cryptographic fact once

The existing bounded one-key success cache already produced a measured gain. An additional candidate
is to use it in `verify_signature_sets`, where blocks currently recheck signatures already verified
in gossip. Key: exact `(aggregatePK, signingRoot, signature)` under fixed algorithm/DST. A separate
public aggregatePK cache is built from the exact key set and multiplicities. Membership/slot/root
changes, coverage, and structure are still checked by ordinary code.

Creating a signature is not verification; the cache cannot be prefilled with success merely because
an object was created locally. A prepared production state does not confirm all signatures either:
`ProduceBlockVerification::VerifyRandao` checks only RANDAO. Standard `SignatureVerifiedBlock::new`
does create a private witness after verifying signatures.

### 4. Historical transport option — further research stopped

**After the user's clarification, this option is no longer being investigated.** Earlier
observations are preserved below, not an active plan. Crypto alone does not yet guarantee one
minute. Currently there are five phases × two clock endpoints, and clock HTTP closes every
connection. In the historical v3 trace, all 352 clock calls totaled 433.001 ms over 32 slots, or
13.53 ms/slot. The 1.23 ms per-call average combines GET and POST; the cost of the ten advances
specifically was not measured separately. This is a historical trace, not a measurement of a new
topology.

Another risk is polling in `src/http.ts::waitFor`: after the first not-ready response or error, it
schedules a real 10 ms sleep if enough time remains before the deadline. This already exceeds the
average 7.324 ms slot budget if such a miss occurs on every slot's sequential path. Actual frequency
has not yet been measured; subsequent pauses grow to 250 ms. A short probe needs attempts, not-ready
reasons, and actual sleep time at each wait site, separately for head, EL/CL agreement, and the
first tx. Faster transport may merely reach not-ready sooner, so moving to a worker alone does not
remove this risk or establish one-minute feasibility.

Prefer first investigating an owned TS worker inside the Docker network with the same `Timeline`,
`Consensus`, and `Automine`. The host retains lifecycle and the public localhost boundary; the
worker is the sole owner of advancement and local RPC/automine notify. It receives neither Docker
socket nor validator keys. All time methods and transaction submissions pass through one owner;
otherwise a second Timeline and automine races appear. The move must not duplicate
Controller/consensus logic.

An additional narrow Engine hook: direct BN→EL for FCU/newPayload, while retaining the existing host
gate for `getPayloadV*` and proven full-payload readiness. Before FCU in the controlled CL, filter
future attributes against the actual controlled clock, **before** the payload-ID cache. Do not
authorize the end-of-warp time in advance: that changes pause/expiry behavior. JWT and real
deadlines remain. An empty txpool is not used to justify an early unprepared payload.

Transitions, state roots, Geth execution, envelope/PTC, storage, and fork choice remain standard.
This changes placement and adds small hooks; moving keys into the BN, manually constructing
`BlockImportData`, and a new consensus executor are outside the chosen narrow design.

## Options not selected first

- Persistent group secret keys: dangerous invalidation on DELETE/add/committee change. A temporary
  weighted sum through current local keys has already passed a component probe; new admission/pool
  interaction and native failure tests remain mandatory before integration.
- Production post-state caching to skip the import transition: measured import core + state root
  take about 0.73 ms/slot. This estimates a potential saving, not a measured reuse gain;
  intervention in import/finality/storage is substantial.
- A formulaic jump based only on start and end: RANDAO, parent roots, withdrawals, finality-gated
  deposits, and Gloas parent execution requests depend on real intermediate transitions.
- Skipped signature checks, artificial participation/rewards/finality, deferred history, or a slow
  first tx: these violate the original contract.

## Early falsification and TDD

1. Record a separate crypto-harness baseline: 64 valid signatures, real subgroup checks, RNG,
   packing, cache/serialization included. The preliminary allocated sync-verification budget is ≤2
   ms per slot out of the total 7.324 ms. This is a component-budget hypothesis, not proof of a full
   60 s result. Run the baseline and save its result first; only then write the candidate.
2. Check negative inputs and differential equivalence. Compare 1/2/64/512 inputs, cold/warm,
   same/different roots; show signing and verification separately. A build error is not RED.
3. Only if the probe provides enough savings, integrate narrowly with the same
   W03/W04/W06/W07/W08/W15/W18 checks. The first live stage is 32 slots + tx; next is 256. Trace
   sequential and overlapping stages without summing nested timers. For `waitFor`, measure attempts
   and actual sleep; for clock calls, separate GET/POST and endpoints.
4. Early gate: `setup + steady_slot_cost ×8192 + first_tx ≤60s`, accounting for real epoch and
   committee transitions. Simple linear extrapolation from 32→8192 is only preliminary screening,
   not acceptance. If exceeded without a concrete measured opportunity, stop this option before a
   long run.
5. Only then run two 8192-slot advances, with a real ≤60 s deadline including the first tx, and the
   full profile for every released hardfork. Capture historical reward/state checks before pruning
   or verify by replay. Pectra needs its own evidence, not Gloas GREEN.

**Status:** same-message MSM and shared-H improved speed but remained RED against their budgets.
Ephemeral sync aggregates achieved component GREEN: four in 2.331 ms, one in 1.563 ms. Whole-network
≤60 s is unproven; the client was unchanged. The next round checks the remaining algorithmic budget,
PTC, and exact reuse of verified BLS inputs, without investigating threads.
