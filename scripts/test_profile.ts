import { atomicJson, BuildLock } from "../src/artifacts.ts";
import { readBake } from "../src/profiles.ts";
import {
  currentEvidence,
  elIdentity,
  profileEnvironment,
  profileSelection,
  reportPath,
  scenariosFor,
  suiteHash,
} from "../src/verification.ts";
const selection = profileSelection(Deno.args);
const { profile, tag, el } = selection;
const bake = await readBake(profile, tag);
const identity = elIdentity(bake, el);
await using _lock = await BuildLock.acquire(`.cache/baker/locks/verify-${profile}-${tag}.lock`);
const runId = crypto.randomUUID();
const started = performance.now();
const fingerprint = await suiteHash(bake);
const scenarios = scenariosFor(bake);
const evidence = {
  profile,
  tag,
  ...identity,
  bakeKey: bake.key,
  runId,
  suiteHash: fingerprint,
  startedAt: new Date().toISOString(),
  scenarios,
};
const path = reportPath(profile, tag, el, "verification");
await atomicJson(path, { ...evidence, passed: false, status: "running" });
let error: string | undefined;
try {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["test", "--config=deno.json", "-A", "tests/e2e_test.ts"],
    env: profileEnvironment(selection, runId),
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
    const report = JSON.parse(await Deno.readTextFile(reportPath(profile, tag, el, scenario)));
    if (!currentEvidence(report, { runId, bakeKey: bake.key, ...identity })) {
      throw new Error(`Missing current ${scenario} evidence on ${el}`);
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
    ...identity,
    bakeKey: bake.key,
    suiteHash: fingerprint,
  }),
);
