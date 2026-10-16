import { join } from "node:path";
import { atomicJson, BuildLock } from "./artifacts.ts";
import {
  type Bake,
  type BakedImage,
  bakePath,
  bakeTag,
  canonical,
  type ProfileName,
  profileName,
} from "./profiles.ts";
import { assertLighthouseRelease, type LighthouseRelease } from "./release.ts";

/** Publication adds transport references without rewriting the original immutable bake. */
export interface PublishedClients {
  schema: 1;
  bake: Bake;
  lighthouse: LighthouseRelease;
}
export const clientLockPath = (profile: ProfileName) =>
  `bakes/${profileName(profile)}/release/clients.lock.json`;

export function publishedImages(
  release: PublishedClients,
): Record<keyof Bake["images"], BakedImage> {
  return {
    ...release.bake.images,
    cl: { ...release.bake.images.cl, digest: release.lighthouse.digest },
  };
}

export function validateClientBake(bake: Bake, profile: ProfileName): void {
  if (
    bake.schema !== 1 || bake.profile !== profileName(profile) ||
    !bake.lighthouse || bake.tag !== bakeTag(bake.tag) ||
    bake.recipe.name !== profile || !/^[a-f0-9]{64}$/.test(bake.key) ||
    !/^[a-f0-9]{40}$/.test(bake.source.cl) || bake.source.importedCl
  ) throw new Error("Expected an original native Lighthouse bake for the selected profile");
  for (const role of ["cl", "el", "genesis", "baseline"] as const) {
    const image = bake.images[role];
    if (
      !image || !/^sha256:[a-f0-9]{64}$/.test(image.id) || image.platform !== "linux/amd64" ||
      (role !== "cl" &&
        (!image.digest || !/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image.digest)))
    ) {
      throw new Error(
        `Published ${role} requires a registry digest, image ID and linux/amd64 platform`,
      );
    }
  }
}
export function validatePublishedClients(release: PublishedClients, profile: ProfileName): void {
  if (release.schema !== 1) throw new Error("Unsupported published clients schema");
  validateClientBake(release.bake, profile);
  assertLighthouseRelease(release.bake, release.lighthouse);
}

export async function readPublishedClients(
  profile: ProfileName,
  root = ".",
): Promise<PublishedClients> {
  const path = join(root, clientLockPath(profile));
  let release: PublishedClients;
  try {
    release = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    throw new Error(
      `Missing published clients: ${path}. Run Publish Lighthouse images, then deno task clients:pin <clients.json>. Chronix release never compiles clients.`,
    );
  }
  validatePublishedClients(release, profile);
  return release;
}

export async function pinPublishedClients(release: PublishedClients, root = "."): Promise<string> {
  const profile = profileName(release.bake.profile);
  validatePublishedClients(release, profile);
  const path = join(root, clientLockPath(profile));
  await atomicJson(path, release);
  return path;
}

/** The caller pulls immutable registry refs and verifies each returned image ID/platform. */
export async function restorePublishedClients(
  release: PublishedClients,
  load: (image: BakedImage) => Promise<void>,
  root = ".",
): Promise<void> {
  validatePublishedClients(release, release.bake.profile);
  const bake = release.bake;
  await using _lock = await BuildLock.acquire(
    join(root, `.cache/baker/locks/${bake.profile}-${bake.tag}.lock`),
  );
  const path = join(root, bakePath(bake.profile, bake.tag));
  // Do not silently replace an existing local or legacy tag, even before pulling.
  for (const existing of [path, join(root, `bakes/${bake.profile}/${bake.tag}.json`)]) {
    try {
      if (canonical(JSON.parse(await Deno.readTextFile(existing))) !== canonical(bake)) {
        throw new Error(`Conflicting immutable bake: ${existing}`);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  for (const image of Object.values(publishedImages(release))) await load(image);
  await atomicJson(path, bake);
}
