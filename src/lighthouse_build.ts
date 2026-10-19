import { join } from "node:path";
import { bakeTag, canonical, type LighthouseBuild, type Recipe, sha256 } from "./profiles.ts";

// Only code/dependencies used by the builder, not the Chronix HTTP controller or release version.
const buildFiles = [
  "src/baker.ts",
  "src/lighthouse_build.ts",
  "src/profiles.ts",
  "src/docker.ts",
  "src/artifacts.ts",
  "scripts/bake.ts",
  "deno.json",
  "deno.lock",
];
const upstreamVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9][a-z0-9.-]*)?$/;
const pinnedImage = /(?:^|@)sha256:[a-f0-9]{64}$/;

/** The CLI package has a direct version in older Lighthouse trees and inherits it in newer ones. */
export function lighthouseSourceVersion(cliCargo: string, workspaceCargo: string): string {
  const section = (text: string, name: string) =>
    text.split(`[${name}]`)[1]?.split(/^\[/m)[0] ?? "";
  const cli = section(cliCargo, "package");
  const inherited = /^version\s*=\s*\{\s*workspace\s*=\s*true\s*\}|^version\.workspace\s*=\s*true/m
    .test(cli);
  const version = /^version\s*=\s*"([^"]+)"/m.exec(
    inherited ? section(workspaceCargo, "workspace.package") : cli,
  )?.[1];
  if (!version || !upstreamVersion.test(version)) {
    throw new Error("Cannot determine the upstream Lighthouse package version");
  }
  return version;
}

export function lighthouseTag(build: LighthouseBuild): string {
  if (
    !upstreamVersion.test(build.upstream.version) ||
    !/^[a-f0-9]{40}$/.test(build.upstream.commit) ||
    !Number.isSafeInteger(build.baker.version) || build.baker.version < 1 ||
    !/^[a-f0-9]{64}$/.test(build.baker.hash)
  ) throw new Error("Invalid Lighthouse upstream/baker versions");
  return bakeTag(
    `v${build.upstream.version}-${build.upstream.commit.slice(0, 12)}-b${build.baker.version}-${
      build.baker.hash.slice(0, 12)
    }`,
  );
}

export function assertLighthouseImage(build: LighthouseBuild, info: {
  Os: string;
  Architecture: string;
  Config: { Labels?: Record<string, string> };
}): void {
  if (
    canonical(JSON.parse(info.Config.Labels?.["io.chronix.lighthouse.build"] ?? "null")) !==
      canonical(build) ||
    `${info.Os}/${info.Architecture}` !== build.platform
  ) throw new Error("Published Lighthouse upstream/baker identity mismatch");
}

/** A complete CL/genesis selection has its own tag, independent of the Lighthouse image tag. */
export async function clientBakeTag(recipe: Recipe, build: LighthouseBuild): Promise<string> {
  return `ci-${(await sha256(canonical({ recipe, lighthouse: build.key }))).slice(0, 40)}`;
}

export async function lighthouseBuild(
  recipe: Recipe,
  platform: string,
  root = ".",
): Promise<LighthouseBuild> {
  if (!pinnedImage.test(recipe.rust) || !pinnedImage.test(recipe.runtime)) {
    throw new Error("Lighthouse build identity requires pinned Rust and runtime images");
  }
  const hashes: Record<string, string> = {};
  for (
    const path of [
      ...buildFiles,
      recipe.patch,
      recipe.clockSource,
      recipe.clockTest,
      ...recipe.sourceFiles ?? [],
    ]
  ) {
    hashes[path] = await sha256(await Deno.readFile(join(root, path)));
  }
  const identity = {
    upstream: {
      version: recipe.clVersion ?? "",
      commit: recipe.clRef,
      repository: recipe.clRepository,
    },
    baker: {
      version: recipe.bakerVersion ?? 0,
      hash: await sha256(canonical({
        schema: 1,
        version: recipe.bakerVersion,
        platform,
        repository: recipe.clRepository,
        hashes,
        rust: recipe.rust,
        runtime: recipe.runtime,
        clockEnvPrefix: recipe.clockEnvPrefix,
        nativeTests: recipe.nativeTests ?? [],
      })),
    },
    platform,
  };
  const result = { ...identity, key: await sha256(canonical(identity)) };
  lighthouseTag(result);
  return result;
}
