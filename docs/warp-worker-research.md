# Honest warp: local worker and proposal completion

2026-09-30. Research based on pinned sources and saved results; the worker and hooks described below
are not yet implemented. No new Docker runs, builds, or tests were performed for this document. The
target is to complete each of two consecutive 8192-slot jumps, including the first subsequent
transaction, in ≤60 s, with full acceptance from [warp-tdd-acceptance.md](warp-tdd-acceptance.md).

## Candidate selection and constraints

The most compact combination: reduce repeated cryptographic work, run the existing TS
Timeline/Consensus/Automine inside the Docker network, use direct BN→EL Engine transport, and
replace polling with completion notifications. This introduces no new native range executor, skipped
state transitions, relocation of validator keys, or bypassed checks. The one-minute target is **not
proven achievable**. Direct-sync has already reduced the work, but the saved result of 32 slots /
2956.230 ms corresponds to 92.382 ms/slot; another roughly 12.6× improvement is needed.

After crypto is accelerated, transport may become a significant share of runtime. This is a
hypothesis about the combined design, not grounds to repeat a long run without a short numerical
gate.

## Runtime placement without a second time owner

Current locations: `src/controller.ts:9–151`, `src/api.ts:20–77`, `src/time.ts:30–150`,
`src/automine.ts:33–136`, `src/consensus.ts:19–145`, `src/network.ts:154–296,330–385`.

1. Extract the runtime from Controller: Timeline, Automine, status, time commands, Beacon/RPC
   forwarding. Use the same code and a single `Timeline.queue`; the host keeps no shadow Timeline.
2. The worker entrypoint creates the runtime with internal BN/VC/EL addresses. The host Controller
   retains external localhost HTTP, Host/Origin checks, Network lifecycle, shutdown, and host
   resource sampling. `Devnet` already works through `/control`, so the API barely changes.
3. Route external JSON-RPC through the worker as well. After Geth responds, the existing
   `Automine.notify()` runs locally: there is no separate host→worker wakeup whose loss could leave
   a transaction unmined. Preserve raw batch/ID/error/notification semantics; the RPC response must
   not wait for mining.
4. Inject a `skipValidator` callback into Consensus, removing its runtime import of the concrete
   Network. Only this rare lifecycle callback runs on the host. The worker holds the Timeline queue
   until it completes. Honest advance does not access Docker.

Module scope: Controller/runtime, a new worker entrypoint, Network provisioning, Consensus
dependencies, and small CLI/profiling changes. This suggests 5–7 production files, not a promise of
a specific line count. `cli.ts:138` must read authoritative status instead of
`controller.time.timestamp`. `profile.ts:81` currently selects the validator-key path for every
non-EL/BN container; the new worker needs separate handling. Docker stats already find all
containers by label; `/control resources` stays on the host to avoid counting the worker twice.

Create the worker through `Infrastructure.container("worker", ...)` with the exact `io.chronix.id`,
without a Docker socket or a bind mount of the entire `/shared` directory. It needs pinned Linux
Deno, a readonly source bundle, minimal configuration, and a separate internal-command token. The
public port remains localhost-only. The host manifest retains endpoints usable from the host; the
worker gets a separate set of internal URLs. Simply mounting a macOS Deno binary into a Linux
container is not valid.

VC recreation in `network.ts:353` does not preserve `NetworkingConfig`: a stable container name
`chronix-<id>-vc` or an alias set both at initial startup and VC replacement is required. The worker
must not continue accessing the old published host port.

Shutdown: stop admission, stop Timeline/Automine and drain the queue while keeping EngineGate
available, then remove owned containers. A worker crash, lost advance response, or partial lifecycle
callback means fault/reset; automatically retrying advance or recovering solely from equal BN/VC
clocks is unsafe. Equal clocks do not prove completion of the current phase.

## Engine transport: prerequisite for moving Timeline

Currently, `Consensus.move()` synchronously writes `EngineGate.nowMs`, and the gate suppresses
future payload attributes (`src/engine.ts:178–183`). Moving to a worker without changing this
connection would require a host hop on every phase and retain much of the orchestration.

Proposal: a controlled-only future-attribute check before the actual Engine RPC and payload-ID cache
in `beacon_node/execution_layer/src/engines.rs::Engine::notify_forkchoice_updated` (around line 161
in the pinned trees). Compare the timestamp with the controlled protocol clock, not wall time. Both
execution_layer versions already depend on slot_clock. The primary BN endpoint is `http://el:8551`;
`HttpJsonRpc::rpc_request` routes only `engine_getPayloadV*` through the existing host gate. The
gate retains JWT, log-based full-payload readiness, and real deadlines. An empty txpool check does
not replace readiness. This remains a proposal; independent per-profile checks are needed for
pause→tx and future-attribute suppression, including obtaining a new payload ID after a pause.

## Proposal completion: safe anchor and negative experiment

`src/consensus.ts:53` polls head, then agreement; `src/http.ts:31` sleeps 10 ms after the first
miss. A budget of 7.324 ms/slot cannot accommodate a regular miss on every slot. However, this is
not a newly discovered, proven large saving.

**Negative result:**
[ordinary honest-v3](../reports/warp-tdd/native/critical-path-gloas-honest-v3.json): 4410.685 ms/32;
[Engine head experiment](../reports/warp-tdd/native/critical-path-gloas-honest-v3-engine-head.json):
4371.715 ms/32, only −0.88%. Phase 0: 102.402→96.672 ms/slot. Consistency calls: 107→32. The saved
[red log](../reports/warp-tdd/native/engine-head-controller-red.log) explicitly records the order
`bn → vc → engine head → head read → agreement`; the
[green log](../reports/warp-tdd/native/engine-head-green.log) confirms the check of that order. The
previous event was therefore already **before the first head read**. It is incorrect to justify the
new BN hook as eliminating another polling window supposedly left by that experiment. These two runs
cannot separate a small effect from variation in neighboring phases.

The source at `.cache/warp-native/engine-head-experiment.ts:178,224–246` waits for VALID newPayload
and VALID forkchoiceUpdated for the same execution hash. It remains an experiment. A new BN mark has
practical value for direct Engine transport, when the host no longer observes these requests, and
for binding completion precisely to the canonical CL root. Its timing is close to the old Engine
event; on its own, it promises no additional large speedup.

Primary Gloas anchors (`.cache/warp-native/gloas/`):

| Location                                                                       | What has completed / what has not                                                                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beacon_node/beacon_chain/src/payload_envelope_verification/import.rs:229–332` | The envelope passed checks, fork choice was updated, and envelope/columns were written to the DB. Canonical head and EL forkchoice may still lag.  |
| `beacon_node/http_api/src/beacon/execution_payload_envelopes.rs:400–403`       | After full envelope import, `recompute_head_at_current_slot()` is called. Its `()` does not prove successful EL VALID.                             |
| `beacon_node/beacon_chain/src/canonical_head.rs:1034–1084`                     | The full-head snapshot loads the envelope from the store and is committed to the cached head.                                                      |
| `canonical_head.rs:1133–1185,1210,1787–1839`                                   | The HeadV2 event precedes the asynchronous EL update. The `execution_payload` event also means import, not successful canonical FCU.               |
| `beacon_node/beacon_chain/src/beacon_chain.rs:7027–7050`                       | The `PayloadStatus::Valid` branch, then `on_valid_execution_payload(head_hash)`; a suitable controlled completion anchor after this call succeeds. |

Place the minimal hook at the last point, only on successful `fork_choice_update_result`, not simply
before `Ok(())`: upstream also returns `Ok(())` for SYNCING/ACCEPTED and logs some errors.
Additional conditions: current slot matches head slot; canonical root matches FCU `head_block_root`;
the Gloas cached head is `Full`, with its envelope root and execution hash matching the confirmed
root/hash. This excludes an early VALID FCU for an EMPTY head, where the EL confirmed only the
execution parent. Pectra uses the analogous anchor
`.cache/upstream/lighthouse/beacon_node/beacon_chain/src/beacon_chain.rs:6275–6299`, but checks the
payload of the canonical block itself: it has no separate envelope/Full virtual node.

Use a bounded root mark through the existing `controlled::mark_root`; bind the root to the exact
slot. Before obtaining the root, the controller can wait for a separate slot-completion watermark,
then check the root mark from the same snapshot and read head. Prefer writing both parts under one
marks mutex; do not create an unbounded table of all 8192 roots. Wait using the existing native wait
with a real deadline and no polling fallback. After notification, retain one-time real reads of the
CL block / Gloas envelope / EL head and checks of slot, root, hash, timestamp, and execution
optimism. Notification does not replace these. A mismatch after completion must fault, not silently
advance to the next slot.

Do not set a success mark immediately after newPayload VALID, after envelope Imported, in HeadV2,
after HTTP 200, or unconditionally after `recompute_head_at_current_slot()`: none of these points
alone proves the required combination of canonical CL head + imported envelope + EL VALID head. The
FCU hook must also avoid holding additional fork-choice locks across async waits.

## Numerical budget and saved measurements

These are diagnostic quantities, not additive parts of one duration. Nested timers, parallel VC
jobs, Engine RTT, and Geth execution cannot be summed. CPU snapshots were taken sequentially for
EL/BN/VC before and after advance, so they include additional wall time and possible
background/lookahead work. Normalizing by 32 advanced slots does not turn them into an exact
per-slot cost.

Sources:
[metrics-gloas-direct-sync.json](../reports/warp-tdd/native/metrics-gloas-direct-sync.json),
[BN before](../reports/warp-tdd/native/metrics-direct-sync-bn-before.txt),
[BN after](../reports/warp-tdd/native/metrics-direct-sync-bn-after.txt),
[VC before](../reports/warp-tdd/native/metrics-direct-sync-vc-before.txt),
[VC after](../reports/warp-tdd/native/metrics-direct-sync-vc-after.txt).

| Quantity                                    |                                     Saved value | Implication for the remaining budget                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entire advance, 32 slots                    |                     2956.230 ms; 92.382 ms/slot | Target for the entire sequential path: ≤7.324 ms/slot, still minus the first tx.                                                                                                             |
| EL CPU delta                                | **338.356 CPU-ms**, 10.574 CPU-ms/advanced slot | CPU, not RTT. Assuming all work is retained and perfect use of the 2 CPU limit: 5.287 ms/slot, 43.310 s/8192 for the EL alone. Not a physical floor because of the extended snapshot window. |
| BN CPU delta                                |                    2792.122 CPU-ms; 87.254/slot | Even assuming 2 CPU, this would be 43.627 ms/slot; substantial CPU-work reduction is needed, not just transport changes.                                                                     |
| VC CPU delta                                |                    1098.155 CPU-ms; 34.317/slot | Conditionally 17.159 ms/slot at 2 CPU; signing and background work need separate measurement.                                                                                                |
| FCU requests                                |           130 calls / 231.953 ms; 1.784 ms/call | About 4 calls/slot, including preparation. RTT includes EL work and waits; it is not pure network time.                                                                                      |
| getPayload / newPayload                     |                   32 × 1.647 ms / 32 × 3.185 ms | Partly inside production/envelope timers. Direct transport does not remove real execution.                                                                                                   |
| BN production / block processing / envelope |                   7.269 / 7.679 / 3.489 ms/slot | Outer timers with nested crypto/state/EL/queue work; do not add to the rows below.                                                                                                           |
| Production state process / state root       |                           0.996 / 0.599 ms/slot | Observed sequential sections inside production. The remaining kernel after crypto has not yet been measured.                                                                                 |
| Import core / state root                    |                           0.111 / 0.620 ms/slot | A small measured section, not grounds for a major import redesign.                                                                                                                           |
| Block DB write / envelope DB write          |                           0.230 / 0.042 ms/slot | Already included in the outer processing timers; skipping persistence is neither needed nor allowed.                                                                                         |
| CFS throttling                              |                 delta 0 in all three containers | The current result is not explained by CFS throttling. The accelerated combination may change utilization.                                                                                   |

For Geth, the saved
[tail of the large direct-sync run](../reports/warp-tdd/native/direct-sync-long-warp-el-tail.log)
contains 60 messages of each kind at blocks 8262–8321: average `Updated payload` elapsed 0.482 ms,
`Imported new potential chain segment` 1.039 ms, `Chain head was updated` 0.045 ms. This is a
separate window of the large run, not the same 32 slots. In the saved
[short EL log](../reports/warp-tdd/native/metrics-direct-sync-el.log) for blocks 65–96, the
corresponding averages are 0.347 / 0.637 / 0.034 ms (32 messages each; the source was copied from
`.chronix/metrics-24e7dc22/el.log`). These elapsed values are individual internal Geth spans, not
full CPU accounting or a replacement for Engine RTT. The difference between RTT and such a span
cannot be attributed entirely to network delay.

| Early numerical gate | Maximum without reserving time for tx | Practical formula                                               |
| -------------------- | ------------------------------------: | --------------------------------------------------------------- |
| One slot             |                           7.324219 ms | `(60000 - T_first_tx_ms) / 8192`                                |
| 32 slots             |                            234.375 ms | `T_32 × 256 + T_first_tx ≤ 60000 ms`                            |
| 256 slots            |                               1875 ms | `T_256 × 32 + T_first_tx ≤ 60000 ms`                            |
| 8192 slots           |                              60000 ms | Measure full warp + first successful tx, with no deferred work. |

The conditional 5.287 ms EL value from the CPU row would leave only 2.037 ms within the hard slot
budget for the other non-overlapping sections. This is a design warning, not a proven lower bound:
the background share and EL parallelism are unknown. Likewise, one cannot subtract all nested BN
timers from 92 ms and call the remainder removable overhead.

## TDD and the next short probe

Before implementation, define failing checks: a single time owner under concurrent advance/automine;
raw RPC parity; graceful shutdown with a pending queue; worker loss/ambiguous advance without retry;
VC recreation; no access to keys/Docker socket; exact-label cleanup alongside another network.

Separate negative cases for the completion hook: envelope not yet imported; missing columns;
optimistic/SYNCING/ACCEPTED; VALID for the Gloas execution parent on an EMPTY head; invalid payload;
DB/import error; wrong slot/root/hash; canonical root change after the mark; timeout and shutdown.
Only a matching imported canonical head with an actual FCU VALID produces a notification. Oracle
replay and ordinary EL/CL checks remain enabled.

The first probe after authorized implementation is 32 slots, then 256 slots with an epoch transition
and first tx. Do not run 8192 if the table's formula fails. Record monotonic spans in one worker
process for BN/VC advance, head completion, root/head reads, consistency, and all phase waits.
Separately count first-probe misses, polling attempts, and actual sleep time: the previous host
profile_phases wrapper will not automatically measure relocated Consensus.

BN timings correlated by slot/root/hash are needed: production/signature checks/state
transition/hashing/import/FCU; Geth build/import/head elapsed; actual CPU snapshot boundaries for
each container. Run sequential A/B transport and crypto variants with the same bake/input and no
competing devnet load. Save per-slot distributions and epoch spikes. Do not sum overlapping spans or
async signing-time totals; reconstruct the actual dependency chain.

Not yet measured: Docker-local HTTP RTT; the remaining crypto kernel and subgroup costs; background
EL/BN/VC CPU share; pure scheduler wait time; phase-0 polling misses after crypto; cost of new
boundary checks; long-run memory/disk/history growth. All required economics, full duty coverage,
finality, signing history, failure safety, and post-warp operations must then be checked
independently for each released bake. A short speed gate does not replace them.
