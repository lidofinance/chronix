import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { clientArchives } from "./config.ts";
import { archiveName, type Infrastructure, missing } from "./docker.ts";
import type { BakedImage } from "./profiles.ts";

// Runtime client images only. This module is not a Lighthouse build input (lighthouse_build.ts).

/**
 * The one way client images reach the daemon: an image with this id is used as is; otherwise
 * its archive `<hex>.tar.gz` in `directory` is loaded; otherwise a registry image is pulled by
 * digest. Each result is verified by id, and nothing is written into `directory`.
 */
export async function ensureImage(
  infra: Infrastructure,
  image: BakedImage,
  directory = clientArchives(),
): Promise<string> {
  if (await inspected(infra, image.id)) return image.id;
  const path = join(directory, archiveName(image.id));
  if (await infra.loadArchive(path, image.id)) return image.id;
  if (image.digest) {
    await pull(infra, image, image.digest);
    return image.id;
  }
  throw new Error(
    `Client image ${image.ref} (${image.id}) has no registry digest and no archive ${path}; ` +
      `put its archive into the directory set by CHRONIX_CLIENTS_DIR (${directory})`,
  );
}

async function inspected(infra: Infrastructure, id: string) {
  try {
    return await infra.docker.getImage(id).inspect();
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

/**
 * Pull a pinned image by digest for its platform and verify it by id. Only the id proves the image
 * is present: the digest of a multi-platform index can name a local image of another platform.
 */
async function pull(infra: Infrastructure, image: BakedImage, digest: string): Promise<void> {
  if (!/@sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Registry restore requires an immutable digest");
  }
  await infra.progress(await infra.docker.pull(digest, { platform: image.platform }));
  const found = await inspected(infra, image.id);
  if (!found || `${found.Os}/${found.Architecture}` !== image.platform) {
    throw new Error(`Published image identity/platform mismatch: ${digest}`);
  }
}

/** Leftovers of an interrupted save: `<hex>.tar.gz.<uuid>.partial`, exactly as a save names them. */
const partialArchive =
  /^[a-f0-9]{64}\.tar\.gz\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial$/;

/**
 * Write a registry image as `<hex>.tar.gz` into `directory`; only `clients save` does this. An
 * archive named by the id is already this image, including one supplied for a local build.
 */
export async function saveImage(
  infra: Infrastructure,
  image: BakedImage,
  directory = clientArchives(),
): Promise<string> {
  // A live save streams into its partial file without pause; one untouched for a minute before
  // this save started was left by an interrupted save.
  const stale = Date.now() - 60_000;
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile || !partialArchive.test(entry.name)) continue;
    const partial = join(directory, entry.name);
    if (((await Deno.stat(partial)).mtime?.getTime() ?? stale) < stale) await Deno.remove(partial);
  }
  const path = join(directory, archiveName(image.id));
  try {
    await Deno.stat(path);
    return path;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (!image.digest) {
    throw new Error(
      `Only registry images can be saved; ${image.ref} has no registry digest: supply ${path}`,
    );
  }
  if (!await inspected(infra, image.id)) await pull(infra, image, image.digest);
  // Readers never see a partial archive under its final name.
  const partial = `${path}.${crypto.randomUUID()}.partial`;
  try {
    await Deno.writeFile(partial, new Uint8Array(), { createNew: true });
    await pipeline(
      await infra.docker.getImage(image.id).get(),
      createGzip(),
      createWriteStream(partial),
    );
    await Deno.rename(partial, path);
  } finally {
    await Deno.remove(partial).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
  return path;
}
