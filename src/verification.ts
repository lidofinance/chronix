import { dirname, join, normalize } from "node:path";
import { argumentsFor } from "./arguments.ts";
import { defaultEl } from "./config.ts";
import { elImage, elName, readEl } from "./el_client.ts";
import {
  type Bake,
  bakeTag,
  canonical,
  maintainedProfile,
  type ProfileName,
  profileName,
  profiles,
  sha256,
} from "./profiles.ts";

export function scenariosFor(bake: Pick<Bake, "profile">): string[] {
  return Object.keys(profiles[bake.profile].tests);
}

/** Fingerprint only this profile's runtime and executable suite. Client source
 * changes belong to a new bake key and do not invalidate an existing binary. */
export async function suiteHash(bake: Pick<Bake, "profile">, root = "."): Promise<string> {
  const files: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    path = normalize(path);
    if (Object.hasOwn(files, path)) return;
    const source = await Deno.readTextFile(join(root, path));
    files[path] = await sha256(source);
    // All local modules use literal relative imports; include dynamic literal imports too.
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      const dependency = normalize(join(dirname(path), match[1]));
      // Recipes pin future builds. Only consumed runtime defaults are relevant below.
      if (/^bakes\/[^/]+\/recipe\.json$/.test(dependency)) continue;
      await visit(dependency);
    }
  }
  const recipe = JSON.parse(
    await Deno.readTextFile(join(root, `bakes/${bake.profile}/recipe.json`)),
  );
  const tests: Record<string, string> = recipe.tests;
  const scenarios = Object.keys(tests);
  for (
    const path of [
      "scripts/test_profile.ts",
      "tests/e2e_test.ts",
      "src/cli.ts",
      "src/controller.ts",
      "src/verification.ts",
      "deno.json",
      "deno.lock",
      ...Object.values(tests),
      ...(scenarios.includes("e2e") ? ["bakes/shared/tests/indexer.ts"] : []),
    ]
  ) await visit(path);
  return await sha256(canonical({
    version: 3,
    profile: bake.profile,
    scenarios,
    tests,
    defaults: { churnLimitQuotient: recipe.churnLimitQuotient },
    files,
  }));
}

/** Profile evidence belongs to a bake tag and the EL it ran on. */
export function reportPath(profile: ProfileName, tag: string, el: string, name: string): string {
  return `reports/profiles/${profileName(profile)}/${bakeTag(tag)}/${elName(el)}/${name}.json`;
}

/** The EL a report is bound to beside the bake key: its catalog name and image at the platform. */
export function elIdentity(
  bake: Pick<Bake, "images">,
  el: string,
): { el: string; elImage: string } {
  return { el, elImage: elImage(readEl(el), bake.images.cl.platform).id };
}

/** A scenario report is evidence only for its own run, bake and EL. */
export function currentEvidence(
  report: Record<string, unknown>,
  expected: { runId: string; bakeKey: string; el: string; elImage: string },
): boolean {
  return (Object.keys(expected) as (keyof typeof expected)[]).every((key) =>
    report[key] === expected[key]
  );
}

/** `deno task test:profile <hardfork> [--bake <tag>] [--el <name>]`; the harness picks the EL. */
export function profileSelection(
  args: string[],
): { profile: ProfileName; tag: string; el: string } {
  const { flags, positional } = argumentsFor(args, ["bake", "el"]);
  if (positional.length !== 1) {
    throw new Error("Usage: deno task test:profile <hardfork> [--bake <tag>] [--el <name>]");
  }
  const el = flags.el ?? defaultEl;
  readEl(el);
  return { profile: maintainedProfile(positional[0]), tag: bakeTag(flags.bake ?? "default"), el };
}

/** The scenarios take the selection from the environment, through `configuration()`. */
export function profileEnvironment(
  selection: { profile: ProfileName; tag: string; el: string },
  runId: string,
): Record<string, string> {
  return {
    CHRONIX_E2E: "1",
    CHRONIX_PROFILE: selection.profile,
    CHRONIX_BAKE: selection.tag,
    CHRONIX_EL: selection.el,
    CHRONIX_VERIFY_RUN: runId,
  };
}

/** A passed verification of this bake on this EL, and whether it covers the current suite. */
export async function verificationStatus(
  bake: Bake,
  el: string,
  root = ".",
): Promise<{ verified: boolean; verifiedAt?: string }> {
  let report;
  try {
    report = JSON.parse(
      await Deno.readTextFile(join(root, reportPath(bake.profile, bake.tag, el, "verification"))),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { verified: false };
    throw error;
  }
  const identity = elIdentity(bake, el);
  if (
    !report.passed || report.bakeKey !== bake.key || report.el !== identity.el ||
    report.elImage !== identity.elImage
  ) return { verified: false };
  return {
    verified: report.suiteHash === await suiteHash(bake, root),
    verifiedAt: report.finishedAt,
  };
}
