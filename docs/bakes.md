# Bake profiles and client versions

Profiles are named after hardforks: `gloas` is the only maintained profile; `pectra` is kept as
history and is not maintained, built or released by CI. Each profile can contain multiple builds
with arbitrary tags. For example, `gloas:default` and `gloas:experiment-2` use the same protocol but
may contain different Lighthouse versions.

A bake is the patched Lighthouse build, the reference Lighthouse (`baselineImage`) and the pinned
genesis generator image. The execution client (EL) is not part of a bake, a recipe or a bake key: it
is the network option `el`, described in [EL catalog](#el-catalog).

| Profile  | EL / CL           | Controller behavior                                                    |
| -------- | ----------------- | ---------------------------------------------------------------------- |
| `pectra` | Prague / Electra  | Engine FCU V3, get/newPayload V4; payload inside BeaconBlock           |
| `gloas`  | Amsterdam / Gloas | Engine FCU V4, getPayload V6, newPayload V5; separate envelope and PTC |

Both profiles use the mainnet preset: 12-second slots and 32-slot epochs. Gloas refers to the pinned
experimental implementation in `bakes/gloas/recipe.json`. Compatibility with another upstream commit
requires verification with the test suite.

## Hardfork layout

Recipes, patches, profile-specific Rust sources and additional tests live in `bakes/<hardfork>/`.
Shared clocks and scenarios live in `bakes/shared/`; built manifests live in `<hardfork>/tags/`. One
builder composes shared components using the profile's declarative strategy.

See the [layout and extension guide](../bakes/README.md). The earlier directory relocation preserved
existing patches, Rust helpers and nine manifests byte for byte. Its checks and limitations are
recorded in the [relocation report](bake-layout-verification.md).

## Build, verify and start

```sh
deno task bake pectra --replace
deno task bake gloas --tag experiment-2

deno task test:profile pectra
deno task test:profile gloas --bake experiment-2

deno task bakes
deno task up --profile gloas --bake experiment-2
```

`up` consumes a built manifest without compiling clients. A missing bake produces an error with the
build command. A running instance with a different profile, tag or explicitly requested EL is
rejected. Use different `CHRONIX_ID` and `CHRONIX_PORT` values for simultaneous networks.

The Lighthouse compiler container uses at most four CPUs, capped by the Docker daemon's reported CPU
count. A two-CPU CI runner therefore gets a two-CPU container limit. Cargo's two concurrent build
jobs are a separate setting; they do not determine the Docker CPU limit.

On a new machine, `--replace` builds local artifacts from the pinned recipe: committed manifests may
refer to images from another host, and Git does not transfer `.cache/`. For an existing local tag,
`deno task bake pectra` reuses its pinned artifacts.

```ts
import { Devnet } from "../src/api.ts";

await using net = await Devnet.start({ id: "contracts", profile: "gloas", bake: "experiment-2" });
await net.advanceTime(3600);
await net.advanceTo(new Date("2033-06-01T00:00:00Z")); // Must be later than current protocol time.
await net.setAutomine(true);
```

`CHRONIX_PROFILE`, `CHRONIX_BAKE` and `CHRONIX_EL` select the same settings through the environment,
including for individual `e2e:*` tasks. Explicit API/CLI options take precedence. The default is
`gloas:default` on `reth-main-f4676ea`. The validator lifecycle commands `test:protocol`,
`e2e:protocol` and `e2e:withdrawal` instead cover all registered hardfork profiles when
`CHRONIX_PROFILE` is unset, using the selected bake tag for each. See the
[readable protocol suites](../bakes/shared/tests/README.md) for their steps and selection.
`build:clients` is an alias for `bake`.

## Other CL versions

```sh
# A compatible Lighthouse ref and clock patch; the profile remains gloas.
deno task bake gloas --tag candidate --cl-ref <commit-or-ref> --patch bakes/gloas/my-clock.patch

# A compatible genesis generator when needed.
deno task bake gloas --tag genesis-candidate --genesis-image <image-tag-or-digest>
```

Genesis and the reference Lighthouse default to the recipe's pinned images. CL is built from its
pinned commit with the profile patch and shared clock source. The builder runs the native Rust clock
test before compiling Lighthouse. Git refs resolve to commits; Docker refs resolve to image
IDs/digests and platforms. If a mutable Docker tag already exists locally, the builder pins that
local image. Use a digest to select an unambiguous version.

Patches apply strictly: an incompatible ref fails the build. Adding a hardfork requires its own
recipe, schedule/Engine/Beacon API support and scenario list. A new tag alone does not change
protocol rules.

`--import-cl <image>` imports an existing controlled-clock image. This pins its ID but does not
prove that the binary was built from the declared source or passed native tests. The import is
recorded in `source.importedCl`; run `test:profile` afterward. The imported binary must match the
recipe's clock environment and protocol. The recipes use `CHRONIX_CLOCK_START_MS` and
`CHRONIX_CLOCK_PORT`.

## EL catalog

Each file `clients/el/<name>.json` is one EL that a network can run:

```json
{
  "client": "reth",
  "image": "ethpandaops/reth@sha256:249a5be9cfefeab2f3a51ca0a051e04ccdce0bff9babb5ac73f74cf72142b527",
  "ids": {
    "linux/amd64": "sha256:abedd96cad0a77f6da717635768609090f3210d37712bf4649cbd52aca3506c1",
    "linux/arm64": "sha256:c0829596463ba0511b5a16e1de232efb3844349d5718fc2655b366db67cf2a3d"
  }
}
```

- `client` selects the client profile in `src/el_client.ts`: `geth` or `reth`.
- `image` is `<repository>@sha256:<digest>` of an index or a manifest. The entry name carries the
  upstream tag.
- `ids` maps each platform to the image config ID. A network uses the ID for its bake's platform; an
  entry without that platform is refused.
- A local build has an image reference without a digest and exactly one platform. It comes only from
  the local Docker daemon or from an archive in the client archive directory (see
  [client images](usage.md#client-images)).

| Entry                         | Client | Image                                        | Platforms    |
| ----------------------------- | ------ | -------------------------------------------- | ------------ |
| `reth-main-f4676ea` (default) | Reth   | `ethpandaops/reth:main-f4676ea` (`f4676eaa`) | amd64, arm64 |
| `geth-master-5d8fd6b`         | Geth   | `ethpandaops/geth:master-5d8fd6b`            | amd64, arm64 |

The default is `defaultEl` in `src/config.ts`. Select another entry with the network option `el`,
`--el <name>` or `CHRONIX_EL` for the CLI, and `CHRONIX_NETWORK` in the service image. A network
keeps its EL: resuming a retained network or restoring a snapshot with another `el` is refused.

To add an entry, pin the digest and the image ID of every platform, check the client's flags,
payload building and shutdown logs against its profile in `src/el_client.ts`, then run
`deno task test:profile gloas --bake <tag> --el <name>`. Another client family needs its own profile
in `src/el_client.ts`.

## Manifests, caches and tag replacement

- Recipes: `bakes/<hardfork>/recipe.json`.
- Built manifests: `bakes/<hardfork>/tags/<tag>.json`, including the recipe, source commits,
  patch/clock hashes, image IDs, digests, platform and builder images.
- Sources, patched trees and artifact caches: ignored `.cache/baker/`.
- Exact local image archives: `.cache/baker/images/<hex>.tar.gz`, named by the image ID without
  `sha256:`. If an image is removed from Docker, the builder restores it from the archive and
  verifies the same image ID. Registry images are restored through their pinned digest. This is also
  the default client archive directory of a network started from source (`CHRONIX_CLIENTS_DIR`).
- Cargo caches: Docker volumes with the exact `io.chronix.id` ownership label.

Repeating `bake` for an existing tag reuses its pinned images. To change it, use `--replace` or
choose another tag. A new manifest is published atomically after a successful build; failure
preserves the previous manifest. Locks protect tags and shared compiler caches against concurrent
writes. Identical inputs under another tag reuse the built artifact. A running network keeps its own
copy of the bake manifest.

The local `bake` command does not publish images. A manifest alone cannot transfer binaries to
another machine. Use a separate build tag for another architecture; image identity and platform
mismatches are rejected.

The separate **Publish Lighthouse images** workflow publishes amd64 clients after their native Rust
tests and emits a `clients.lock.json` containing the original bake plus registry transport identity.
It opens a release PR containing `bakes/<hardfork>/release/clients.lock.json` and the planned
Chronix Git tag. Merging that PR creates the tag and triggers Chronix's full profile and
packaged-service checks before Chronix publication. A failing Chronix check leaves the published
Lighthouse image available for reuse. `clients:pin` remains available for manual recovery.
`deno task clients:restore <hardfork>` restores that exact bake by registry digest and verifies
image IDs; it never compiles or substitutes clients. Chronix Git releases (`vX.Y.Z`) use
independently versioned Lighthouse images (`v<upstream>-<commit>-b<bakerVersion>-<hash>`). See the
[CI publication guide](ci-containers.md) for the full sequence.

## Test suites

`bakes/<hardfork>/recipe.json` explicitly maps scenario names to executable files. `test:profile`
runs only the selected profile and tag's integration scenarios. `test` runs shared unit tests;
`test:baker` separately checks Docker rollback/ownership and the builder. Changing one bake does not
build or test the others.

| Scenario                                                                                     | Pectra | Gloas |
| -------------------------------------------------------------------------------------------- | ------ | ----- |
| Ordinary upstream clients: first block and EL/CL agreement                                   | Yes    | Yes   |
| CLI up/down/reset, stable genesis, rejection of a different profile                          | Yes    | Yes   |
| Pause, advanceTime/advanceTo, future timestamps, automine, nonce gaps, finality, indexer     | Yes    | Yes   |
| Two honest 1000-slot / fast 8192-slot jumps: next transaction, finality and signing history  | Yes    | Yes   |
| Honest warp: participation, attestation rewards, sync/PTC coverage, finality and next deploy | Yes    | Yes   |
| Deposit, key activation and consolidation                                                    | Yes    | Yes   |
| Signed voluntary exit, actual withdrawal and final zero balance                              | Yes    | Yes   |
| Twenty sequential deployments through raw RPC and ethers                                     | Yes    | Yes   |
| Separate envelope, matching bid/hash, PTC votes and phase barriers                           | —      | Yes   |

The consolidation scenario explicitly uses `churnLimitQuotient: 4` to give the small network
consolidation capacity. Gloas also sets the independent `consolidationChurnLimitQuotient: 4`:
changing general churn no longer increases consolidation capacity in this fork. The separate
quotient defaults to the mainnet value of `65536`; other scenarios retain their profile's mainnet
churn. Long exit/consolidation periods use explicit `skipSlots` and incur real protocol penalties.

Verification is per EL: `deno task test:profile <hardfork> --bake <tag> [--el <name>]` runs the
suite on the selected catalog entry (default `reth-main-f4676ea`). Reports are stored in
`reports/profiles/<hardfork>/<tag>/<el>/`. The final `verification.json` records the bake key, the
EL name and its image ID for the bake's platform, a unique run ID, the test/controller/dependency
fingerprint and current results. Reports from another run, bake or EL do not count. Changing code
during verification fails the result. `bakes` reports verification on the default EL and shows
`verified: true` only when the bake key, EL image and current fingerprint match; `verifiedAt`
retains the date of a historically successful run. The fingerprint includes only the selected
profile's scenarios and runtime dependencies. Another profile's changes, future recipes or patch
edits do not invalidate verification of an unchanged baked artifact. Shared runtime changes require
affected profiles to be verified again, without necessarily rebuilding their clients.

Gloas finality is checked through the execution parent of the finalized Beacon checkpoint: that
checkpoint's own envelope is not yet the finalized payload. This follows the
[pinned Lighthouse implementation](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/proto_array/src/proto_array_fork_choice.rs#L363).

Use `--rust-image` for another toolchain. `--baseline-image` selects an ordinary Lighthouse for
checks without controlled clocks. To run a particular bake's native regression:
`deno task test:clock gloas --bake experiment-2`. It uses that bake's archived inputs in
`.cache/baker/inputs/<key>/` and verifies their hashes. Editing a patch for a new build does not
prevent testing an older artifact. A manifest without its source archive is rebuilt; its native
verification is rejected.

Both warp modes use the same immutable client bake. Default `advanceTime`/`advanceTo` preserve
continuous duties; `{ mode: "fast" }` explicitly skips gaps and accepts their ordinary penalties.
The selected Gloas honest implementation remains `direct-sync`, key `e41c863b…`; isolated group
signer research is not installed. Mode selection changes only the controller/API. Pectra is checked
independently with its selected artifact; Gloas timings do not describe Pectra.

Each profile routes `warp` to the long honest scenario, `warp-fast` to the fast scenario, and
`warp-economics` to short continuous-participation checks. Fast has a 25-second budget including the
next transaction; honest has a separate long watchdog and economic gates. Scenario coverage is not a
passing profile verification. See [mode validation](warp-modes.md) and
[historical TDD evidence](warp-tdd-results.md).

The Gloas patch reuses candidate balances and sixteen random values per SHA-256 digest; small
validator sets use upstream batch shuffling. Native tests compare PTC and proposer selection with
the original algorithm. Before resuming the VC, the BN processes real empty slots once and retains
the resulting states for duties, proposals and block validation. Preparation does not substitute the
canonical head or finalized checkpoint. Bakes with `preparedSkip` use ordinary bounded waits in
place of the earlier 10–12 minute catch-up. Runs concurrent with compilation are not performance
measurements.

## Stable time advancement

This section records stabilization on September 29, 2026. Reruns after the September 30 directory
relocation are recorded in a [separate report](bake-layout-verification.md).

The selected `gloas/stable` uses the same immutable image as `fast-warp-v3`, with ordinary
`store.put_state` calls for every intermediate state. Batched summary writes from v4 and a separate
equal-balance branch from v5 were excluded. Further optimization was paused at the user's request to
keep the client change smaller. Controlled mode uses Lighthouse's standard
`--hierarchy-exponents=9,13,16,18,21`; protocol constants are unchanged.

That full suite passed 8/8 scenarios with `verified: true`. Its two 8192-slot jumps including the
following transaction took 10.8 / 11.6 seconds. Both resumed finality; all 64 validators continued
signing without slashing or conflicts. At that stage the regression threshold was 25 seconds to
account for VC startup variation; the earlier 10-second target is no longer an acceptance criterion.
The report is `reports/profiles/gloas/stable/verification.json`.

On September 30, 2026, the user approved raising the shared threshold from 20 to 25 seconds. This
changed the test criterion while retaining the advancement algorithm and finality/signing-history
checks.

During direct-sync work, the assistant incorrectly treated 25 seconds as a nonblocking target and
introduced a 30-minute watchdog. The user rejected the resulting run and requires at most one
minute. That watchdog must be corrected before another large test; it is not an accepted performance
budget.

```sh
deno task up --profile gloas --bake stable
deno task test:profile gloas --bake stable
```

## Lighthouse upstream and baker identity

Each current recipe declares `clVersion` and `bakerVersion` alongside the pinned `clRef`. The native
builder checks `clVersion` against the source's Cargo package version. For an explicit `--cl-ref`
override, it records the version actually found in that source. Only the latest manifest layout and
format are supported: old tags, networks and snapshots are rebuilt, not read through compatibility
paths.

A native bake records `lighthouse.upstream` (version, full commit and repository),
`lighthouse.baker` (version and input hash), platform and its own client build key. The baker hash
covers the builder implementation/dependencies, selected patch, clock, native sources/tests and
pinned build/runtime images. An explicit baker-version bump or changed baker inputs produces a new
image identity. Chronix controller changes and other profiles' native patches do not.

The separate `.cache/baker/lighthouse/<key>.json` cache lets a new genesis or reference-Lighthouse
selection reuse an unchanged native Lighthouse image. Full bake identity still includes the entire
selected recipe and all its image identities. Existing local tags remain immutable; select a new tag
for a new combination.

CI derives a client image tag from upstream and baker versions. If that image already exists, it
passes its immutable digest to `bake --reuse-cl <digest>`. The builder verifies the complete
identity embedded in the image before accepting it, preserving native build provenance. This differs
from `--import-cl`, which makes no claim that an arbitrary image was built and tested by this baker.
The profile suite runs against the selected combination before publishing a new client lock.
