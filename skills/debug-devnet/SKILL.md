---
name: debug-devnet
description: Diagnose stopped Chronix chains, missing finality, txpool gaps, and EL/CL or external-service failures. Use when a devnet stops producing blocks, stops finalizing, does not include transactions, a payload or Engine API call stalls, a container exits, or the user asks why the chain is stuck. Prefer Chronix-side fixes; for code changes use develop-feature.
---

Run deno task diagnose and inspect .chronix/<id>/*.log plus manifest.json. Compare Beacon head
slot/root, current controlled clock, latest EL hash/timestamp, finalized checkpoints and validator
completion watermarks. Check container exits before waiting for API readiness.

For no blocks: confirm keys/indices, proposer duty, BN sync state, Engine API JWT and
getPayload/newPayload errors. For no finality: inspect participation, attestation/aggregate
watermarks and epoch transitions. For no inclusion: inspect txpool_content, sender nonce, balance,
fees and gas limit before advancing again. Automine waits only for transactions the EL's builder
includes: the effective tip must reach the profile's `minimumTip` in `src/el_client.ts` (Geth 1
Mwei, Reth 0). A nonce gap is not a reason to produce unbounded blocks.

Use deno task smoke:docker to isolate transport and deno task baseline to isolate clock changes.
Preserve failing logs before deno task reset. Never restart unrelated containers or run global
Docker prune.

Report the failing boundary, evidence, hypothesis, smallest reproduction and the verification
result. Separate observed causes from guesses.

For a current payload stall, check the network's EL (`lifecycle().el`) and its gate in
`src/el_client.ts`, then inspect `src/engine.ts`. On Geth (`gate: log`) look for the JSON
`Updated payload` message with the payload id; a missing event must time out visibly. On Reth
(`gate: none`) `getPayload` goes straight to the EL, which waits for its own build; look for
`UnknownPayload` after a long real-time pause. The gate must suppress future-slot attributes and
preserve real-time JWT validation. `Execution persistence was not confirmed` means the stopped EL's
log lacks its persistence lines (Geth: `Blockchain stopped`, `Persisted dirty state`; Reth:
`persistence complete, signaling termination`, never `Termination failed`). After `skipSlots`, read
updated VC endpoints from manifest.json; Docker Desktop may not immediately release old private
ports.

Prefer Chronix-side fixes. Before changing client source, apply the minimal-change rule in
[develop-feature](../develop-feature/SKILL.md), including independent subagent review.
