# Plan: scenario API

Working plan for extending Panda's API to describe test scenarios. Updated after every step.
Scenario coverage: [test-scenarios.md](test-scenarios.md).

## Rules

- Every item: a failing test, the implementation, an e2e scenario on real clients, then a full
  regression with `deno task test:profile gloas --bake <tag>`.
- Gloas only. Clients are not patched while a reliable Panda-side solution exists.
- No item leaves the plan silently: it is either done with evidence, or explicitly postponed or
  dropped with a reason and agreement.

## Done

Verified on bake `gloas:snapshot-minimal-r1` (linux/arm64): final full regression 23/23 (37 min 42
s), `verification.json` `passed` and `verified: true` for the current suite hash; 350 unit tests;
`deno task check` clean.

| Item                                                                                                                             | Evidence                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Builds, tests, packaging and CI forms: Gloas only                                                                                | `tests/maintained_profiles_test.ts`                                                                             |
| Geth `debug` namespace with mutating methods refused                                                                             | `tests/execution_rpc_test.ts`, e2e `genesis`                                                                    |
| Genesis parameters: allocations, mnemonic accounts, gas limit, validator groups, fee recipient, config values                    | `tests/genesis_test.ts`, e2e `genesis`                                                                          |
| Genesis through CLI `--genesis` and `PANDA_GENESIS`                                                                              | `tests/genesis_test.ts`                                                                                         |
| Client control: stop, start, restart, kill                                                                                       | `tests/time_test.ts`, e2e `clients`                                                                             |
| Validators: online/offline, key removal and import, settings, `missProposal`, `withholdPayload`, sync aggregator                 | `tests/validator_control_test.ts`, `tests/consensus_test.ts`, `tests/sync_aggregator_test.ts`, e2e `validators` |
| Genesis groups with their own mnemonic, and groups silent from genesis                                                           | `tests/genesis_test.ts`, e2e `genesis`                                                                          |
| Genesis blob limits (`blobSchedule`) for EL and CL                                                                               | `tests/genesis_test.ts`, e2e `blob-schedule`                                                                    |
| Up to 1024 validators: attestation aggregator selection in barriers; 2.1 honest slots/s, 0.7 slots/s with 64 offline             | `tests/sync_aggregator_test.ts`, `tests/consensus_test.ts`, e2e `large-network`                                 |
| Gloas fork during a scenario (`gloasForkEpoch`): Fulu timing before, Gloas after; PTC from the epoch after the fork (Lighthouse) | `tests/forks_test.ts`, `tests/consensus_test.ts`, `tests/ptc_readiness_test.ts`, e2e `fork-transition`          |
| Offline state in snapshots                                                                                                       | e2e `validators`, step 8                                                                                        |

## Completion

| # | Item                                  | Status | Notes                                                                 |
| - | ------------------------------------- | ------ | --------------------------------------------------------------------- |
| 6 | Audit of the changes and fixes        | done   | three reviewers plus an independent verification pass; findings below |
| 7 | Full Gloas regression after the audit | done   | 23/23 in 37 min 42 s, `verified: true`                                |

## Release prerequisites

Not part of the functional plan, but required before a release:

- Publish new amd64 Lighthouse clients: the release lock was built from an earlier
  `lighthouse.patch`.
- Release CI must pass the same 23 scenarios on amd64; the evidence above is arm64 only.

## Dropped

- SSE `/eth/v1/events`: not requested; the controller already proxies the stream.

## Audit findings

Statuses: fixed (with a regression test), accepted (risk documented), open.

| ID  | Severity | Finding                                                                                    | Status                                                                                                                                                   |
| --- | -------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | medium   | `debug_*` allowlist bypassed through JS/Go parser differences (trailing data, `Method`)    | fixed, `tests/execution_rpc_test.ts`                                                                                                                     |
| A2  | medium   | Geth's internal port (127.0.0.1) serves `debug` without the allowlist                      | accepted: internal port on 127.0.0.1 only, documented in usage.md (Execution tracing)                                                                    |
| A3  | medium   | aggregator signing domain taken from the head state instead of the fork schedule           | fixed: version from `config/fork_schedule`, `tests/sync_aggregator_test.ts`                                                                              |
| A4  | medium   | scrypt keystores and upper-case checksums break the aggregator                             | fixed: scrypt, case, bounded KDF parameters; EIP-2335 vectors                                                                                            |
| A5  | low      | republished contributions swallowed "Unknown…" errors                                      | fixed: catch removed (beacon node answers a repeat with 200)                                                                                             |
| A6  | low      | `removeValidator` returns the key over `/control` of the CI image                          | accepted: disposable development keys, documented in usage.md (Validator control)                                                                        |
| A7  | low      | password and YAML escaping differ from Lighthouse                                          | fixed: same as Lighthouse, `tests/validator_control_test.ts`                                                                                             |
| A8  | low      | finalized EL/CL snapshot check passed on missing data                                      | fixed: a 32-byte hash is required, `tests/saved_state_test.ts`                                                                                           |
| B1  | high     | automine used Geth's old port after an EL restart                                          | fixed: the EL endpoint is read on every call, `tests/automine_test.ts`                                                                                   |
| B2  | medium   | Ctrl-C with a stopped client or a scheduled fault marked the network faulted               | fixed: shutdown restarts clients and drops faults, `tests/snapshot_controller_test.ts`                                                                   |
| B3  | medium   | `fromSnapshot` with `genesis` always failed (objects compared with `!==`)                  | fixed: `configMismatch` compares values, `tests/config_test.ts`                                                                                          |
| B4  | medium   | EL kill documented as supported but untested                                               | fixed: a killed Geth does not recover without peers (confirmed by logs); e2e `clients` covers VC/BN kill and graceful EL restart; documented in usage.md |
| B5  | medium   | `verification.json` stale after new scenarios                                              | fixed: final regression 23/23, `verification.json` current                                                                                               |
| B6  | low      | the `--miner.gaslimit` assertion could not fail (60M is Geth's default)                    | fixed: `gasLimit` also sets `GAS_LIMIT_SCHEDULE` for Gloas; e2e `genesis` at 45M                                                                         |
| B7  | low      | gas limit and graffiti of `configureValidator` untested                                    | fixed: e2e `validators` checks fee recipient, graffiti and gas limit; gas limit delay documented                                                         |
| B8  | low      | EngineGate kept payload readiness of the old Geth after a restart                          | fixed: `tests/engine_attach_test.ts`                                                                                                                     |
| B9  | low      | logs of earlier client runs overwritten after resume                                       | fixed: time-based log names, `tests/config_test.ts`                                                                                                      |
| B10 | low      | weak assertions in `fork_transition` and `blob_schedule`                                   | fixed: finalized EL/CL, head after restore, blob transaction acceptance                                                                                  |
| B11 | low      | a failed `startClient` left the role without a container                                   | fixed: the old container is renamed and restored on failure, `tests/network_permissions_test.ts`                                                         |
| C1  | high     | first Gloas slot with an active view: PTC duty query failed (head still Fulu)              | fixed: PTC is neither queried nor awaited in the fork epoch, `tests/ptc_readiness_test.ts`                                                               |
| C2  | high     | `missProposal` before the fork: the VC requests blocks with `GET /eth/v3/...`, not refused | fixed: refused for any method, `tests/validator_control_test.ts`                                                                                         |
| C3  | medium   | slot view cache not refreshed after key changes within a slot                              | fixed: view bound to the key version, `tests/consensus_test.ts`                                                                                          |
| C4  | medium   | automine dropped transactions after a slot without a block (silent proposer, missed slot)  | fixed: a slot without a block does not end automine, `tests/automine_test.ts`                                                                            |
| C5  | low      | same as A3: fork version for the domain after a missed first Gloas slot                    | fixed with A3                                                                                                                                            |
| C6  | low      | the withheld-payload state was lost when the controller reconnected                        | fixed: detected from a Gloas head without an envelope, `tests/consensus_test.ts`                                                                         |
| N1  | low      | the aggregator cached a failed genesis/fork_schedule lookup forever                        | fixed: failures are not cached, `tests/sync_aggregator_test.ts`                                                                                          |
| N2  | low      | one transaction could drive up to 256 empty automine slots                                 | fixed: at most 32 slots without a block per notification, `tests/automine_test.ts`                                                                       |
| N3  | low      | during `startClient` two containers share a role; a failed removal blocked the role        | fixed: the replaced container never counts for the role and its removal cannot block it, `tests/network_permissions_test.ts`                             |
| N4  | low      | scrypt bounds allowed about 2 GiB inside a barrier                                         | fixed: scrypt capped at the EIP-2335 default cost (256 MiB), `tests/sync_aggregator_test.ts`                                                             |
| N5  | low      | a transaction body with trailing data was not treated as a write                           | fixed: such a body is a write, `tests/execution_rpc_test.ts`                                                                                             |
| N6  | low      | tautological version assertion in a test                                                   | fixed: the test checks that the version increases                                                                                                        |
| A3+ | low      | the A3 test did not exercise `domain()` itself                                             | fixed: the test checks `domain()` against the fork schedule while the head reports an older fork                                                         |
