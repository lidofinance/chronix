import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ensureImage, saveImage } from "../src/client_images.ts";
import { clientArchives } from "../src/config.ts";
import { dockerClient, Infrastructure } from "../src/docker.ts";
import type { BakedImage } from "../src/profiles.ts";

const id = (fill: string) => `sha256:${fill.repeat(64)}`;
const hex = (value: string) => value.slice("sha256:".length);
const digest = `example.test/client@sha256:${"d".repeat(64)}`;
const pinned = (value: string): BakedImage => ({
  ref: digest,
  id: value,
  digest,
  platform: "linux/amd64",
});
const local = (value: string): BakedImage => ({
  ref: "chronix-geth:p17-fix",
  id: value,
  platform: "linux/amd64",
});

/**
 * An in-memory Docker image store. A fixture archive's text names the image it holds and, for an
 * archive saved by reference, that reference; `docker load` reports either as Docker does. A
 * registry serves one platform of a digest, so a pull must ask for it.
 */
function daemon(
  present: string[] = [],
  registry: Record<string, { id: string; platform: string }> = {},
  save: (ref: string) => AsyncIterable<Uint8Array> = async function* () {},
) {
  const docker = dockerClient();
  const images = new Map(present.map((value) => [value, "linux/amd64"]));
  const refs = new Map<string, string>();
  const calls: string[] = [];
  const progress = (events: object[]) =>
    Readable.from(events.map((event) => JSON.stringify(event) + "\n"));
  const resolve = (ref: string) => images.has(ref) ? ref : refs.get(ref);
  docker.getImage = ((ref: string) => ({
    inspect: () => {
      const found = resolve(ref);
      if (!found || !images.has(found)) {
        return Promise.reject(Object.assign(new Error("No such image"), { statusCode: 404 }));
      }
      const [Os, Architecture] = images.get(found)!.split("/");
      return Promise.resolve({ Id: found, Os, Architecture });
    },
    remove: () => {
      calls.push(`remove ${ref}`);
      images.delete(resolve(ref) ?? ref);
      return Promise.resolve();
    },
    get: () => {
      calls.push(`save ${ref}`);
      return Promise.resolve(Readable.from(save(ref)));
    },
  })) as unknown as typeof docker.getImage;
  docker.listImages = (() =>
    Promise.resolve(
      [...images.keys()].map((Id) => ({ Id })),
    )) as unknown as typeof docker.listImages;
  docker.loadImage = (async (file: string | AsyncIterable<Uint8Array>) => {
    calls.push("load");
    const chunks: Uint8Array[] = [];
    if (typeof file === "string") chunks.push(await Deno.readFile(file));
    else for await (const chunk of file) chunks.push(chunk);
    const [loaded, reference] = Buffer.concat(chunks).toString().trim().split(" ");
    images.set(loaded, "linux/amd64");
    if (!reference) return progress([{ stream: `Loaded image ID: ${loaded}\n` }]);
    refs.set(reference, loaded);
    return progress([{ stream: `Loaded image: ${reference}\n` }]);
  }) as unknown as typeof docker.loadImage;
  docker.pull = ((ref: string, options?: { platform?: string }) => {
    calls.push(`pull ${ref}`);
    const published = registry[ref];
    if (!published) {
      return Promise.resolve(progress([{ errorDetail: { message: `manifest unknown: ${ref}` } }]));
    }
    if (options?.platform !== published.platform) {
      const message = `no matching manifest for ${options?.platform} in the manifest list`;
      return Promise.resolve(progress([{ errorDetail: { message } }]));
    }
    images.set(published.id, published.platform);
    refs.set(ref, published.id);
    return Promise.resolve(progress([{ status: "Downloaded newer image" }]));
  }) as unknown as typeof docker.pull;
  return { infra: new Infrastructure("image-loader", docker), images, refs, calls };
}

async function archives(content: Record<string, string> = {}): Promise<string> {
  const directory = await Deno.makeTempDir({ prefix: "chronix-archives-" });
  for (const [name, holds] of Object.entries(content)) {
    await Deno.writeTextFile(join(directory, `${hex(name)}.tar.gz`), holds);
  }
  return directory;
}
const entries = async (directory: string) =>
  (await Array.fromAsync(Deno.readDir(directory))).map((entry) => entry.name).sort();

Deno.test("the archive directory is an explicit setting with a host default", () => {
  const previous = Deno.env.get("CHRONIX_CLIENTS_DIR");
  try {
    Deno.env.delete("CHRONIX_CLIENTS_DIR");
    // Local Lighthouse builds without a registry digest are archived here by the baker.
    assert.equal(clientArchives(), ".cache/baker/images");
    Deno.env.set("CHRONIX_CLIENTS_DIR", "/clients");
    assert.equal(clientArchives(), "/clients");
  } finally {
    if (previous === undefined) Deno.env.delete("CHRONIX_CLIENTS_DIR");
    else Deno.env.set("CHRONIX_CLIENTS_DIR", previous);
  }
});

Deno.test("an image already in the daemon is used without archive or registry", async () => {
  const a = id("a");
  const directory = await archives({ [a]: a });
  try {
    const { infra, calls } = daemon([a], { [digest]: { id: a, platform: "linux/amd64" } });
    assert.equal(await ensureImage(infra, pinned(a), directory), a);
    assert.deepEqual(calls, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an archive is loaded and its image id verified; it wins over the registry", async () => {
  const a = id("a");
  const directory = await archives({ [a]: a });
  try {
    for (const image of [local(a), pinned(a)]) {
      const { infra, calls, images } = daemon([], { [digest]: { id: a, platform: "linux/amd64" } });
      assert.equal(await ensureImage(infra, image, directory), a);
      assert.deepEqual(calls, ["load"], image.ref);
      assert(images.has(a));
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an archive holding another image is refused and leaves the daemon as it was", async (t) => {
  const [a, b, c] = [id("a"), id("b"), id("c")];
  const directory = await archives({ [a]: b });
  try {
    for (const present of [[c], [b, c]]) {
      await t.step(
        present.includes(b) ? "the other image was present" : "a new image",
        async () => {
          const { infra, images } = daemon(present);
          await assert.rejects(ensureImage(infra, local(a), directory), (error: Error) => {
            assert.match(error.message, new RegExp(a));
            assert.match(error.message, new RegExp(`${hex(a)}\\.tar\\.gz`));
            return true;
          });
          assert.deepEqual([...images.keys()].sort(), present.sort());
        },
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a pinned image without an archive is pulled by digest for its platform and verified", async () => {
  const [a, b] = [id("a"), id("b")];
  const directory = await archives();
  try {
    const pulled = daemon([], { [digest]: { id: a, platform: "linux/amd64" } });
    assert.equal(await ensureImage(pulled.infra, pinned(a), directory), a);
    assert.deepEqual(pulled.calls, [`pull ${digest}`]);
    for (
      const published of [{ id: b, platform: "linux/amd64" }, { id: a, platform: "linux/arm64" }]
    ) {
      const { infra } = daemon([], { [digest]: published });
      await assert.rejects(
        ensureImage(infra, pinned(a), directory),
        /mismatch|no matching manifest/,
      );
    }
    assert.deepEqual(await entries(directory), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a digest that names a local image of another platform is still pulled for the pinned one", async () => {
  const [a, other] = [id("a"), id("e")];
  const directory = await archives();
  try {
    // The index digest was pulled before for the host platform; the pinned image is not here.
    const daemonState = daemon([], { [digest]: { id: a, platform: "linux/amd64" } });
    daemonState.images.set(other, "linux/arm64");
    daemonState.refs.set(digest, other);
    assert.equal(await ensureImage(daemonState.infra, pinned(a), directory), a);
    assert.deepEqual(daemonState.calls, [`pull ${digest}`]);
    assert.equal(daemonState.images.get(other), "linux/arm64", "the other platform was touched");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a local image without an archive is an error that names it and the archive directory", async () => {
  const a = id("a");
  const directory = await archives();
  try {
    const { infra, calls } = daemon();
    await assert.rejects(ensureImage(infra, local(a), directory), (error: Error) => {
      for (const part of ["chronix-geth:p17-fix", a, directory, "CHRONIX_CLIENTS_DIR"]) {
        assert(error.message.includes(part), `${part} missing from: ${error.message}`);
      }
      return true;
    });
    assert.deepEqual(calls, [], "an image without a digest has no registry to pull from");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a read-only archive directory is never written", async () => {
  const [a, b] = [id("a"), id("b")];
  const directory = await archives({ [a]: a });
  const before = await entries(directory);
  await Deno.chmod(directory, 0o555);
  try {
    const { infra } = daemon([], { [digest]: { id: b, platform: "linux/amd64" } });
    assert.equal(await ensureImage(infra, local(a), directory), a);
    assert.equal(await ensureImage(infra, pinned(b), directory), b);
    assert.deepEqual(await entries(directory), before);
  } finally {
    await Deno.chmod(directory, 0o755);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("clients save writes <id>.tar.gz through a partial file and a rename", async () => {
  const a = id("a");
  const directory = await archives();
  try {
    const parts: string[][] = [];
    const { infra } = daemon(
      [],
      { [digest]: { id: a, platform: "linux/amd64" } },
      async function* () {
        yield new TextEncoder().encode("saved ");
        // Mid-write the final name does not exist yet.
        parts.push(await entries(directory));
        yield new TextEncoder().encode("image");
      },
    );
    const path = await saveImage(infra, pinned(a), directory);
    assert.equal(path, join(directory, `${hex(a)}.tar.gz`));
    assert.equal(parts.length, 1);
    assert.equal(parts[0].length, 1);
    assert.notEqual(parts[0][0], `${hex(a)}.tar.gz`);
    assert.deepEqual(await entries(directory), [`${hex(a)}.tar.gz`]);
    const archive = await Deno.open(path);
    const bytes = await new Response(archive.readable.pipeThrough(new DecompressionStream("gzip")))
      .text();
    assert.equal(bytes, "saved image");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("clients save refuses an image without a registry digest and cleans a failed write", async () => {
  const a = id("a");
  const directory = await archives();
  try {
    const { infra, calls } = daemon([a]);
    await assert.rejects(saveImage(infra, local(a), directory), /chronix-geth:p17-fix.*digest/s);
    assert.deepEqual(calls, []);
    const failing = daemon(
      [],
      { [digest]: { id: a, platform: "linux/amd64" } },
      async function* () {
        yield new TextEncoder().encode("partial");
        throw new Error("daemon went away");
      },
    );
    await assert.rejects(saveImage(failing.infra, pinned(a), directory), /daemon went away/);
    assert.deepEqual(await entries(directory), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an archive saved by reference that holds another image is refused and removed", async () => {
  const [a, b] = [id("a"), id("b")];
  // `docker save repo:tag` archives report `Loaded image: repo:tag`, not the image id.
  const directory = await archives({ [a]: `${b} chronix-foreign:latest` });
  try {
    const { infra, images } = daemon();
    await assert.rejects(ensureImage(infra, local(a), directory), new RegExp(a));
    assert.deepEqual([...images.keys()], [], "the foreign image stayed loaded");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("clients save first removes partial archives an interrupted save left behind", async () => {
  const [a, b] = [id("a"), id("b")];
  const directory = await archives();
  try {
    // Left by an interrupted save two minutes ago; a live writer keeps touching its file.
    const interrupted = async (name: string) => {
      await Deno.writeTextFile(join(directory, name), "interrupted");
      const before = new Date(Date.now() - 120_000);
      await Deno.utime(join(directory, name), before, before);
    };
    await interrupted(`${hex(a)}.tar.gz.${crypto.randomUUID()}.partial`);
    await interrupted(`${hex(b)}.tar.gz.${crypto.randomUUID()}.partial`);
    // Files of the same suffix that no save writes belong to whoever chose this directory.
    const foreign = ["notes.partial", `${hex(b)}.tar.gz.x.partial`, `${hex(b)}.partial`];
    for (const name of foreign) await interrupted(name);
    const { infra } = daemon(
      [],
      { [digest]: { id: a, platform: "linux/amd64" } },
      async function* () {
        yield new TextEncoder().encode("saved image");
      },
    );
    await saveImage(infra, pinned(a), directory);
    assert.deepEqual(await entries(directory), [`${hex(a)}.tar.gz`, ...foreign].sort());
    // An archive that is already complete is kept; leftovers of other saves still go.
    await interrupted(`${hex(b)}.tar.gz.${crypto.randomUUID()}.partial`);
    await saveImage(infra, pinned(a), directory);
    assert.deepEqual(await entries(directory), [`${hex(a)}.tar.gz`, ...foreign].sort());
    // A partial file another save is writing right now is not touched.
    const writing = `${hex(b)}.tar.gz.${crypto.randomUUID()}.partial`;
    await Deno.writeTextFile(join(directory, writing), "writing");
    await saveImage(infra, pinned(a), directory);
    assert.deepEqual(
      await entries(directory),
      [`${hex(a)}.tar.gz`, ...foreign, writing].sort(),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
