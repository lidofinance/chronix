import { maintainedProfile, maintainedProfiles } from "../../../src/profiles.ts";

/** Direct lifecycle runs cover every maintained hardfork; profile CI selects exactly one. */
export function testProfiles(selected: string | undefined) {
  return selected === undefined ? [...maintainedProfiles] : [maintainedProfile(selected)];
}

/** Deno steps return false on failure; stop dependent stages before mutating a broken fixture. */
export async function step(t: Deno.TestContext, name: string, run: () => Promise<void>) {
  const passed = await t.step({
    name,
    fn: run,
    // The same real clients remain alive across the stages of one lifecycle.
    sanitizeOps: false,
    sanitizeResources: false,
  });
  if (!passed) throw new Error(`Stopped after failed step: ${name}`);
}
