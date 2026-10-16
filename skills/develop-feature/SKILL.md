---
name: develop-feature
description: Implement features in Chronix, including Deno APIs, Docker lifecycle, and the Lighthouse clock patch. Use when adding or changing controller behavior, CLI tasks, Docker orchestration, configuration, protocol time or warp logic, or when a fix may require a client patch. Applies the minimal-change rule for Lighthouse; for bake/version work use maintain-bakes and for validation use test-change.
---

Read AGENTS.md and the affected source before editing. Protocol time belongs to the Lighthouse
clock; real deadlines belong to src/http.ts. Preserve mainnet constants and real signature/state
validation.

Keep changes as small and isolated as possible. Solve problems through Chronix's controller,
configuration and existing client APIs first. Change Lighthouse source only as a last resort, after
the implementing agent and independent review subagents have checked those alternatives and agree
that no reliable Chronix-side solution exists. Record why the source change is unavoidable and limit
the patch to that necessity. Injected native helpers count as client source changes too.

Keep Docker calls in src/docker.ts and topology in src/network.ts. Resource ownership is the exact
io.chronix.id label. Startup failure and repeated down must clean up only that id. Avoid adding
dependencies when Deno or existing dockerode suffices; pin direct versions in deno.json and retain
deno.lock.

For an unavoidable client source change, inspect the pinned upstream files and maintain the smallest
isolated patch. Validate the selected bake with maintain-bakes and test-change; never replace
networking or JWT clocks globally.

The public API lives in `client/`: `types.d.ts` is the only place for wire and client types, and
`mod.js` is plain JavaScript checked against it (keep `// @ts-check`, `@implements {Api}` and
`@type {Api["name"]}` on prototype methods; never add `@ts-self-types`). To add or change a control
command, update `Commands` and `ChronixClientApi` in `types.d.ts`, the method in `mod.js`, and the
controller's `controlCommands` table and dispatch; `deno check` fails until all agree. Spell
optional parameters as alternative tuples (`[a] | [a, b]`). Then run `deno task docs:api` to
regenerate `client/openapi.json`, `docs/control-api.md` and `docs/client-api.md`, and commit them
with the change. Keep `client/` free of dependencies and of imports from `src/`; the CI image copies
it, so a new top-level source directory must be added to `imageSources` in `src/release.ts`.

Run deno task check and deno task test; choose integration checks with test-change. Report behavior
changed, files, executed checks, and remaining limitations.
