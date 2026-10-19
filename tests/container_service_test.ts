import assert from "node:assert/strict";
import { clientImages, loadImages, savedEl, serviceSelection } from "../container/service.ts";
import { configuration } from "../src/config.ts";
import { Controller } from "../src/controller.ts";
import type { Infrastructure } from "../src/docker.ts";
import { elImage, readEl } from "../src/el_client.ts";
import { type BakedImage, readBake } from "../src/profiles.ts";
import type { releaseMetadata } from "../src/release.ts";
import { type ActiveGeneration, StateStore } from "../src/storage.ts";

const image = (role: string, fill: string): BakedImage => ({
  ref: `example.test/${role}@sha256:${fill.repeat(64)}`,
  id: `sha256:${fill.repeat(64)}`,
  digest: `example.test/${role}@sha256:${fill.repeat(64)}`,
  platform: "linux/amd64",
});
// The packaged release names the registry digests of its Lighthouse and genesis images.
const release = {
  platform: "linux/amd64",
  clients: {
    cl: image("cl", "a"),
    genesis: image("genesis", "b"),
    baseline: image("baseline", "c"),
  },
} as unknown as ReturnType<typeof releaseMetadata>;

Deno.test("the service preloads the release's Lighthouse and genesis through the loader, not the EL", async () => {
  // Both images are already present, so the loader only looks them up by id.
  const requested: string[] = [];
  const infra = {
    docker: {
      getImage: (ref: string) => ({
        inspect: () => {
          requested.push(ref);
          return Promise.resolve({ Id: ref });
        },
      }),
    },
  } as unknown as Infrastructure;
  await loadImages(infra, release, new AbortController().signal);
  assert.deepEqual(requested, [release.clients.cl.id, release.clients.genesis.id]);
  requested.length = 0;
  await assert.rejects(loadImages(infra, release, AbortSignal.abort()), /interrupted/);
  assert.deepEqual(requested, []);
});

Deno.test("clients save takes Lighthouse and genesis from the release and the EL from the catalog", () => {
  assert.deepEqual(clientImages(release, "reth-main-f4676ea"), {
    el: elImage(readEl("reth-main-f4676ea"), "linux/amd64"),
    cl: release.clients.cl,
    genesis: release.clients.genesis,
  });
  assert.deepEqual(
    clientImages(release, "geth-master-5d8fd6b").el,
    elImage(readEl("geth-master-5d8fd6b"), "linux/amd64"),
  );
  assert.throws(() => clientImages(release, "nethermind-main"), /Unknown EL/);
});

Deno.test("CHRONIX_EL is an explicit request of the packaged service, like the CLI's", async () => {
  const bake = await readBake("gloas", "snapshot-minimal-r1");
  const geth = "geth-master-5d8fd6b";
  const base = { id: "service", profile: "gloas" as const, bake: bake.tag };
  assert.deepEqual(serviceSelection(bake, "service", {}), base);
  assert.deepEqual(serviceSelection(bake, "service", {}, geth), { ...base, el: geth });
  assert.deepEqual(serviceSelection(bake, "service", { el: geth }), { ...base, el: geth });
  assert.throws(() => serviceSelection(bake, "service", { el: geth }, geth), /not both/);
  // Refused before the private Docker daemon starts.
  assert.throws(() => serviceSelection(bake, "service", {}, "nethermind-main"), /Unknown EL/);

  const original = {
    active: StateStore.prototype.active,
    fromSnapshot: Controller.fromSnapshot,
  };
  const seeded: unknown[] = [];
  let retained: ActiveGeneration | undefined;
  StateStore.prototype.active = () => Promise.resolve(retained);
  Controller.fromSnapshot = (_source, input) => {
    seeded.push(input);
    return Promise.resolve({} as Controller);
  };
  try {
    const selection = serviceSelection(bake, "service", {}, geth);
    retained = {
      phase: "stopped",
      config: configuration({ ...base, el: "reth-main-f4676ea" }),
    } as ActiveGeneration;
    await assert.rejects(Controller.launch(selection), /Explicit el differs from retained/);
    // A seed is checked against the requested EL when the snapshot is opened.
    retained = undefined;
    await Controller.launch(selection, { source: "https://example.org/seed.chronix.gz" });
    assert.deepEqual(seeded, [selection]);
  } finally {
    StateStore.prototype.active = original.active;
    Controller.fromSnapshot = original.fromSnapshot;
  }
});

Deno.test("clients save without an argument archives the EL the service would select", async () => {
  const bake = await readBake("gloas", "snapshot-minimal-r1");
  const [reth, geth] = ["reth-main-f4676ea", "geth-master-5d8fd6b"];
  assert.equal(savedEl(bake, undefined, { el: geth }), geth, "CHRONIX_NETWORK el was ignored");
  assert.equal(savedEl(bake, undefined, {}, geth), geth);
  assert.equal(savedEl(bake, reth, { el: geth }), reth, "the explicit argument names the archive");
  assert.throws(() => savedEl(bake, undefined, { el: geth }, reth), /not both/);
});
