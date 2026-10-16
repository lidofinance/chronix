# Review and verification

Review used `.agents/skills/review-changes/SKILL.md`; fixes were checked in separate regression
runs. This repository started empty, so the review includes untracked source.

| Severity | Location                                  | Trigger and consequence                                                                                                                                                                                       | Fix and independent check                                                                                                                                                                                |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | `clients/controlled_clock.rs:75`          | A zero-duration scheduler retry loops while protocol time is paused, consuming CPU and preventing duty completion.                                                                                            | A controlled zero-duration wait requires the next clock change. Standalone Rust test verifies it stays pending; real paused e2e passes.                                                                  |
| P1       | `src/engine.ts:126`                       | Geth prepares an empty next-slot payload before a transaction arrives; `getPayloadV4` can return it immediately, then automine stops with the same pool candidates. Long pauses also expire speculative jobs. | Suppress future payload preparation, retain fork-choice updates, and await Geth's structured full-payload completion event. Real nonce-gap/concurrent-send e2e passes, including a 13-second real pause. |
| P1       | `src/network.ts:24`, `src/network.ts:342` | Log collection or partial startup can fail before cleanup; a second owner can race the first.                                                                                                                 | Cleanup in failure/finally paths, exact ownership labels, per-stand process lock, reject leftover state. Docker regression protects a foreign volume; lifecycle test rejects a duplicate owner.          |
| P2       | `src/network.ts:303`                      | Docker Desktop has not released a removed VC's published port when its replacement starts. A large skip fails with address already in use.                                                                    | Allocate new ephemeral private ports and update the shared manifest. Public controller endpoint stays stable. Full withdrawal scenario exercises multiple VC replacements.                               |
| P2       | `src/cli.ts:29`                           | Immediate reset can run after containers disappear but before volumes and the controller lock are gone.                                                                                                       | Wait for containers, networks, volumes and lock removal. Real repeated up/down/reset test checks identical genesis and no owned resources.                                                               |
| P2       | `src/automine.ts:38`                      | Disable races an awaited pool read; a new notification can arrive while a drain finishes.                                                                                                                     | Disable awaits the worker and rechecks enablement; generation tracking restarts for unhandled notifications. Two targeted concurrency regressions plus real concurrent sends.                            |
| P2       | `src/time.ts:47`                          | Shutdown during a long advance can otherwise wait for its entire requested duration.                                                                                                                          | Stop at the next bounded phase boundary; targeted unit regression.                                                                                                                                       |
| P2       | `examples/withdrawal.ts:34`               | Equating an EL withdrawal with immediate `withdrawal_done` and a permanently zero balance misclassifies real protocol behavior.                                                                               | Check the actual withdrawal, committee rotation, actual balance and epoch-updated effective balance separately. No client validation rules were changed to satisfy the test.                             |

Remaining boundaries: EngineGate depends on the pinned Geth JSON log event (a bounded timeout fails
closed if it disappears); the topology holds every active validator key in one VC; WebSocket RPC and
long-lived Beacon SSE are not supported by the proxy. Restarting the controller with existing chain
state is not implemented: use `down`/`reset` after an interrupted run. Detailed executed checks and
measurements are in `measurements.md` and `reports/`.

Historical P2 finding: Deno 1.36 could not parse the runtime configuration and lockfile. A
compatibility launcher previously addressed this; it has since been removed. Chronix now requires
Deno 2.9.7 and uses one standard `deno.json` for tasks, dependencies and runtime settings.

## Bake isolation and large jumps

- P2, fixed (`src/verification.ts`, `scripts/test_profile.ts`): the former global fingerprint
  invalidated Pectra when only Gloas build sources changed, and profile verification repeated common
  baker tests. Fingerprints now follow the selected executable suite and shared runtime; compiler
  tests are separate. The unit regression covers isolation in both directions, shared-runtime
  invalidation and archived native inputs. All 19 unit tests and 3 Docker baker tests passed.
- P1, fixed (`clients/gloas_prepare_skip.rs`): the first prepared-state implementation cached
  skipped states without persisting the summaries and HDiff bases needed by import. v2 reproduced a
  BN shutdown at slot 8320 (`MissingHotStateSummary`). The selected v3 implementation uses ordinary
  `store.put_state` for every intermediate state. Two real jumps imported blocks, processed
  transactions and restored finality; all 64 validators remained active and their exported signing
  histories passed. Historical states are pruned normally after finalization.
- P2, fixed (`scripts/patch_gloas.py`): proposer, attester and PTC duty endpoints and withdrawal
  calculation repeated the skipped range from the old head. Controlled mode now reuses compatible
  advanced states for the captured head root. The selected binary measured 9.7/11.9 seconds with the
  ordinary 512-slot first storage-diff layer. The user accepted this result and requested the
  simpler implementation; v4 batching and v5 uniform-balance specialization were reverted. The
  regression budget is now 20 seconds including the following transaction. Full verification of the
  stable tag passed all 8 scenarios; measured jumps including the following transaction were
  10.783/11.616 seconds. The existing Pectra bake separately passed the same two-jump correctness
  checks in 17.594/18.302 seconds. No additional runtime/native changes followed these checks.
