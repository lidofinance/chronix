import { join, resolve } from "node:path";
import { atomicJson, requireImage } from "../src/artifacts.ts";
import { Infrastructure } from "../src/docker.ts";
import { publishedImages, readPublishedClients } from "../src/client_release.ts";
import { maintainedProfile, profiles, readBake } from "../src/profiles.ts";
import { imageSources, releaseImage, releaseMetadata } from "../src/release.ts";

const [name, tag, revision, owner, commit] = Deno.args;
if (Deno.args.length !== 5) {
  throw new Error(
    "Usage: package_image.ts <profile> <bake|--published> <vX.Y.Z> <owner> <source-commit>",
  );
}
const profile = maintainedProfile(name);
const published = tag === "--published" ? await readPublishedClients(profile) : undefined;
const bake = published?.bake ?? await readBake(profile, tag);
const metadata = releaseMetadata(
  bake,
  releaseImage(owner, name, revision),
  commit,
  published?.lighthouse,
);
const directory = resolve(`.cache/containers/${name}/${revision}`);
// createNew semantics prevent silently reusing stale package files from another bake.
await Deno.mkdir(directory, { recursive: true });
using lock = await Deno.open(join(directory, ".packaging"), { createNew: true, write: true });
await lock.write(new TextEncoder().encode(JSON.stringify(metadata)));
async function copy(source: string, destination: string): Promise<void> {
  const stat = await Deno.stat(source);
  if (stat.isDirectory) {
    await Deno.mkdir(destination, { recursive: true });
    for await (const entry of Deno.readDir(source)) {
      await copy(join(source, entry.name), join(destination, entry.name));
    }
  } else {
    await Deno.copyFile(source, destination);
  }
}
for (const path of imageSources) {
  await copy(path, join(directory, path));
}
// profiles.ts imports every registered recipe, but only this bake's artifacts are shipped.
for (const name of Object.keys(profiles)) {
  await Deno.mkdir(join(directory, "bakes", name), { recursive: true });
  await copy(
    `bakes/${name}/recipe.json`,
    join(directory, "bakes", name, "recipe.json"),
  );
}
await atomicJson(join(directory, `bakes/${name}/tags/${bake.tag}.json`), bake);
await atomicJson(join(directory, "release.json"), metadata);
const infra = new Infrastructure(`package-${name}`);
const archiveDirectory = join(directory, ".cache/baker/images");
await Deno.mkdir(archiveDirectory, { recursive: true });
for (const role of ["el", "cl", "genesis"] as const) {
  const image = (published ? publishedImages(published) : bake.images)[role];
  await requireImage(infra, image);
  await infra.cacheImage(image.id);
  const filename = `${image.id.slice(7)}.tar.gz`;
  await Deno.copyFile(`.cache/baker/images/${filename}`, join(archiveDirectory, filename));
}
console.log(JSON.stringify({ event: "image-context-ready", directory, ...metadata }));
