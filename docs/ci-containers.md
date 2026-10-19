# Versioned CI images

## Separate Lighthouse and Chronix releases

Lighthouse is built by **Publish Lighthouse images** (`.github/workflows/lighthouse.yml`). Chronix
is packaged by **Publish Chronix images** (`.github/workflows/images.yml`). Publishing a new Chronix
version pulls existing client images by digest; it never invokes the Rust compiler or `bake`.

Each successful stable Chronix publication also updates `chronix-<profile>:latest` to the same
image. Prereleases keep the existing `latest` tag unchanged.

| Artifact                    | Example                                                   | Version source   |
| --------------------------- | --------------------------------------------------------- | ---------------- |
| Patched Pectra Lighthouse   | `chronix-lighthouse-pectra:v7.1.0-cfb1f7331064-b1-<hash>` | Upstream + baker |
| Patched Gloas Lighthouse    | `chronix-lighthouse-gloas:v8.2.2-2d281dfa1b40-b1-<hash>`  | Upstream + baker |
| Chronix with Pectra clients | `ghcr.io/lidofinance/chronix-pectra:v1.2.3`               | Git tag `v1.2.3` |
| Chronix service for Gloas   | `ghcr.io/lidofinance/chronix-gloas:v1.2.3`                | Git tag `v1.2.3` |

Lighthouse repositories also live under `ghcr.io/lidofinance/`. Their tags are derived
automatically: `v<upstream-version>-<commit-12>-b<baker-version>-<baker-hash-12>`. There is no
manually assigned client release number. `clVersion`, the pinned `clRef`, and `bakerVersion` are
declared in each profile recipe. The builder reads the actual upstream Cargo package version and
rejects a mismatch. Only Gloas images are built and published now; the Pectra rows document
historical releases. The existing pins declare 7.1.0 for Pectra and 8.2.2 for Gloas; the Gloas
commit identifies the experimental branch even though its Cargo version is shared with other
revisions.

The two inputs that invalidate a Lighthouse image are:

1. **Upstream Lighthouse:** its original package version and exact Git commit.
2. **Chronix's baker:** its explicit version and the content hash of builder code, the selected
   patch/clock/native sources, native test targets, pinned toolchain/runtime images and platform.

Bump `bakerVersion` when releasing a new baker revision. The content hash also changes automatically
when a build input changes, protecting against accidentally reusing an image after an unbumped edit.
Changing another profile's patch or changing the Chronix controller does not invalidate this image.
Rust and runtime image refs must be immutable before the CI identity is computed. The Gloas Rust
builder is now pinned to the digest already recorded in its existing bake.

The complete CL/genesis selection has a separate `ci-<hash>` bake tag. Updating genesis, the
baseline client or runtime profile settings changes that selection, while retaining the same
Lighthouse identity. The EL is not part of it: a release ships the catalog `clients/el/` and the
default EL `reth-main-f4676ea`, and Chronix verifies that EL before publication. The native
Lighthouse cache is likewise separate from the full-bake cache. Two Chronix Git versions can
therefore reuse precisely the same Lighthouse image and client lock.

## First publication and client updates

The normal release flow is **Run workflow → release PR → maintainer merge → automatic Chronix
release**. Downloading artifacts, copying locks and pushing the release tag are automated.

1. Keep the desired `clVersion`/`clRef` and `bakerVersion` in each profile recipe on the default
   branch. In **Publish Lighthouse images**, enter the future Chronix tag in `version` (for example
   `v1.2.3`) and choose the profile; the form offers only the maintained `gloas`. Pectra stays in
   the repository as history and cannot be selected. Invalid or occupied Git tags and missing
   unchanged locks are rejected before compilation.
2. The workflow builds the exact `linux/amd64` Lighthouse images with their native Rust tests, or
   reuses the matching published images, and publishes them before any Chronix profile tests. After
   every selected profile succeeds, it opens a PR on `release-<version>`. The PR contains
   `bakes/<profile>/release/clients.lock.json` with the Lighthouse upstream/baker versions, image
   tags and immutable digests, plus `.github/chronix-release.json` with the future Chronix Git tag
   and hashes of the selected client locks. Its description lists the client versions and digests.
   Failed builds or native tests do not open a release PR.
3. Review and merge that PR yourself. **Release merged Chronix PR** validates the merged client
   locks, creates the Git tag on the exact PR merge commit, and triggers **Publish Chronix images**.
   The tag does not point at a newer moving `main`. Chronix restores the pinned clients, runs its
   own full profile and packaged-service checks, then publishes both service images.

The `version` input chooses the tag that the PR will create. The Chronix image revision still comes
from the actual Git tag; the image publisher does not accept a free-form revision override.
Lighthouse tags still come from its upstream/baker identity independently of the Chronix version.

Client locks published before the rename to Chronix are rejected. Run **Publish Lighthouse images**
once before the first Chronix release.

For controller-only releases with unchanged clients, pushing a new Chronix Git tag still triggers
**Publish Chronix images** directly. Prereleases such as `v1.2.3-rc.1` are accepted; branch refs,
malformed versions and SemVer build metadata (`+...`) are rejected.

A retry reuses the same open PR when its generated files match. It never force-updates a branch,
changes a closed PR, or moves an existing tag. If the tag was created but dispatch failed, rerun
**Release merged Chronix PR**: it accepts that tag only at the same merge commit. If a Chronix run
already exists for that tag and commit, rerun its failed jobs instead of creating another release.
Artifacts can be overwritten within a workflow rerun, while published image identities remain
immutable. `clients:pin` remains available for manual recovery, but is not a normal release step.

One-time repository setup: enable **Settings → Actions → General → Workflow permissions → Allow
GitHub Actions to create and approve pull requests**. The workflow only creates the PR; it does not
approve or merge it. The workflow files must be present on the default branch. Repository rules must
permit the release workflow to create version tags. No additional PAT is required.

The PR commit uses GitHub's signed `createCommitOnBranch` API. The merge trigger explicitly
dispatches Chronix because a tag pushed using `GITHUB_TOKEN` does not trigger another workflow by
itself. GitHub documents
[workflow chaining](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
and [API commit signing](https://docs.github.com/en/graphql/reference/commits).

The first published client locks do not exist yet. They will be generated by the actual successful
amd64 publication; no placeholder digests are committed. A Chronix release requires a valid
committed lock for every maintained hardfork (currently only Gloas). A newly maintained profile
joins the dynamic matrix and the forms' options and receives its own lock in the release PR.

## Release already published clients

Use **Release Chronix from published images** (`.github/workflows/release.yml`) on `main` and enter
only the new Chronix `version`, for example `v0.2.0`. It opens the same release PR using the latest
published client lock for every registered profile. Merge the PR to trigger the existing tag and
Chronix publication workflows.

This separate action does not run Docker, `bake`, Rust compilation or the Lighthouse workflow. It
downloads only the selected lock JSON artifacts by their immutable artifact IDs. Lighthouse images
remain in GHCR; the Chronix publisher later restores them by digest. The existing build workflows
are unchanged.

Locks are selected by artifact creation time from completed **Publish Lighthouse images** runs on
the repository default branch. A run whose later PR job failed is eligible: its lock artifacts were
uploaded after successful client publication. Profiles can come from different runs. Artifacts from
other workflows, branches or fork repositories are excluded. The action summary links each selected
publication run and records the exact artifact ID; the PR lists the image digests.

If a required lock is missing or its latest retained artifact has expired, the action stops with an
error. It does not compile clients or silently use an older retained lock. Artifact retention is
separate from GHCR image retention. Existing release branches and occupied tags retain the same
protection as the original release flow.

## What each workflow verifies

The Lighthouse workflow runs the native Rust regressions as part of a new `bake`, then publishes the
compiled image and its immutable identity. Publication checks the native bake provenance,
upstream/baker identity, architecture and original source commit. A bake created with `--import-cl`
cannot be presented as a native Lighthouse release. The generated lock contains the original
immutable bake verbatim plus the published Lighthouse digest and build commit.

Full `test:profile` runs only in the Chronix release workflow. A published Lighthouse image
certifies the native build, not Chronix's protocol integration. If a later Chronix profile or
packaged-service check fails, Chronix publication is blocked and the Lighthouse image remains in
GHCR for reuse. Fixing the controller or its tests does not require compiling that unchanged
Lighthouse again.

The Chronix workflow validates that its ref is a release Git tag and that its client locks are
committed. `clients:restore` loads Lighthouse, genesis and the baseline client by digest and checks
the actual image IDs and architecture. Failed pulls do not install a bake manifest; an existing
conflicting local bake is preserved. Restoring clients has no compiler fallback. The original bake
identity and native provenance survive transport through the registry.

Chronix then runs the selected full profile suite on the default EL against the current controller,
packages the controller with the Lighthouse and genesis identities in `release.json`, and tests the
resulting service twice before publishing: with registry pulls and from saved client archives
without registry access. A new controller version therefore requires compatibility verification, but
does not require a new Lighthouse build. Each profile publishes independently after its own checks.

Both workflows serialize publication per profile/version. New publication requires confirmed absence
in the registry. Chronix rejects existing versions; Lighthouse reuses existing versions after
checking their digest and build identity. Administrators can still move tags outside these
workflows, so client locks and consumers use `@sha256:...`. Workflow artifacts retain verification
and published identities. The service's `/opt/chronix/release.json` records its Git version and
commit, original bake, architecture, client identities and published Lighthouse reference. OCI
labels expose the Chronix version, source commit, hardfork and bake key. The Lighthouse image also
has labels for upstream version/commit, baker version/hash, full build identity and the original
Chronix source commit used to build it. Reusing Lighthouse preserves that original build commit
instead of substituting the current controller's commit.

GHCR packages must permit the repository's token to pull them. Client restore supports private GHCR
images using `GITHUB_ACTOR` and `GHCR_TOKEN`; public images can be restored without credentials. The
service itself has no registry login: pulling Lighthouse at service startup needs the public
`ghcr.io/lidofinance/chronix-lighthouse-gloas` package.

## Use Chronix as a CI service

Start a fresh service for each test suite and pin its published image digest:

```yaml
env:
  CHRONIX_URL: http://127.0.0.1:18547
  CHRONIX_BEACON_URL: http://127.0.0.1:5052
services:
  chronix:
    image: ghcr.io/lidofinance/chronix-gloas@sha256:<published-digest>
    ports:
      - 127.0.0.1:18547:8545
      - 127.0.0.1:5052:5052
      - 127.0.0.1:5062:5062
    options: --privileged --stop-timeout 120 --label io.chronix.id=protocol-ci
```

Configure your test client to use these endpoints, wait for the service to become ready, then run
its normal test command. For private images, configure registry credentials in the consuming
workflow. The test client must not stop a service owned by the workflow.

Set the network with `CHRONIX_NETWORK`, one JSON object of the `NetworkOptions` type
(`client/types.d.ts`); `CHRONIX_GENESIS` alone sets only its `genesis` field. Invalid or unknown
options stop the service before its private Docker daemon starts:

```yaml
env:
  CHRONIX_NETWORK: >-
    {"chainId":32382,"genesisForkVersion":"0x10000038","history":"archive"}
  CHRONIX_ALLOWED_HOSTS: chronix
```

Ingress accepts only `Host` values `127.0.0.1` and `localhost`. Sibling containers on a Compose or
job network reach the service by name only when that name is listed in `CHRONIX_ALLOWED_HOSTS`
(comma-separated exact host names; ports, wildcards, `0.0.0.0` and `[::]` are rejected). The list is
a listener setting: it does not travel with snapshots.

Ethereum RPC, the Beacon API proxy and `/control` share port 8545. Native Beacon and validator APIs
are available on separate ports. Importing validator keys through Chronix uses the Lighthouse
keymanager; Lighthouse signs voluntary exits before submission to the Beacon API. Time advancement
is honest by default; request `{ mode: "fast" }` explicitly for scenarios that allow skipped duties.

## Client APIs and logs

Publish the ports needed by your test on loopback:

| Container port | API                                                          | Authentication                |
| -------------- | ------------------------------------------------------------ | ----------------------------- |
| 8545           | EL HTTP JSON-RPC, Chronix `/control`, Beacon HTTP proxy      | Controller Host/Origin checks |
| 5052           | Native Lighthouse Beacon API, including `/eth/v1/events` SSE | Native Beacon API             |
| 5062           | Native Lighthouse Validator / Keymanager API                 | Lighthouse bearer token       |

For a local service named `chronix`:

```sh
docker run -d --name chronix --privileged --stop-timeout 120 \
  -p 127.0.0.1:18547:8545 \
  -p 127.0.0.1:5052:5052 \
  -p 127.0.0.1:5062:5062 \
  ghcr.io/lidofinance/chronix-gloas@sha256:<published-digest>

curl --fail http://127.0.0.1:5052/eth/v1/beacon/headers/head
curl --no-buffer 'http://127.0.0.1:5052/eth/v1/events?topics=head'

CHRONIX_VC_TOKEN=$(docker exec chronix chronix validator-token)
curl --fail -H "Authorization: Bearer $CHRONIX_VC_TOKEN" \
  http://127.0.0.1:5062/eth/v1/keystores
```

Obtain the token after the service becomes healthy. It belongs to this fresh network and is not
printed in readiness logs. Port 5062 preserves Lighthouse authentication. After a fast warp replaces
VC, new connections use its new internal port; the token persists for that network. Clients should
reconnect if a request overlaps the restart. Use 5052 for long-lived Beacon event subscriptions; the
compatibility proxy on 8545 retains its bounded HTTP request timeout. Protocol clocks and the Engine
API remain private.

The outer service and its clients have separate logs. Use the bundled `chronix` command inside the
running service to read each client's stdout and stderr:

```sh
docker logs --tail 200 -f chronix                 # controller and private Docker daemon
docker exec chronix chronix logs el --tail 200     # EL (Reth by default)
docker exec chronix chronix logs cl --tail 200 -f  # Lighthouse beacon node
docker exec chronix chronix logs vc --tail all    # Lighthouse validator client
```

`logs` defaults to the last 300 lines; `--follow` / `-f` follows that client until it stops. Rerun
the command after VC is replaced by a fast warp. Each invocation selects the current client by the
service's exact `io.chronix.id` and role, without accessing the host Docker daemon. Save client logs
before stopping or removing the outer service. In GitHub Actions, use the actual service ID:

```yaml
- name: Save Chronix service and client logs
  if: always()
  env:
    SERVICE_ID: ${{ job.services.chronix.id }}
  run: |
    mkdir -p .local/chronix
    docker logs "$SERVICE_ID" > .local/chronix/service.log 2>&1
    for client in el cl vc; do
      docker exec "$SERVICE_ID" chronix logs "$client" --tail 2000 \
        > ".local/chronix/$client.log" 2>&1 || true
    done
```

Upload these files as workflow artifacts even when tests fail. A log collection error is retained in
the corresponding file when the service or client has already stopped.

## Retain or seed network state

Images built with snapshot support store active generations and snapshots under `/data`; the default
owner is `CHRONIX_ID=service`. Mount a dedicated volume with `-v chronix-data:/data` to retain state
when replacing the outer container. Keep the owner ID and exact compatible bake/platform unchanged.
Ordinary CI jobs can omit the mount and start fresh each time.

For a fresh volume, set `CHRONIX_SNAPSHOT` to a mounted file path or raw HTTPS archive URL. Optional
`CHRONIX_SNAPSHOT_SHA256` verifies the download. A retained active generation takes precedence over
its initial seed. Clean state resumes; unclean state requires explicit snapshot restoration.
Snapshot archives must match the service's exact bake and architecture. The archive carries its
network options, including `el`, `chainId`, `genesisForkVersion`, `history` and `genesis`; a seeded
service needs no `CHRONIX_NETWORK`, and an explicit one must equal the archive. The service loads
the archive's EL image like any client image.

See [snapshots](snapshots.md) for save/restore/export commands, operation recovery and local
examples. These behaviors require a release containing this feature; an older published `latest` is
unchanged until the new image is published.

## Client images and archives

The Chronix image contains Deno, the controller, the bake manifest, the EL catalog and
`release.json`; it contains no client images. Its private Docker daemon loads them at startup:
Lighthouse and genesis before the controller starts, the EL when the controller starts the network.
Beacon node and validator client use the same Lighthouse image. Each image is taken, in this order,
from the daemon by its pinned ID, from the archive `<hex>.tar.gz` in `/clients`
(`CHRONIX_CLIENTS_DIR`), or from its registry by digest: the EL digest from its catalog entry,
Lighthouse and genesis from `release.json.clients`. A missing image fails startup with its name. The
first start without archives pulls about 250 MB, so the image's `HEALTHCHECK` start period is 300
seconds. Startup never compiles clients. The service requires `--privileged`.

To start without registry access, save the archives once and mount them read-only. The service never
writes to `/clients`:

```sh
mkdir -p clients
docker run --rm --privileged --entrypoint docker-init -v "$PWD/clients:/clients" \
  ghcr.io/lidofinance/chronix-gloas@sha256:<published-digest> -- chronix clients save
docker run -d --name chronix --privileged --stop-timeout 120 -p 127.0.0.1:8545:8545 \
  -v "$PWD/clients:/clients:ro" \
  ghcr.io/lidofinance/chronix-gloas@sha256:<published-digest>
```

`chronix clients save [<el>]` starts its own private Docker daemon, pulls the EL (default
`reth-main-f4676ea`, or the EL `CHRONIX_EL` or `CHRONIX_NETWORK` selects), Lighthouse and genesis by
digest for the image's platform and writes each archive through a partial file and a rename. An
archive already present under its name is kept; a partial file left by an interrupted save
(untouched for a minute) is removed. An image without a registry digest, such as a locally packaged
Lighthouse, cannot be pulled: put its archive into the directory first. To run another EL, save it
by name and select it with `CHRONIX_NETWORK='{"el":"<name>"}'`.

## Packaging and runtime

The internal daemon uses a Unix socket and classic `overlay2` storage to preserve baked image IDs.
TCP relays listen on ports 8545, 5052 and 5062; bind host ports on loopback. Never mount the host
Docker socket. Controller Host/Origin checks and VC authentication still apply. All resources use
exact `io.chronix.id` ownership. SIGTERM closes API connections and preserves controlled Gloas
client data before stopping the private daemon. Allow sufficient stop time for clean database
persistence.

Fresh startup begins at block zero, slot zero and automine off. Restored networks become ready at
their saved slot. Health probes remain read-only while the suite controls time. Daemon failure stops
the service. Time control defaults to honest execution; skipped-slot jumps require explicit
`mode: "fast"`. Both modes use the same client image. Fast verifier scenarios do not certify
economics across the skipped interval. Full profile verification retains separate honest, fast and
economics scenarios.

Deno 2.9.7 is inside the service. Base images use digests, direct npm dependencies use exact
versions, and dependency caching uses `deno.lock` with `--frozen-lockfile`. Runtime uses
`--cached-only`.

For local packaging of an existing bake (no registry publication):

```sh
deno task package:image gloas chronix v0.0.0-local.1 lidofinance "$(git rev-parse HEAD)"
docker build -t chronix-ci-gloas:local \
  -f .cache/containers/gloas/v0.0.0-local.1/container/Dockerfile \
  .cache/containers/gloas/v0.0.0-local.1
deno task test:image chronix-ci-gloas:local gloas archives
```

`test:image <image> <profile> [registry|archives]` defaults to `registry`: the service pulls every
client image. `archives` first runs `chronix clients save` into a temporary directory, copies local
builds without a digest from `.cache/baker/images`, then runs the service with that directory
mounted read-only and its registry access blocked by a proxy on a closed port. A locally packaged
image has a Lighthouse without a registry digest, so it passes only in `archives` mode. Package
directories refuse reuse. Choose a new local version after changing packaged sources. Local
packaging accepts an existing native bake; published client locks require `linux/amd64`. ARM
packaging checks do not establish that the amd64 publication pipeline passed.

## Verification record

Native API relays and client log access passed five focused regressions and all 72 fast tests (13
Docker/profile opt-ins ignored), plus formatting, lint, types and workflow validation. Checks cover
bearer/header preservation, streaming responses, VC endpoint replacement, connection cleanup and
Docker log demultiplexing with exact ownership. These use local HTTP and Docker transport fixtures.
The packaged-service CI check now exercises real CL/VC APIs, rejected tokens, access after fast warp
and client log collection for each profile. That Docker check was not run locally, as requested. See
[the local evidence](../reports/ci/container-access/README.md).

Release-PR automation passed `deno task check`, all 67 fast tests (13 Docker/profile opt-ins
ignored), and `actionlint` for all three workflows. Seven focused regressions cover PR contents,
partial-failure recovery, immutable tags and the merge trigger. This is local verification with a
mock GitHub transport; an actual Actions publication remains unverified. See the
[release-PR evidence](../reports/ci/release-pr/README.md). The earlier records below describe the
previous pipeline stages.

For the split release pipelines, local verification is limited to unit tests, formatting, lint,
types and workflow validation. Docker tests and builds were not run, as requested. Unit coverage
checks Git-tag version selection, reuse of a client release across Chronix versions, rejection of
mutable/mismatched pins, failed restore behavior and Docker publication ownership using an in-memory
transport. Red/green evidence is under `.cache/ci-release-split-*.log`.

- `deno task check`: passed (formatting, lint and types).
- The split-pipeline unit run passed 39 checks, with 11 Docker/integration checks ignored. The newer
  upstream/baker identity checks are recorded separately below. The HTTP unit fixtures required
  permission to bind loopback; the initial sandbox-only attempt failed on those two fixtures, and
  the run with loopback access passed.
- `actionlint`: passed for both publisher workflows.
- The initial Git-tag regression run failed three assertions under the old manual revision behavior.
  After implementation all nine release/client unit checks passed.

The following results predate the split and are historical evidence only:

- Controller API regressions passed.
- ARM service checks passed for Pectra (23.46 seconds) and Gloas (20.45 seconds): genesis, read-only
  readiness, Host protection, transaction inclusion, pause and SIGTERM shutdown.
- A Gloas host run failed after its EL image was deleted during startup. The subsequent run in an
  isolated daemon passed all 8 scenarios in 536.2 seconds. The Pectra full run was interrupted; its
  report records failure, not a completed pass.

No GitHub amd64 workflow or GHCR publication has been executed. Current runtime changes require new
profile verification in CI; historical reports do not certify the new release.

The upstream/baker identity change has separate red/green evidence under
`.cache/ci-lighthouse-version-*.log` and `.cache/ci-lighthouse-identity-*.log`. Unit checks cover
both rebuild causes, reuse across Chronix/Geth changes, per-profile patch isolation, actual Cargo
version parsing, registry absence/error handling and rejection of mismatched published build labels.
Docker/compiler/profile execution remains unverified for this change and was not run locally.

Current results: `deno task check` passed; the unit command with Docker/e2e disabled passed 45
checks (11 ignored); `actionlint` passed both publisher workflows. The actual cached upstream Cargo
files matched the declared 7.1.0 and 8.2.2 versions. A read-only HTTP query confirmed that the
pinned Gloas Rust digest is a multi-platform index containing `linux/amd64`; no Docker daemon or
container was used for that query.
