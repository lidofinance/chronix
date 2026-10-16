import type { Devnet } from "../../../src/api.ts";
import { atomicJson } from "../../../src/artifacts.ts";
import type { ProfileName } from "../../../src/profiles.ts";
export async function report(net: Devnet, name: string, value: Record<string, unknown>) {
  const status = await net.status();
  await profileReport(status, name, value);
}
export async function profileReport(
  status: { profile: ProfileName; bake: string; bakeKey: string },
  name: string,
  value: Record<string, unknown>,
) {
  const result = {
    ...value,
    profile: status.profile,
    bake: status.bake,
    bakeKey: status.bakeKey,
    runId: Deno.env.get("CHRONIX_VERIFY_RUN"),
    recordedAt: new Date().toISOString(),
  };
  await atomicJson(`reports/profiles/${status.profile}/${status.bake}/${name}.json`, result);
  console.log(JSON.stringify(result));
}
