# Honest warp: actual status

**Subsequent decision:** retain `direct-sync` and two explicit modes on one bake. Fast mode permits
ordinary skipped-slot penalties; honest mode preserves the full flow and permits runtimes of
minutes. Optimization research was stopped, and new cryptographic prototypes were not integrated.
[Current contract and verification](warp-modes.md). The history below preserves the former honest
≤60 s target; it was not met and is no longer a current requirement for the slow mode.

2026-09-30. Work started at the user's request with minimal changes. **The release is not ready:**
penalties caused by automatic skip were eliminated over the small ranges tested, but the full
[acceptance matrix](warp-tdd-acceptance.md) has not been completed. The user's current target was
**8192 slots including the first subsequent tx in no more than one minute**, with narrow, safe
client changes. 25 s remains the desired speed. The previous statement that the user had permitted
minutes was an assistant interpretation error and was withdrawn. The consolidated
[log of all experiments](warp-experiments.md) separates results from hypotheses.

A separate research cycle preserved RED/GREEN evidence and exact cryptographic probe sources.
Same-message MSM and shared-H remained RED against component budgets. Ephemeral sync aggregates
reached mean ≤3 ms: four aggregates **2.331 ms**, one full aggregate **1.563 ms**, after executed
baselines of **26.020/27.816 ms**. This is **standalone component GREEN**, not a new client build or
full-warp acceptance. [Data and limitations](../reports/warp-tdd/group-sync/README.md).

The first runtime change in `src/time.ts`: `advanceTime` and `advanceTo` use the existing sequential
phase executor; the automatic skip branch was removed. Explicit `skipSlots` still models downtime.
Subsequent native changes and their separate evidence are described below; previous immutable
manifests are preserved.

## Reproducible checks

Run sequentially from the repository root through `deno`; select the profile explicitly:

```sh
CHRONIX_PROFILE=pectra CHRONIX_BAKE=panda deno task e2e:warp-economics
CHRONIX_PROFILE=gloas CHRONIX_BAKE=panda deno task e2e:warp-economics
CHRONIX_PROFILE=pectra CHRONIX_BAKE=panda deno task e2e:warp
CHRONIX_PROFILE=gloas CHRONIX_BAKE=panda deno task e2e:warp
```

Existing images with `clockEnvPrefix: PANDA` were tested:

- Pectra `panda`: `96b5d5a260d902e7a6abacbd745c89072a7f17407ac3d526d8240fd32dd884da`.
- Gloas `panda`: `8716953f4b576b861c7fef5d0487a0b9e5a5d122615dbc0e5210e82bdc2907cf`.

They were restored from archives with image-ID verification, without rebuilding. The old Pectra
`default` was not used: the current controller rejected its missing namespace. This is an
old-artifact compatibility error, not the economics regression's RED.

Original scenario: 64 keys, 128 full-participation warmup slots, then two 96-slot warps through
`advanceTime` and `advanceTo`. Checks cover block count, previous-epoch participation, inactivity
scores, actual reward deltas for closed epochs, and finalized EL/CL at return.

| Check                                    | Pectra                                                          | Gloas             |
| ---------------------------------------- | --------------------------------------------------------------- | ----------------- |
| RED before the runtime fix               | 1 block instead of 96, zero flags, penalties, lagging finality  | Same              |
| GREEN after the runtime fix              | 96 blocks, flags 7, zero penalties/inactivity, current finality | Same              |
| Two 96-slot calls, excluding the next tx | 32.607 / 32.396 s                                               | 31.386 / 32.498 s |

Full original evidence: [RED](../reports/warp-tdd/red/) and [GREEN](../reports/warp-tdd/green/). The
large-range unit test also first failed on the skip call, then passed without changing the
requirements. Logs are saved alongside them. The original scenario did not yet check sync/PTC or
subsequent deployment; its results do not fully satisfy W03/W04/W07.

The scenario was extended to check every sync aggregate, Gloas PTC for the previous payload, absence
of slashing, and deployment in the first subsequent slot. It is included independently in each
profile's tests. In the first extended Gloas run, the new deploy fixture exhausted 100000 gas; that
was not a successful run. The limit was aligned with the existing profile-specific deploy fixture
(12M Gloas / 2M Pectra).

Separate reruns of the extended scenario **passed on both profiles**:

| Profile / run ID                      | Warp duration, two calls | First subsequent deploy | Result                                         |
| ------------------------------------- | ------------------------ | ----------------------- | ---------------------------------------------- |
| Pectra / `honest-warp-duties-pectra`  | 32.048 / 32.991 s        | 0.470 / 0.321 s         | 192 blocks checked, penalties 0, full sync     |
| Gloas / `honest-warp-duties-gloas-v2` | 31.386 / 31.985 s        | 0.347 / 0.326 s         | 192 blocks checked, penalties 0, full sync/PTC |

Reports: [Pectra](../reports/profiles/pectra/panda/warp-economics.json),
[Gloas](../reports/profiles/gloas/panda/warp-economics.json). `check` and `test` passed: 29 passed,
12 integration/Docker tests ignored in the unit run. Both real economics scenarios above ran through
separate commands.

## Speed limit

[Separate Gloas measurement](../reports/warp-tdd/critical-path-gloas.json): 32 real slots after 64
warmup slots took 11.158 s. ARM64, VM resources, and other containers are recorded in the report; no
other Chronix tests or builds ran concurrently. The measurement includes observer overhead. The
reproducer is saved in [profile_phases.ts](../reports/warp-tdd/profile_phases.ts):
`CHRONIX_PROFILE=gloas CHRONIX_BAKE=panda deno run -A reports/warp-tdd/profile_phases.ts`.

Average phase durations: proposal/EL agreement 68.99 ms; attestation/sync 240.18 ms; aggregates
23.21 ms; PTC/state advance 6.15 ms; forkchoice 10.10 ms. Nested `mark`, `clock`, and `consistency`
measurements overlap the phases and must not be added to them. These figures do not separate
cryptography, scheduling, and polling, and do not prove a physical limit.

At this historical stage, the budget was 25 s for 8192 slots including the next tx. At that time,
`e2e:warp` bounded the call itself with a real 25 s deadline, saved a failed report, and stopped its
owned test network at the next barrier. This kept a budget violation from becoming an hours-long
test.

Both bounded `e2e:warp` runs were executed and **failed the budget**:

| Profile / run ID                     | Call duration before deadline | Slots advanced out of 8192 |
| ------------------------------------ | ----------------------------- | -------------------------- |
| Pectra / `honest-warp-budget-pectra` | 25.003 s                      | 78 (128 → 206)             |
| Gloas / `honest-warp-budget-gloas`   | 25.002 s                      | 74 (128 → 202)             |

Failed reports: [Pectra](../reports/profiles/pectra/panda/warp.json),
[Gloas](../reports/profiles/gloas/panda/warp.json). The first subsequent deploy was not attempted in
these incomplete ranges. After the checks finished, `docker ps -a --filter label=io.panda.id`
returned an empty list. This is performance RED before the next change, not full-range verification
or a successful warp result.

## Native acceleration: separately verified steps

The shared helper `bakes/shared/native/verified_signature.rs` reuses only successful verification of
identical BLS inputs: signing root, public key, and signature. Every first check runs through `blst`
with subgroup verification; invalid results are not cached. The cache is bounded to 512 entries.
Membership, slot, duplicate-message, and state-transition checks remain standard. Both profiles
include one helper through their patches; it is enabled only with the controlled clock.

Four native tests check repeated verification, key/root/domain/signature changes, eviction, and
concurrent access. Behavioral RED and GREEN were obtained:
[RED](../reports/warp-tdd/native/verified-signature-red.log),
[GREEN](../reports/warp-tdd/native/verified-signature-green.log).

Gloas `honest-v1`, key `107173a2e0d4ed86e80ca9ecfb5bc49a0be49d839eccadb9b1780e1d741b2ce6`, was built
from pinned sources with native tests. The new
[phase measurement](../reports/warp-tdd/native/critical-path-gloas-honest-v1.json): 32 full slots in
5.749 s instead of 11.158 s; attestation/sync phase 58.83 ms instead of 240.18 ms. This compares two
observations on the same machine, not p95 or a successful 8192-slot warp.

The [economics run](../reports/profiles/gloas/honest-v1/warp-economics.json) `honest-v1-economics`
passed: two 96-slot warps in 15.771 / 16.074 s, subsequent deployments in 0.190 / 0.172 s. Checks
covered full sync/PTC, zero attestation penalties/inactivity, unslashed status, actual finalized
checkpoints, and finalized EL/CL agreement. This run does not satisfy the full matrix.

The next candidate added native completion wait to the shared clock. It waits for all exact marks
under one mutex/condition variable, does not advance protocol time, and is bounded by a real
deadline. Old bakes use polling; new ones declare `clockWait` in the manifest. The native test first
rejected the previous immediate response, then passed checks for late/already-ready marks, a missing
mark, real timeout, stale slot, and invalid input. Evidence:
[RED](../reports/warp-tdd/native/clock-wait-native-red.log),
[GREEN](../reports/warp-tdd/native/clock-wait-native-green.log). Separate controller tests also
passed RED/GREEN and ensure an error does not become a polling fallback.

Gloas `honest-v2`, key `e96551cd82f66abd24df0eaec60d623121434053f6e59765b34b740d289e9fd9`, was built
with these barriers.
[Phase measurement](../reports/warp-tdd/native/critical-path-gloas-honest-v2.json): 32 slots in
4.917 s. The [economics run](../reports/profiles/gloas/honest-v2/warp-economics.json) passed: 96
slots in 14.143 / 13.598 s; next deploy in 0.153 / 0.146 s. The same full sync/PTC, penalty,
slashing, and finalized EL/CL checks passed. The
[large range](../reports/profiles/gloas/honest-v2/warp.json) remains RED: 177 of 8192 slots (128
→ 305) in 25.003 s; the next tx was not attempted.

The next candidate performs one randomized BLS batch check of sync messages before ordinary
per-message verification. Only a fully successful check populates the same bounded cache of exact
inputs. It uses upstream Lighthouse's model of nonzero random 64-bit coefficients; swapping two
signers while preserving the aggregate signature is rejected. Batch cryptographic verification does
not replace message-structure or membership checks.
[RED](../reports/warp-tdd/native/batch-verification-red.log) and
[GREEN](../reports/warp-tdd/native/batch-verification-green.log) were obtained; all 8 tests also
passed separately in the real pinned `bls` crate, including the `SignatureSet` adapter:
[log](../reports/warp-tdd/native/batch-gloas-green.log).

Gloas `honest-v3`, key `002369e1c669a61a5460c29617d307b40d7d6f1cf482fa7d8928ad11501ee08c`, was built
from pinned sources. The
[economics scenario](../reports/profiles/gloas/honest-v3/warp-economics.json) `honest-v3-economics`
passed: two 96-slot warps in 13.921 / 11.678 s, subsequent deployments in 0.143 / 0.111 s. Full
sync/PTC, zero attestation penalties/inactivity, unslashed status, and finalized EL/CL were checked
over this range. The large range and full profile for v3 are not yet verified; the Pectra native
candidate has not yet been built. A short scenario's success does not guarantee full participation
over an arbitrary range: a risk of no elected sync aggregator was found, described in the
[follow-up research](warp-honest-fast-forward-research.md#reassessment-after-measurements).

During the build, runtime/EL images were found to have been removed by an external process. The
baker now restores the exact runtime ID immediately before packaging and recognizes `errorDetail` in
an HTTP-success Docker stream. The unit regression first failed on false success, then passed.
`test:baker` ran four real Docker checks for recovery, immutable tags, and ownership; all passed.
Shared `check` and 34 unit tests passed; 12 Docker/e2e targets were ignored in the unit run.

## Gloas honest-v3 diagnostics

After stopping competing devnet tasks, a separate measurement ran: 64 warmup slots, then 32 slots in
**3.857 s**. Settings were unchanged: 64 validators, an ARM64 Docker VM with 6 CPU, and a 2 CPU
limit for each EL/BN/VC. Standard Prometheus metrics were enabled; public metrics ports were bound
to localhost. Original [Docker counters](../reports/warp-tdd/native/metrics-gloas-honest-v3.json),
[BN before](../reports/warp-tdd/native/metrics-bn-before.txt) /
[after](../reports/warp-tdd/native/metrics-bn-after.txt),
[VC before](../reports/warp-tdd/native/metrics-vc-before.txt) /
[after](../reports/warp-tdd/native/metrics-vc-after.txt) are saved. The test network was stopped and
removed by its own disposer.

| Measurement                                                            | Counter delta                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| EL / BN / VC CPU                                                       | 0.312 / 2.979 / 4.393 CPU-seconds                 |
| CPU throttling                                                         | 0 for all three containers                        |
| VC local-keystore signing jobs                                         | 11,615                                            |
| Of which sync selection proofs / contribution wrappers / sync messages | 8192 / 991 / 2048                                 |
| BN block production                                                    | 204.167 ms / 32 calls, about 6.38 ms per block    |
| BN envelope processing                                                 | 129.806 ms / 32 calls, about 4.06 ms per envelope |
| VC block signing, including slashing protection                        | 112.673 ms / 32 calls                             |

Snapshots are taken sequentially before/after the command, so CPU intervals exceed its elapsed time.
Signing jobs include advance preparation of sync proofs for 64 slots; about 363 jobs per advanced
slot in this window is not a fixed protocol-slot cost. The 56.531 s signing-latency sum includes
overlapping queue waits: it is neither CPU time nor sequential delay. The measurement rules out CFS
throttling in this window, but not internal worker-pool limits. Direct contribution delivery could
potentially remove 9183 selection/wrapper jobs (79.1%); at that stage, the time saving had not yet
been measured. The subsequent direct-sync measurement is below. Individual sync signatures remain.

A
[separate Geth payload-wait measurement](../reports/warp-tdd/native/critical-path-gloas-honest-v3-payload-wait.json)
gave only 0.705 ms total over 32 slots, 0.022 ms per call. This is not payload build/execution time;
waiting for an already-ready result does not explain the warp delay.

An experiment with an additional Engine head notification gave 4.372 s versus the previous 4.411 s
for 32 slots. It was excluded from implementation: one close measurement does not justify additional
synchronization. The report and `engine-head*` logs are preserved as historical evidence, and
`unit-engine-head.log` applies to the excluded experiment, not the current tree. The next step is
TDD for a full sync aggregate and ordinary/group signer comparison; a new range executor has not
been selected as the first step.

After removing the experiment and recording the research, current `check` and `test` were repeated
successfully: 34 passed, 0 failed, 12 opt-in ignored. Logs:
[check](../reports/warp-tdd/native/check-current.log),
[unit](../reports/warp-tdd/native/unit-current.log). This checks the current tree; new theoretical
sync/PTC scenarios are not yet implemented or executed.

## Direct delivery of sync votes

A narrow step was implemented: `directSync`, delivering already verified individual sync votes to
the regular operation pool without aggregator selection. Behavioral
[native RED](../reports/warp-tdd/native/direct-sync-red.log) confirmed that the naive pool contains
all 512 positions, but the block pool is empty without gossip wrappers. After the minimal fix, the
same [test passed](../reports/warp-tdd/native/direct-sync-green.log), including ordinary mode and
real BLS verification by `process_sync_aggregate`. Two compilation errors in the new test fixture
are saved separately in `direct-sync-fixture-build*.log` and do not count as behavioral RED.

The controller barrier also passed RED/GREEN: BN votes for the exact root are required, and a head
change after execution verification causes an error. Evidence:
`direct-sync-controller-{red,green}.log` and `direct-sync-head-change-{red,green}.log`. Gloas
`direct-sync` was built with key `e41c863be72847fb1bec8e0b455e23f243cb27d8e73d3ce90ea8f5be6e78c0c8`;
the full profile later failed and was stopped, as described below. There is no secret-key summation
or new range executor.

[Real Gloas economics](../reports/profiles/gloas/direct-sync/warp-economics.json) passed: 96 slots
through `advanceTime` / `advanceTo` in **8.292 / 9.033 s**, subsequent deploys in **0.109 / 0.099
s**. All 512 sync positions, PTC, participation, absence of penalties, and finality were checked.
Removing a sync key that was not the next proposer stopped warp in 30.082 s before the next block;
repeating the command requires reset, and the head does not move.

[Comparable short measurement](../reports/warp-tdd/native/metrics-gloas-direct-sync.json): 32 slots
in **2.956 s** versus 3.857 s for honest-v3 (one pair, not p95). VC CPU: 1.098 versus 4.393
CPU-seconds; signing jobs: 2432 versus 11615. Both retained 2048 individual sync signatures. The new
build has no sync selection proofs or contribution wrappers. Resource settings were unchanged, and
measurements ran sequentially. The long range later took minutes; the result is below.

[Independent CL replay](../reports/warp-tdd/native/direct-sync-replay.json) on unchanged pinned
upstream Gloas passed 64 consecutive blocks (129–192) and envelopes: ordinary BLS verification,
every transition root, and exact byte-for-byte final SSZ equality. This separate verification took
4.390 s. The [verifier source](../reports/warp-tdd/native/upstream-replay.rs) is saved. Replacing
the first block or envelope signature with a neighboring object's signature produced
`BulkSignatureVerificationFailed` and `BadSignature`, respectively; logs are alongside the report.
This is not independent EVM re-execution or the full 8192-slot range.

## Open criteria

Comparison with a separate slow producer, independent EL replay, a changing registry and queues
through large honest warp, and a full fault-injection suite are still unverified. Earlier
deposit/exit/consolidation scenarios use explicit skip and do not satisfy these criteria. The new
artifact's full `test:profile` was unsuccessful and stopped. Pectra direct-sync has not been built.
The new ≤60 s target was not met; the full W01–W22 matrix remains incomplete.

## Stopped large direct-sync run

[Saved log](../reports/warp-tdd/native/direct-sync-profile-interrupted.log) and
[separate termination record](../reports/warp-tdd/native/direct-sync-profile-interrupted.json):
baseline/lifecycle/e2e passed. The first large test took **12 minutes 40 seconds** and failed while
fetching rewards for epoch 4: historical state at slot 191 was no longer available through the API.
The first range, 128→8320, and the next tx at block 8321 are visible in the
[EL log](../reports/warp-tdd/native/direct-sync-long-warp-el-tail.log). The second range did not
run. The 12:40 includes startup, warmup, and checks; exact `advanceMs` was not saved before the
error. This is neither a successful large warp nor proof of no penalties over the full range.

The next economics scenario failed because the Geth image was missing; why it disappeared in this
particular run is unknown. Protocol started, then the user stopped the work because the speed was
unacceptable. Its containers were removed strictly by ID; the child process exited.
`verification.json` remained `passed:false,status:running` because of SIGINT: this is an incomplete,
unsuccessful verification, not an ongoing task. Generated verification was not manually rewritten.

At this point, `warp.ts` still contained the incorrectly introduced 30-minute watchdog and an
informational 25 s threshold. Before the next execution, it needed replacement with an agreed real
≤60 s limit including the first tx. In the research cycle after the stop, tests and clients were
neither changed nor run. Historical rewards must be recorded at epoch boundaries or checked through
independent replay before pruning; removing this check to obtain green is prohibited.
