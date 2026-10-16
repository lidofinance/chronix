# Two warp modes

Step-by-step developer guide: [How protocol time and warp work](warp-algorithm.md). The sections
below cover mode selection, measurements, and the limits of verification.

User decision on 2026-09-30: stop optimizing and retain the simple, verified `direct-sync` path.
Previous research and all measurements are preserved in the [experiment log](warp-experiments.md).
The group signer, MSM, and shared-H are not included in the client.

```ts
await net.advanceTime(8192 * 12); // honest by default
await net.advanceTime(8192 * 12, { mode: "honest" });
await net.advanceTime(8192 * 12, { mode: "fast" });
await net.advanceTo(targetDate, { mode: "fast" });
```

|           | Honest                                               | Fast                                                               |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| History   | All intermediate blocks and duties                   | A skipped range and a real destination block                       |
| Economics | Normal participation; no artificial missed duties    | Real inactivity penalties and lost rewards                         |
| Finality  | Advances throughout the range                        | May fall behind; recovers in subsequent honest slots               |
| Slashing  | Prohibited                                           | Prohibited; the protection database survives VC restarts           |
| Speed     | Gloas about 13 minutes for 8192, historical estimate | Seconds; regression gate of 25 s including the first subsequent tx |

The mode is selected per call. Small fast advances of up to 32 slots use the regular path. A large
fast advance completes current duties, stops the VC, has the BN perform real empty-slot transitions,
restarts the VC with the same keys/slashing DB, and then produces a block at the target slot. The
exact target time, including mid-slot times, is preserved. `advanceSlots`, `advanceEpochs`,
`stepSlot`, and automine always execute duties; `skipSlots` remains an explicit idle period without
producing a destination block.

One queue serializes both modes. An error after partial progress blocks further time changes until
reset. An invalid mode is rejected before advancing.

## Retained client

Gloas `direct-sync`, key `e41c863be72847fb1bec8e0b455e23f243cb27d8e73d3ce90ea8f5be6e78c0c8`, CL
image `sha256:6964cab3bb40072d63e87cf08fa9b6e992195aeeeff9271f970bd931d14bfe08`. All eight native
files matched the sources of this immutable bake:
[hash verification](../reports/warp-modes/baseline.json). The new mode selection is implemented only
in TypeScript; EL/CL clients were neither rewritten nor rebuilt. Both modes use the same bake.

Pectra is checked independently on the previously built `panda`, key `96b5d5a…`. This is the
existing client with regular individual duties; no new Pectra direct-sync bake was built. Its speed
cannot be inferred from Gloas.

## Checks

- Behavioral RED before implementation: fast still executed all slots, and unknown modes were not
  rejected; followed by time/API GREEN. Checks covered the exact date, partial slots, small fast
  advances up to 32 slots, a mixed queue, preservation of the honest default, and failure after a
  partial skip.
- Profile routing RED→GREEN: both profiles separately include `warp-fast`, `warp`, and
  `warp-economics`.
- Pruning RED→GREEN: rewards are read as epochs close during advancement; they are no longer first
  requested after the entire long range. This fixes the test observer. Missing evidence remains an
  error and is not treated as proof of no penalties.
- Full unit suite: 42 passed, 0 failed, 13 opt-in ignored. The localhost API was checked separately;
  the initial sandbox bind error is not a behavioral RED.

| Real scenario                                                                               | Artifact            | Result                                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| Fast: two ×8192, first tx, resumed finality, and signing history                            | Gloas `direct-sync` | PASS, 8.286 / 8.633 s including tx; all 64 unslashed                                   |
| Fast: two ×8192, first tx, resumed finality, and signing history                            | Pectra `panda`      | PASS, 15.181 / 15.510 s including tx; all 64 unslashed                                 |
| Honest: two ×96, live rewards, all sync bits, signing history, and tx                       | Gloas `direct-sync` | PASS, 8.592 / 8.662 s including tx                                                     |
| Honest economics: two ×96, participation/rewards, sync/PTC, deploy, and missing-key failure | Gloas `direct-sync` | PASS; advance 8.526 / 8.490 s, deploy 0.106 / 0.100 s; missing-key failure in 30.078 s |
| Honest economics: two ×96, participation/rewards, sync, and deploy                          | Pectra `panda`      | PASS; advance 32.223 / 32.039 s, deploy 0.371 / 0.466 s                                |
| Two full honest ×8192                                                                       | Gloas/Pectra        | Not run in this change; no full PASS                                                   |

Raw commands, RED/GREEN evidence, and logs: [reports/warp-modes](../reports/warp-modes/). These are
targeted checks, not a new successful `test:profile` or a manual change to `verification.json`. The
old long Gloas run failed on historical rewards after 12m40s; the exact duration of the advance
itself was not saved then. The estimate of about 13 minutes is supported by an earlier short
measurement, but is not a new complete successful benchmark.

```sh
CHRONIX_PROFILE=gloas CHRONIX_BAKE=direct-sync deno task e2e:warp-fast
CHRONIX_PROFILE=pectra CHRONIX_BAKE=panda deno task e2e:warp-fast
CHRONIX_PROFILE=gloas CHRONIX_BAKE=direct-sync deno task e2e:warp-economics
# Two honest ranges of 1000 slots with all duties checked.
CHRONIX_PROFILE=gloas CHRONIX_BAKE=direct-sync deno task e2e:warp
```

At the user's request on 2026-10-01, the standard honest scenario was shortened to two ranges of
1000 slots. Checks for every block, economics, signing history, finality, and the first tx are
preserved. This suite no longer verifies a full honest traversal of 8192 slots; fast still checks
two ranges of 8192.

Fast has a 25 s deadline for a jump including the first tx. Honest retains a per-sample watchdog: 20
minutes for Gloas and 55 minutes for Pectra. This bounds hangs; it does not promise that speed. The
full matrix of deposit, activation, exit, consolidation, queues, and injected failures through
honest warp is still incomplete; see the [criteria](warp-tdd-acceptance.md). Neither fast speed nor
`slashed == false` replaces it.
