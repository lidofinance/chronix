# Measurements and validation

Recorded on 2026-09-29. The initial measurements below describe the original Pectra implementation;
current bake validation is recorded separately below and in `reports/profiles/`. All results are
actual executions; raw JSON is tracked in [reports](../reports). macOS arm64 host, native Linux
arm64 containers, Docker Desktop 4.59.1 / Engine 29.2.0, VM with 6 CPUs and 8,322,592,768 bytes RAM.
There were 3 unrelated running containers during measurement. No other zap-net tests ran
concurrently with `deno task measure` or the baseline.

The numbers below retain the 2026-09-29 measurements. Profile JSON reports are replaced by each
verification run; the 2026-09-30 directory migration and its new run IDs/results are recorded in
[bake layout verification](bake-layout-verification.md). Every measurement on this page used Geth as
the EL. This page has no measurements of Reth, the default EL; current verification reports are per
EL under `reports/profiles/<hardfork>/<tag>/<el>/`.

## Stabilized Gloas bake

`gloas/stable` reuses the exact v3 artifact
`8b1fa94aaf9f1719d3c61793bd960344531335270ab88b82c908ca2184b094f9`. The current patch and all native
source hashes match its manifest. Later batch-write and uniform-balance experiments were reverted;
further optimization is stopped at the user's request. Intermediate states use ordinary
`store.put_state`, with the standard `9,13,16,18,21` storage hierarchy.

`deno task test:profile gloas --bake stable` passed **8/8 scenarios** in 553.4 seconds. This
includes ordinary-client baseline, lifecycle, time/automine/indexer, large jumps,
deposit/activation/ consolidation, voluntary exit/full withdrawal, 20 dependent deployments, and
Gloas envelopes/PTC. The [verification report](../reports/profiles/gloas/stable/verification.json)
binds the immutable bake, suite fingerprint and all eight reports to one run. `deno task bakes`
reports `verified: true`.

| Large jump (64 validators) | `advanceTime` / `advanceTo` return | Including next successful transaction |
| -------------------------- | ---------------------------------- | ------------------------------------- |
| First 8192 slots           | 10.277 s                           | 10.783 s                              |
| Second 8192 slots          | 11.093 s                           | 11.616 s                              |

Each jump advances 98,304 protocol seconds (27 h 18 min 24 s). The
[warp report](../reports/profiles/gloas/stable/warp.json) records real destination blocks, matching
EL/CL execution and restored finality at epochs 260 and 518. All 64 validators remained active and
unslashed, resumed attesting, and passed checks for double proposals, double votes and surround
votes across exported signing histories. Inactivity penalties remain real: absence of slashing does
not imply unchanged balances. The 20-second regression budget includes the next transaction;
subsequent production of real votes to restore finality is checked separately. These are measured
8192-slot cases, not a constant-time promise for arbitrary ranges or validator counts.

The [deploy report](../reports/profiles/gloas/stable/deploy.json) records 10 raw RPC deployments in
4.392 seconds and 10 through ethers in 3.884 seconds, without manual time advancement or sleeps
between deployments. Receipt latency: median 353 ms, p95 627 ms, maximum 1,198 ms. Every deployment
used the next block and checked runtime code, constructor state and protocol timestamp.

No client build or other zap-net test ran concurrently. Docker had 6 CPUs, 8,322,592,768 bytes RAM,
a 2-CPU BN limit and two unrelated running containers. Format/lint/types and all **19 unit tests**
passed; **3 Docker baker tests** passed separately. The native v3 build passed its clock test and
two differential selection tests.

The shared controller was separately checked with the existing `pectra/default` binary:
`ZAP_PROFILE=pectra ZAP_BAKE=default deno task e2e:warp` passed in 146.6 seconds. Its two 8192-slot
jumps including the following transaction took **17.594 / 18.302 seconds**. All 64 validators
remained active/unslashed and resumed signing; both finality recoveries and signing-history checks
passed. See the [Pectra warp report](../reports/profiles/pectra/default/warp.json). Pectra was not
rebuilt and its full suite was not rerun; its historical verification fingerprint remains stale.

## Initial Pectra startup and throughput

| Measurement                                                     | Observed result                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| Controlled, fresh empty EL/CL databases and regenerated genesis | 10.771 s to readiness; 11.258 s to first verified block      |
| Controlled, repeated fresh-state startup with cached images     | 10.419 s to readiness; 10.920 s to first block               |
| Ordinary Lighthouse baseline, fresh state                       | 13.391 s to readiness; 41.814 s to first block               |
| Controlled 128-slot advancement, run 1                          | 44.814 s; 2.856 slots/s; 34.28 protocol seconds/real second  |
| Controlled 128-slot advancement, run 2                          | 44.599 s; 2.870 slots/s                                      |
| Ordinary empty-block production                                 | One slot per 12 real seconds; observed non-optimistic slot 3 |
| Initial native Lighthouse release build                         | 1,345.476 s (22 min 25 s), excluding builder-image download  |
| Rebuild after clock corrections                                 | 662.126 s (11 min 2 s)                                       |

Commands: `deno task measure`, `deno task baseline`, `deno task build:clients`. Both controlled runs
recreate genesis, keys and empty databases; images, OS caches and build artifacts are already
cached. The second run uses the same Deno measurement process. **A fully uncached end-to-end run,
including all image downloads, has not been measured.** These fresh-database numbers must not be
reported as a cold image-cache startup. Initial individual pulls observed earlier: Geth 4.16 s,
official Lighthouse 5.37 s. They cannot be added into a reliable full cold-start number.

The baseline deliberately chooses genesis 30 seconds ahead of wall time, which is included in its
first-block measurement. Controlled time starts in 2033 and needs no real genesis wait. Throughput
measures proposals, votes, aggregates, verified EL payloads and phase barriers, with empty user tx
pools; it is not transaction throughput. No protocol slot length was shortened.

## Per-component resources

Memory / CPU, first controlled run versus ordinary wall-clock baseline. CPU 100% means one logical
CPU. Docker memory subtracts inactive file cache; Deno uses process RSS. Raw/cache memory and limits
are retained in JSON. These are window samples, not peak-memory measurements.

| Component       | Ordinary baseline  | Controlled pause  | Controlled advancement |
| --------------- | ------------------ | ----------------- | ---------------------- |
| Geth            | 59.4 MiB / 0.46%   | 101.1 MiB / 0.32% | 108.0 MiB / 2.54%      |
| Lighthouse BN   | 249.8 MiB / 4.16%  | 270.0 MiB / 0.62% | 297.4 MiB / 103.90%    |
| Lighthouse VC   | 116.3 MiB / 14.36% | 118.9 MiB / 0.16% | 122.1 MiB / 42.89%     |
| Deno controller | —                  | 55.0 MiB / 1.78%  | 65.6 MiB / 7.28%       |

Sample intervals: baseline 26.070 s spanning ordinary slots; controlled pause 7.044 s after 32
slots; load 6.013 s during the first part of a 128-slot advance. The second run is in
`reports/controlled.json`: measurements vary with GC, database work and other host workloads. The
baseline script is not a resident controller, so no comparable Deno baseline value is claimed.

Geth cache is 64 MiB; peer discovery/peering are disabled for this local topology. Each client has a
2-CPU maximum. Memory reservations are EL/VC 128 MiB, BN 512 MiB; there is no hard per-container
memory cap. The reported memory limit is the Docker VM limit. No comparative cache-size/CPU-limit
sweep was done, so these measurements do not prove the chosen values optimal.

After 160 produced slots, allocated persistent data: EL 35.63 MiB, BN 16.56 MiB, validator
keys/slashing database 1.72 MiB (`du -sk` inside the clients). Image layers, build volumes,
`.cache`, `.zap` metadata/logs and the Docker VM disk are additional costs; these figures are not
total host disk consumption. The native controlled runtime image is 218,443,288 bytes.

## Executed checks

| Command / scenario                           | Result                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deno task check`                            | Format, lint, TypeScript checks including examples passed                                                                                                                                                          |
| `deno task test`                             | 9 unit regressions passed; 1 Docker and 4 real e2e tests skipped by default                                                                                                                                        |
| `ZAP_DOCKER_TEST=1 ZAP_E2E=1 deno task test` | 14 passed, 0 failed in 6 min 10 s; includes failed-start rollback, ownership protection and all four real e2e scenarios sequentially                                                                               |
| `deno task smoke:docker`                     | Passed socket, network, volume, container, logs, exec, events, stop/remove/repeated cleanup; 1.469 s with cached Alpine                                                                                            |
| `deno task test:clock`                       | Native Rust clock regression passed: real pause, monotonic advance, backwards rejection, no zero-duration spin                                                                                                     |
| `deno task e2e`                              | Passed in 74.331 s: forward duration/date, timestamp beyond host time, 13-second real pause, EVM TIMESTAMP, batch/errors/notifications, low fee, nonce gap, concurrent sends, actual finality and external indexer |
| `deno task e2e:withdrawal`                   | Passed in 99.878 s: signed exit, EL withdrawal, committee rotation, zero actual balance and withdrawal_done                                                                                                        |
| `deno task e2e:protocol`                     | Passed in 171.993 s: 32 ETH deposit, imported key activated at epoch 11, 0x02 credential switch and actual consolidation                                                                                           |
| `deno task e2e:deploy`                       | Passed: 20 dependent deployments through raw RPC and ethers.ContractFactory, one transaction per consecutive block, no manual time advancement                                                                     |
| `deno task test:lifecycle`                   | Passed in 27.502 s: repeated up/down, reset with identical EL genesis, duplicate-owner rejection, no leftover stand resources                                                                                      |
| Five repository skills                       | All pass skill-creator validation; each was applied during implementation                                                                                                                                          |

Finality was checked by equality of the Beacon finalized block's execution hash and Geth's
`finalized` hash, not by slot count. The withdrawal fixture reached slot 24576 (294,912 protocol
seconds), using **explicit skipped slots** for long waits and retaining real inactivity penalties.
Its first large payout was 31.711599587 ETH; final validator balance is zero. It did not fabricate
votes/finality during skipped periods. That original implementation processed all intervening slots
in `advanceTime`/`advanceTo`. The September 29 implementation then skipped intermediate slots for
large jumps. The September 30 TDD change restores continuous duties; its performance and acceptance
gaps are recorded in [warp-tdd-results.md](warp-tdd-results.md). Historical skip timings do not
describe this new path.

Consolidation is explicitly tested with `churnLimitQuotient: 4`: the default mainnet quotient 65536
leaves no consolidation capacity at 64 validators. The default exit/withdrawal test keeps 65536 and
standard 256-epoch delays. EL genesis repeatability and independently regenerated CL genesis SSZ
hashes are recorded in `reports/lifecycle.json` and `reports/provenance.json`.

## Sequential contract deployment

`deno task e2e:deploy` passed both within the full suite and in a separate repeat after correcting
the even-sample median calculation. The repeat's raw results are in
[reports/deploy.json](../reports/deploy.json). Readiness with cached images took 10.186 s. Once
ready, the 20 deployments and their assertions took 8.852 s; including startup and the final
consensus duties, the script took 19.320 s.

| Path                                                                              | Contracts | Real elapsed time |
| --------------------------------------------------------------------------------- | --------- | ----------------- |
| Signed raw JSON-RPC, polling for receipt                                          | 10        | 4.651 s           |
| `ethers.ContractFactory.deploy` and `waitForDeployment`, including gas estimation | 10        | 4.201 s           |

Median deploy-call-to-receipt latency was 390 ms; p95 688 ms; maximum 1,119 ms. The largest gap
between successive receipts was 1,126 ms. Latency includes client preparation/signing, and mode
elapsed time also includes the per-contract assertions. These are observed timings, not latency
guarantees.

Every constructor stores the previous contract's address. The test alternates 15-byte and 4-KiB
runtime code and checks that code, constructor storage, EVM TIMESTAMP, receipt/block hashes and
exactly one transaction per block. Blocks were numbered 1 through 20 with timestamps advancing by 12
seconds each: 240 protocol seconds total, with zero manual time-advance calls and no sleep between
deployments. Automine drives genuine EL/CL processing. The 4-KiB fixture uses unreachable padding to
exercise code-deposit gas; it does not benchmark a complex application's deployment.

The ethers client uses `pollingInterval: 25`, `cacheTimeout: -1` and `batchMaxCount: 1`; the tested
configuration is shown in [README](../README.md). These settings avoid client polling/cache delays
masking the network's accelerated blocks. Three unrelated containers were running; no other zap-net
test ran concurrently.

## Scope and limits

Verified: native macOS arm64 + Docker Desktop, one EL/BN/VC, 64 genesis validators and one added
key, Pectra from genesis, forward-only time, HTTP RPC/Beacon API. Linux/x86 build/bootstrap paths
exist but were not executed here. No multi-node, later-fork transition, sustained blob load,
WebSocket or long-lived SSE coverage is claimed. All active keys must be held by this VC for phase
barriers.

The EL remains unmodified. On Geth, EngineGate relies on its pinned structured full-payload log
event; Reth's `getPayload` awaits its in-flight build. Check that dependency when changing an EL
version. Network/JWT deadlines and txpool expiration keep real time, and external services' system
clocks are unaffected. Recovery after controller failure is cleanup and reset, not resumption of
existing chain state. Build sources/images are pinned; apt repositories are not snapshotted, so this
is not a claim of bit-for-bit reproducible client binaries.

See [review findings and fixed regressions](review.md). Raw reports contain only local development
keys/addresses, public fixture data and timings; JWT secrets and private key files are not included.

Historical launcher regression: `ZAP_DOCKER_TEST=1 ZAP_E2E=1 deno task test` passed all **14 tests**
through the then-installed system Deno 1.36.4 and a local Deno 2.9.7 compatibility launcher. That
launcher has since been removed; current commands require Deno 2.9.7 directly. A separate post-fix
`deno task test:lifecycle` passed as well. The historical cleanup check left only the two
intentional build cache volumes. The workstation inventory is kept privately.
