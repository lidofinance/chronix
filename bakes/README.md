# Bake layout

Each hardfork keeps its build inputs and additional tests in one directory. The shared builder is
[`src/baker.ts`](../src/baker.ts); the shared `Recipe` type and explicit registry are in
[`src/profiles.ts`](../src/profiles.ts).

```text
bakes/
  shared/
    controlled_clock.rs
    controlled_clock_test.rs
    native/                   # shared Rust helpers and their native regressions
    patch_bls.py              # shared part of the patch.py tools
    patch_direct_sync.py      # direct delivery of verified sync votes
    tests/                    # shared e2e tests and fixtures
  pectra/
    recipe.json
    lighthouse.patch
    patch.py                  # maintainer tool, not a regular bake step
    tags/                     # completed builds by tag
    release/clients.lock.json # selected published bundle for Chronix releases
  gloas/
    recipe.json
    lighthouse.patch
    patch.py
    native/                   # additional Rust sources for this profile
    tests/                    # envelope/PTC and other profile-specific checks
    tags/
```

A profile is a **data-defined strategy**. The shared clock and tests are included through
**composition**: the recipe references their files. The pin → snapshot → prepare → native tests →
compile → publish sequence is implemented once. There is no class hierarchy or separate copy of the
builder for each fork.

| File/directory                         | Purpose                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `<hardfork>/recipe.json`               | Compatible CL/genesis/baseline versions, toolchain, paths, Engine/phase metadata, and an explicit scenario → file map.              |
| `<hardfork>/lighthouse.patch`          | Verified patch against the pinned upstream commit.                                                                                  |
| `<hardfork>/native/`                   | Additional sources, if needed; included in the build hashes.                                                                        |
| `shared/native/`                       | Helpers used by multiple profiles; included through their patches and nativeTests.                                                  |
| `shared/tests/`                        | Shared executable scenarios and helpers, without copies per profile.                                                                |
| `<hardfork>/tests/`                    | Only additional scenarios specific to the profile. An empty directory for symmetry is unnecessary.                                  |
| `<hardfork>/tags/<tag>.json`           | Completed immutable manifest with sources, hashes, and image IDs; created by the baker.                                             |
| `<hardfork>/release/clients.lock.json` | Selected published amd64 bundle: the source bake and Lighthouse registry digest. Client CI automatically adds it to the release PR. |

The root `tests/` directory contains fast unit tests and shared Docker/baker checks. Reports are in
`reports/profiles/<hardfork>/<tag>/<el>/`, one directory per EL. The EL is not a bake input: it is
the network option `el` from the catalog `clients/el/` (see
[EL catalog](../docs/bakes.md#el-catalog)). Third-party sources, input archives, compiler caches,
and build artifacts are in the ignored `.cache/baker/` directory.

Lighthouse is published by a separate workflow with the tag
`v<upstream>-<commit>-b<bakerVersion>-<hash>`. The `clVersion`, `clRef`, and `bakerVersion` fields
are set in the recipe. The baker input hash covers its code, patches, clock, and pinned environment;
changing the controller does not change the Lighthouse version. Chronix releases take their version
from the Git tag `vX.Y.Z` and use the pinned bundle without compiling clients. The selection file
appears after the first actual publication; see the [CI guide](../docs/ci-containers.md) for
details.

`sourceFiles` records additional native inputs in the hashes and archive. The verified patch wires
them into upstream; adding a file to the list alone does not include it in the Rust build.
`patch.py` is a maintainer tool for preparing the patch and does not run automatically during a
regular build. The builder installs the shared clock source and its test separately from the input
snapshot.

Binary capabilities are declared in the recipe and saved in the immutable manifest. For example,
`clockWait: true` enables waiting for actual phase marks through native notification with a real
timeout. The controller reads the selected tag's capability; older tags continue to use polling.
Changing the current recipe does not enable a new capability in an already built image.

`directSync: true` declares controlled-only delivery of full sync contributions from already
verified individual messages into the regular operation pool. The VC retains its keys and normal
signatures, but does not compute sync selection proofs or gossip wrapper signatures. The BN confirms
all positions in the four subcommittees with a mark for the specific slot/root. The controller binds
this mark to the same head whose execution has already been confirmed. Incomplete participation
produces a bounded error; the VC mark alone is not confirmation. The clock stores only the latest
root for this phase.

Gloas may deliver votes before the envelope: placing them in the candidate pool does not confirm EL
validity. Standard block, envelope, and PTC checks and protection for slashable signatures remain in
place. The native `beacon_chain/chronix_direct_sync` regression uses a pre-merge component fixture
without an EL; compatibility of real EL/CL clients is checked by a separate selected `test:profile`.

## Change the version in an existing profile

```sh
deno task bake gloas --tag candidate --cl-ref <commit> --patch bakes/gloas/lighthouse.patch
deno task test:profile gloas --bake candidate
deno task up --profile gloas --bake candidate
```

The new tag uses the same profile. `up` does not compile clients. See the
[version guide](../docs/bakes.md) for the full list of overrides and artifact details.

## Add a hardfork

1. Create `bakes/<hardfork>/recipe.json` based on an existing profile. Specify compatible pins,
   toolchain, schedule, Engine versions, and paths to shared sources. Add only the profile-specific
   patches/native helpers that are needed.
2. Explicitly list report names and scenario files in `tests`. Include shared scenarios from
   `bakes/shared/tests/`; place new checks in the profile directory.
3. Add the recipe import and one entry in `profiles` in `src/profiles.ts`. The shared builder does
   not need changes. If the protocol itself changes Engine/Beacon behavior, add failing tests first,
   then the corresponding runtime support; a recipe declaration cannot replace it.
4. Run `deno task check`, fast tests, `bake <hardfork> --tag <tag>`, and
   `test:profile <hardfork> --bake <tag>`. Native tests are part of the build; rerun them for an
   existing artifact with `test:clock <hardfork> --bake <tag>`.

Changing one profile does not require building the others. The test fingerprint includes only the
selected scenario map and its executable dependencies. Shared runtime changes require validation for
every profile released with them; shared Docker/baker checks run separately via `test:baker`.

## Only the current layout

Manifests live only in `<hardfork>/tags/<tag>.json`. Only the latest layout and formats are
supported: old tags, networks and snapshots are rebuilt, not read through compatibility paths.
Native tests use the exact archived inputs of their bake; a bake without them is rebuilt. The tag
name `recipe` does not conflict with the profile definition.

Changed test paths change the suite fingerprint: old results remain historical; a current `verified`
status appears after an actual run of the new suite. This does not change the binaries.
