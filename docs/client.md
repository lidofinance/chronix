# Chronix client

`@lidofinance/chronix-client` is the typed HTTP client of a running Chronix controller: a local
`deno task up`, a CI image service, or a controller started by Chronix's own `Devnet.start`. It has
no dependencies and no build step. It works in Node 22+ and Deno. The same client powers Chronix's
`Devnet`, the CLI and every end-to-end scenario.

## Install

From GitHub, at a release tag or any commit:

```sh
npm i github:lidofinance/chronix#<tag-or-commit>   # npm, pnpm and yarn accept the same reference
```

Tags up to `v1.0.1` predate the rename and do not provide `@lidofinance/chronix-client`.

The first release tag containing the client is the one after v0.3.0; until then pin a commit.

npm installs only `client/mod.js`, `client/types.d.ts`, `client/openapi.json`, the README, the
license and `package.json`. No tsconfig changes are needed: the package is JavaScript with
declaration files, so plain `node`, `tsx`, `vitest` and strict `tsc` all work.

As a git submodule:

```sh
git submodule add https://github.com/lidofinance/chronix vendor/chronix
```

Then import `./vendor/chronix/client/mod.js` from Node or Deno. Deno reads the types from the
module's JSDoc, which points at `types.d.ts`.

## Use

```ts
import { ChronixClient, ChronixError } from "@lidofinance/chronix-client";

const chronix = new ChronixClient("http://127.0.0.1:8545", { timeoutMs: 600_000 });
await chronix.setAutomine(true);
const { slot } = await chronix.advanceEpochs(2);
await chronix.advanceUntil(
  async () => BigInt((await chronix.status()).finality.data.finalized.epoch) >= 3n,
  { maxSlots: 160 },
);
const chainId = await chronix.rpc<string>("eth_chainId");
const head = await chronix.beacon("/eth/v1/beacon/headers/head");
```

Every control command has a method; `chronix.command(name, params)` sends any of them with its
parameter tuple. Signatures, errors and types: [client API reference](client-api.md). A failed
request throws `ChronixError` with the controller's message and HTTP `status`; a failed snapshot
operation throws `SnapshotOperationError` with the recorded `operation`.
`exportSnapshot(id, path, { maxBytes })` writes a new file atomically, requires and verifies the
controller's SHA-256 and refuses archives above `maxBytes` (8 GiB by default); it uses `node:fs`,
loaded only when called. The default request deadline is one hour.

## OpenAPI

`client/openapi.json` (OpenAPI 3.1) describes `POST /control/{method}` for every command, the
envelope form `POST /control`, `GET /lifecycle`, `GET /snapshots/{id}/archive` and the `Genesis`
startup document. It is part of the package (`@lidofinance/chronix-client/openapi.json`) and can
generate clients in other languages. The [control API reference](control-api.md) is the same
contract as a table.

## Development

- `client/types.d.ts` is the only place with the wire and client types. `client/mod.js` is checked
  against it (`// @ts-check`, `@implements`, `@type` on each method), so a mismatch fails
  `deno check`. Never add `// @ts-self-types` to `mod.js`: it replaces the module's types and turns
  the check off.
- The controller imports the same types. Its command table, client roles, spec overrides and profile
  names are checked against them at compile time.
- After changing a type run `deno task docs:api`; `deno task check` verifies that
  `client/openapi.json`, `docs/control-api.md` and `docs/client-api.md` are current. `deno doc`
  drops `?` on tuple elements, so spell optional parameters as alternative tuples:
  `[id] | [id, operationId]`.
- `deno task test:client` runs the client tests under Node, installs the working tree from a
  throwaway git commit exactly as `npm i github:...` does, checks the installed files, type-checks a
  consumer with strict `tsc` and runs it with plain Node. It needs Node 22+ and network access for
  the pinned TypeScript compiler.
- The release PR sets `package.json` to the release tag's version, so an install from a tag reports
  that version; a later commit reports the last release it descends from (`0.0.0-dev` before the
  first release with the client).
