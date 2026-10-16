import { validateClientBake } from "./client_release.ts";
import { assertLighthouseImage } from "./lighthouse_build.ts";
import { type Bake, canonical, type LighthouseBuild, type ProfileName } from "./profiles.ts";

/** Validate the compiled artifact and return its original build commit before publication. */
export function validateLighthousePublication(
  bake: Bake,
  build: LighthouseBuild,
  profile: ProfileName,
  info: Parameters<typeof assertLighthouseImage>[1],
): string {
  if (canonical(bake.lighthouse) !== canonical(build)) {
    throw new Error("Baked Lighthouse no longer matches the selected upstream/baker versions");
  }
  // bake runs native Rust tests before writing this artifact. Full network/profile verification
  // belongs to the Chronix release, after this expensive binary is safely in the registry.
  validateClientBake(bake, profile);
  assertLighthouseImage(build, info);
  const sourceCommit = info.Config.Labels?.["org.opencontainers.image.revision"];
  if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("Missing original Lighthouse build source commit");
  }
  return sourceCommit;
}
