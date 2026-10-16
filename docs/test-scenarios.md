# Test scenarios and API coverage

Which scenarios tests may need and how to describe them today. Work plan:
[scenario-api-plan.md](scenario-api-plan.md). ✅ supported, ⚠️ supported with limitations, ❌ not
supported.

## Time and chain

| Scenario                                 | How                                                                     | Status                                  |
| ---------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| Advance slots, epochs, time or to a date | `stepSlot`, `advanceSlots`, `advanceEpochs`, `advanceTime`, `advanceTo` | ✅                                      |
| Long downtime without blocks             | `skipSlots` or `advanceTime(..., { mode: "fast" })`                     | ✅                                      |
| Wait for finality                        | `advanceUntil` + `status().finality`                                    | ✅                                      |
| Sequential transactions and deployments  | `setAutomine(true)`                                                     | ✅                                      |
| Several transactions in one block        | automine off, send the transactions, then `stepSlot`                    | ✅                                      |
| Branch and return to a saved state       | `createSnapshot` / `restoreSnapshot`                                    | ✅                                      |
| Trace a transaction or its revert reason | `debug_traceTransaction`, `debug_traceCall` and other read-only methods | ✅ mutating `debug_*` calls are refused |

## Genesis

Everything a scenario needs from the first block is set with the `genesis` option of `Devnet.start`,
the CLI flag `--genesis <file.json>` or `PANDA_GENESIS` in the CI image. Without `genesis` the
network is unchanged. Details: "Genesis parameters" in [usage.md](usage.md).

### EL: accounts (alloc)

A wallet and a contract are the same genesis allocation: an address with a balance, plus code and
storage for a contract.

| Parameter                                          | How                                          | Status |
| -------------------------------------------------- | -------------------------------------------- | ------ |
| Accounts: any addresses with balances              | `accounts: { [address]: { balance } }`       | ✅     |
| Mnemonic accounts: N addresses with one balance    | `mnemonicAccounts: { count, balance }`       | ✅     |
| Contracts: address → code, storage, balance, nonce | `accounts: { [address]: { code, storage } }` | ✅     |
| Genesis and target gas limit                       | `gasLimit`                                   | ✅     |
| Chain ID                                           | `chainId`                                    | ✅     |
| Genesis time                                       | `genesisTime`                                | ✅     |

### CL: validators

Validators are defined in groups, each with its own parameters.

| Group parameter                               | How                                                                              | Status |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| Count                                         | `validators: [{ count }]` or `validators`, 64–1024 in total                      | ✅     |
| Balance (e.g. compounding above 32 ETH)       | `balance: "2048ETH"`                                                             | ✅     |
| Credential type: 0x00, 0x01 or 0x02           | `withdrawal: { type }`                                                           | ✅     |
| Withdrawal address (e.g. a protocol contract) | `withdrawal: { address }`                                                        | ✅     |
| Key mnemonic                                  | `mnemonic` and `start` per group; otherwise groups continue the managed mnemonic | ✅     |
| Group silent from genesis                     | `online: false`: keys are in the VC but disabled from the first slot             | ✅     |
| Fee recipient                                 | `feeRecipient` for all, `configureValidator` for one validator                   | ✅     |

### Protocol constants

Only network config values change; the preset stays mainnet with 32 slots of 12 seconds per epoch.

| Parameter                                                       | How                                                     | Status                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `CHURN_LIMIT_QUOTIENT`, `CONSOLIDATION_CHURN_LIMIT_QUOTIENT`    | `churnLimitQuotient`, `consolidationChurnLimitQuotient` | ✅                                                       |
| `SHARD_COMMITTEE_PERIOD`, `MIN_VALIDATOR_WITHDRAWABILITY_DELAY` | `spec`                                                  | ✅                                                       |
| `EJECTION_BALANCE`, churn limits                                | `spec`                                                  | ✅                                                       |
| Blob limits                                                     | `blobSchedule: [{ epoch, max, target }]` for EL and CL  | ✅                                                       |
| Gloas fork epoch (fork during a scenario)                       | `gloasForkEpoch`; Fulu before the fork                  | ✅ PTC votes start one epoch after the fork (Lighthouse) |

## Validators

| Scenario                                              | How                                                                                                                                                                  | Status                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| New validator: deposit and activation                 | key generated by the test, `importValidator`, deposit contract transaction, `advanceUntil`                                                                           | ✅                         |
| Exit through the VC                                   | `exitValidator`                                                                                                                                                      | ✅                         |
| Exit through the EL (EIP-7002)                        | `withdrawal` scenario: request from the withdrawal address with the contract's fee; it takes effect in the child block of its payload, once after a withheld payload | ✅                         |
| Partial and full withdrawals                          | transactions + `skipSlots` / `advanceUntil`                                                                                                                          | ✅                         |
| Consolidation                                         | system contract transaction; churn set in the config                                                                                                                 | ✅                         |
| Slashing                                              | conflicting signatures with a key of the public mnemonic, then the Beacon API pool                                                                                   | ✅ the test signs with BLS |
| Import a key                                          | `importValidator`                                                                                                                                                    | ✅                         |
| One validator or a group offline                      | `setValidatorsOnline(indices, false)`                                                                                                                                | ✅                         |
| Partial participation, lost finality, inactivity leak | `setValidatorsOnline` for part of the set, honest advancement                                                                                                        | ✅                         |
| Remove a key from the VC or move it                   | `removeValidator` returns keystore, password and signing history; `importValidator`                                                                                  | ✅                         |
| Fee recipient, gas limit, graffiti of one validator   | `configureValidator`                                                                                                                                                 | ✅ snapshots stay allowed  |
| Missed proposal while attestations continue           | `missProposal(slot)`                                                                                                                                                 | ✅                         |
| Gloas: block published, payload withheld              | `withholdPayload(slot)`                                                                                                                                              | ✅                         |

## Clients

| Scenario                                    | How                                                                              | Status                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Crash or restart of EL, BN, VC and recovery | `stopClient`, `startClient`, `restartClient(role, { kill })`, `clients()`        | ✅ a killed Geth cannot recover its head without peers; restart EL gracefully |
| Client logs                                 | `panda logs el\|cl\|vc` in the container; locally, logs are saved on down        | ✅                                                                            |
| Event subscription (head, finalized)        | SSE `/eth/v1/events` through the controller; the CI image also exposes port 5052 | ⚠️ the stream is bounded by the one-hour watchdog; no e2e coverage            |

## Remaining gaps

All plan items are done. Client limitations and details: [usage.md](usage.md); plan:
[scenario-api-plan.md](scenario-api-plan.md).
