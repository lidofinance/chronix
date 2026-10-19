import assert from "node:assert/strict";
import { ensureImage, saveImage } from "../src/client_images.ts";
import { join } from "node:path";
import { configuration } from "../src/config.ts";
import { Infrastructure, LABEL } from "../src/docker.ts";
import { waitFor } from "../src/http.ts";
import { Network } from "../src/network.ts";
import type { BakedImage } from "../src/profiles.ts";

Deno.test({
  name: "partial startup rollback preserves another stand and is repeatable",
  ignore: Deno.env.get("CHRONIX_DOCKER_TEST") !== "1",
  fn: async () => {
    const id = `rollback-${crypto.randomUUID().slice(0, 8)}`;
    const infra = new Infrastructure(id);
    const foreign = new Infrastructure(`other-${crypto.randomUUID().slice(0, 8)}`);
    const collision = `chronix-${id}`;
    assert.deepEqual(infra.labels, { "io.chronix.id": id });
    await foreign.docker.createNetwork({
      Name: collision,
      Labels: foreign.labels,
      Driver: "bridge",
    });
    try {
      const network = new Network(configuration({ id }));
      await assert.rejects(network.start(), /already exists/);
      // A failed fresh start must not leave a generation that forces recovery.
      assert.equal(await network.store.active(), undefined);
      await infra.cleanup();
      await infra.cleanup();
      assert.equal(
        (await infra.docker.listNetworks({ filters: { label: [`${LABEL}=${id}`] } })).length,
        0,
      );
      assert.equal(
        (await infra.docker.listVolumes({ filters: { label: [`${LABEL}=${id}`] } })).Volumes
          ?.length ?? 0,
        0,
      );
      assert.equal(
        (await foreign.docker.getNetwork(collision).inspect()).Labels![LABEL],
        foreign.id,
      );
    } finally {
      await infra.cleanup();
      await foreign.cleanup();
    }
  },
});

Deno.test({
  name: "Chronix resources are named and labeled consistently; cleanup preserves another owner",
  ignore: Deno.env.get("CHRONIX_DOCKER_TEST") !== "1",
  fn: async () => {
    const infra = new Infrastructure(`names-${crypto.randomUUID().slice(0, 8)}`);
    const other = new Infrastructure(`${infra.id}-other`);
    try {
      const otherVolume = await other.volume("data");
      const network = await infra.network();
      const volume = await infra.volume("data");
      await infra.image("alpine:3.21.3");
      const container = await infra.container("probe", {
        Image: "alpine:3.21.3",
        Cmd: ["true"],
        HostConfig: { NetworkMode: network, Binds: [`${volume}:/data`] },
      });
      const info = await container.inspect();
      assert.equal(info.Name, `/chronix-${infra.id}-probe`);
      assert.equal(info.Config.Labels?.["io.chronix.id"], infra.id);
      assert.equal(info.Config.Labels?.["io.chronix.role"], "probe");
      assert.equal((await infra.docker.getNetwork(network).inspect()).Name, `chronix-${infra.id}`);
      assert.equal(volume, `chronix-${infra.id}-data`);
      await infra.cleanup();
      await infra.cleanup();
      assert.equal(
        (await other.docker.getVolume(otherVolume).inspect()).Labels["io.chronix.id"],
        other.id,
      );
    } finally {
      await infra.cleanup();
      await other.cleanup();
    }
  },
});

Deno.test({
  name: "client images come from a registry by digest, or from an archive with the registry down",
  ignore: Deno.env.get("CHRONIX_DOCKER_TEST") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const infra = new Infrastructure(`loader-${crypto.randomUUID().slice(0, 8)}`);
    const context = await Deno.makeTempDir();
    const archives = await Deno.makeTempDir();
    const registryImage =
      "registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
    let id: string | undefined;
    const removeOwnedImage = async () => {
      if (!id) return;
      let info;
      try {
        info = await infra.docker.getImage(id).inspect();
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return;
        throw error;
      }
      assert.equal(info.Config.Labels?.[LABEL], infra.id);
      await infra.docker.getImage(id).remove({ force: true });
    };
    try {
      // A tiny local image: nothing to download.
      await Deno.writeTextFile(`${context}/Dockerfile`, "FROM scratch\nCOPY stamp /stamp\n");
      await Deno.writeTextFile(`${context}/stamp`, crypto.randomUUID());
      await infra.progress(
        await infra.docker.buildImage({ context, src: ["Dockerfile", "stamp"] }, {
          t: `chronix-loader-test:${infra.id}`,
          labels: infra.labels,
        }),
      );
      const built = await infra.docker.getImage(`chronix-loader-test:${infra.id}`).inspect();
      id = built.Id;
      await infra.image(registryImage);
      // The daemon pushes and pulls, and Docker Desktop's daemon runs in a VM that cannot reach a
      // port published on the host loopback. On the daemon's own network the registry is local.
      const port = 20_000 + Math.floor(Math.random() * 40_000);
      const registry = await infra.container("registry", {
        Image: registryImage,
        Env: [`REGISTRY_HTTP_ADDR=127.0.0.1:${port}`],
        HostConfig: { NetworkMode: "host" },
      });
      await registry.start();
      const digest = await waitFor(
        "push to the local registry",
        () =>
          infra.publishImage(id!, `localhost:${port}/chronix-loader-test:${infra.id}`, {})
            .catch(() => undefined),
        30_000,
      );
      const image: BakedImage = {
        ref: digest,
        id,
        digest,
        platform: `${built.Os}/${built.Architecture}`,
      };
      await removeOwnedImage();
      assert.equal(await ensureImage(infra, image, archives), id);
      assert.deepEqual(await Array.fromAsync(Deno.readDir(archives)), [], "the loader wrote");
      const path = await saveImage(infra, image, archives);
      assert.equal(path, join(archives, `${id.slice(7)}.tar.gz`));
      await registry.stop({ t: 1 });
      await removeOwnedImage();
      assert.equal(await ensureImage(infra, image, archives), id, "archive load");
      // An archive under another image's name is refused and its image is not left loaded.
      await removeOwnedImage();
      const other = `sha256:${"0".repeat(64)}`;
      await Deno.rename(path, join(archives, `${other.slice(7)}.tar.gz`));
      await assert.rejects(
        ensureImage(infra, {
          ref: "chronix-loader-test:other",
          id: other,
          platform: image.platform,
        }, archives),
        new RegExp(other),
      );
      await assert.rejects(
        infra.docker.getImage(id).inspect(),
        (error: { statusCode?: number }) => error.statusCode === 404,
      );
    } finally {
      await removeOwnedImage();
      await infra.cleanup("network");
      await Deno.remove(context, { recursive: true });
      await Deno.remove(archives, { recursive: true });
    }
  },
});
