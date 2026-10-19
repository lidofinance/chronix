import type { Devnet } from "../../../src/api.ts";
import { atomicJson } from "../../../src/artifacts.ts";
import { configuration } from "../../../src/config.ts";
import { type ProfileName, readBake } from "../../../src/profiles.ts";
import { elIdentity, reportPath } from "../../../src/verification.ts";
export async function report(net: Devnet, name: string, value: Record<string, unknown>) {
  const status = await net.status();
  // The EL of the network that ran, not the harness setting.
  await profileReport(status, name, value, (await net.lifecycle()).el);
}
/** Without a running network, the EL is the one the harness selected (`CHRONIX_EL`). */
export async function profileReport(
  status: { profile: ProfileName; bake: string; bakeKey: string },
  name: string,
  value: Record<string, unknown>,
  el = configuration().el,
) {
  const result = {
    ...value,
    profile: status.profile,
    bake: status.bake,
    bakeKey: status.bakeKey,
    ...elIdentity(await readBake(status.profile, status.bake), el),
    runId: Deno.env.get("CHRONIX_VERIFY_RUN"),
    recordedAt: new Date().toISOString(),
  };
  await atomicJson(reportPath(status.profile, status.bake, el, name), result);
  console.log(JSON.stringify(result));
}
