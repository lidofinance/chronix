import { argumentsFor } from "../src/arguments.ts";
import { atomicJson, BuildLock } from "../src/artifacts.ts";
import { maintainedProfile, readBake } from "../src/profiles.ts";
import { scenariosFor, suiteHash } from "../src/verification.ts";
const { flags, positional } = argumentsFor(Deno.args, ["bake"]);
if (positional.length !== 1) {
  throw new Error("Usage: deno task test:profile <hardfork> [--bake <tag>]");
}
const profile = maintainedProfile(positional[0]);
const tag = flags.bake ?? "default";
const bake = await readBake(profile, tag);
await using _lock = await BuildLock.acquire(`.cache/baker/locks/verify-${profile}-${tag}.lock`);
const runId = crypto.randomUUID();
const started = performance.now();
const fingerprint = await suiteHash(bake);
const scenarios = scenariosFor(bake);
const evidence = {
  profile,
  tag,
  bakeKey: bake.key,
  runId,
  suiteHash: fingerprint,
  startedAt: new Date().toISOString(),
  scenarios,
};
const path = `reports/profiles/${profile}/${tag}/verification.json`;
await atomicJson(path, { ...evidence, passed: false, status: "running" });
let error: string | undefined;
try {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["test", "--config=deno.json", "-A", "tests/e2e_test.ts"],
    env: {
      PANDA_E2E: "1",
      PANDA_PROFILE: profile,
      PANDA_BAKE: tag,
      PANDA_VERIFY_RUN: runId,
    },
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`Test process exited ${result.code}`);
  if ((await readBake(profile, tag)).key !== bake.key) {
    throw new Error("Bake changed during verification");
  }
  if (await suiteHash(bake) !== fingerprint) {
    throw new Error("Suite sources changed during verification; rerun against the current tree");
  }
  for (const scenario of scenarios) {
    const report = JSON.parse(
      await Deno.readTextFile(`reports/profiles/${profile}/${tag}/${scenario}.json`),
    );
    if (report.runId !== runId || report.bakeKey !== bake.key) {
      throw new Error(`Missing current ${scenario} evidence`);
    }
  }
} catch (cause) {
  error = String(cause);
}
await atomicJson(path, {
  ...evidence,
  finishedAt: new Date().toISOString(),
  elapsedMs: performance.now() - started,
  passed: !error,
  status: error ? "failed" : "passed",
  error,
});
if (error) throw new Error(error);
console.log(
  JSON.stringify({
    event: "profile-verified",
    profile,
    tag,
    bakeKey: bake.key,
    suiteHash: fingerprint,
  }),
);
