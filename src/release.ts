import { type Bake, bakeTag, canonical, type LighthouseBuild, profileName } from "./profiles.ts";
import { lighthouseTag } from "./lighthouse_build.ts";

/** Repository paths the CI image is built from; recipes are added per profile. */
export const imageSources = [
  "src",
  "client",
  "clients",
  "container",
  "deno.json",
  "deno.lock",
  "LICENSE",
];

export function chronixRevision(ref: string): string {
  if (!ref.startsWith("refs/tags/")) throw new Error("Chronix releases require a Git tag vX.Y.Z");
  const version = ref.slice("refs/tags/".length);
  const number = "(?:0|[1-9][0-9]*)";
  const identifier = `(?:${number}|[0-9]*[a-zA-Z-][a-zA-Z0-9-]*)`;
  if (
    version.length > 128 ||
    !new RegExp(`^v${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`)
      .test(version)
  ) throw new Error("Use a Git tag vX.Y.Z or vX.Y.Z-rc.N, without build metadata");
  return version;
}
function registryOwner(owner: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(owner)) throw new Error("Invalid registry owner");
  return owner.toLowerCase();
}
export function releaseImage(owner: string, profile: string, revision: string): string {
  return `ghcr.io/${registryOwner(owner)}/chronix-${profileName(profile)}:${
    chronixRevision(`refs/tags/${revision}`)
  }`;
}
export function lighthouseImage(owner: string, profile: string, revision: string): string {
  if (
    !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9][a-z0-9.-]*)?-[a-f0-9]{12}-b[1-9][0-9]*-[a-f0-9]{12}$/
      .test(revision)
  ) {
    throw new Error("Use a Lighthouse upstream/commit/baker identity tag");
  }
  bakeTag(revision);
  return `ghcr.io/${registryOwner(owner)}/chronix-lighthouse-${profileName(profile)}:${revision}`;
}
export interface LighthouseRelease {
  image: string;
  digest: string;
  sourceCommit: string;
  build: LighthouseBuild;
}
export function assertLighthouseRelease(bake: Bake, release: LighthouseRelease): void {
  const match = /^ghcr\.io\/([^/]+)\/chronix-lighthouse-([^:]+):([^:]+)$/.exec(release.image);
  if (
    !bake.lighthouse || !release.build || canonical(bake.lighthouse) !== canonical(release.build) ||
    bake.source.cl !== release.build.upstream.commit ||
    bake.recipe.clVersion !== release.build.upstream.version ||
    bake.recipe.bakerVersion !== release.build.baker.version ||
    bake.images.cl.platform !== release.build.platform ||
    !match ||
    release.image !== lighthouseImage(match[1], bake.profile, lighthouseTag(release.build)) ||
    release.digest !== `${release.image.split(":")[0]}@${release.digest.split("@")[1]}` ||
    !/@sha256:[a-f0-9]{64}$/.test(release.digest) ||
    !/^[a-f0-9]{40}$/.test(release.sourceCommit)
  ) throw new Error("Published Lighthouse must match the bake profile/revision and pin its digest");
}
export function releaseMetadata(
  bake: Bake,
  image: string,
  commit: string,
  lighthouse?: LighthouseRelease,
) {
  const match = /^ghcr\.io\/([^/]+)\/chronix-([^:]+):([^:]+)$/.exec(image);
  if (!match || match[2] !== bake.profile || image !== releaseImage(match[1], match[2], match[3])) {
    throw new Error("Release image must match the selected bake profile");
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a full source commit");
  const { cl, genesis, baseline } = bake.images;
  if (new Set([cl, genesis, baseline].map((image) => image.platform)).size !== 1) {
    throw new Error("Client architectures differ");
  }
  if (lighthouse) assertLighthouseRelease(bake, lighthouse);
  return {
    schema: 1 as const,
    image,
    profile: bake.profile,
    revision: match[3],
    sourceCommit: commit,
    bake: bake.tag,
    bakeKey: bake.key,
    platform: cl.platform,
    clients: { cl: lighthouse ? { ...cl, digest: lighthouse.digest } : cl, genesis, baseline },
    ...(lighthouse ? { lighthouse } : {}),
  };
}
export function assertMissingRevision(status: number): void {
  if (status !== 404) throw new Error(`Registry did not confirm absence: HTTP ${status}`);
}
