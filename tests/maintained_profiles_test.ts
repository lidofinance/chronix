import assert from "node:assert/strict";
import { maintainedProfiles } from "../src/profiles.ts";
import { testProfiles } from "../bakes/shared/tests/test_steps.ts";

// Every entry fails before side effects even without the guard: an invalid tag, a missing bake or
// an unreachable Docker socket. Only the profile guard may explain the refusal.
const commands: [string, string[]][] = [
  ["scripts/bake.ts", ["pectra", "--tag", "INVALID TAG"]],
  ["scripts/test_profile.ts", ["pectra", "--bake", "missing-maintained-check"]],
  ["scripts/test_clock.ts", ["pectra", "--bake", "missing-maintained-check"]],
  ["scripts/package_image.ts", [
    "pectra",
    "missing-maintained-check",
    "v9.9.9",
    "o",
    "0".repeat(40),
  ]],
  ["scripts/test_image.ts", ["example.invalid/chronix:missing", "pectra"]],
  ["scripts/clients.ts", ["check", "pectra"]],
];

for (const [script, args] of commands) {
  Deno.test(`${script} refuses to build, test or package the historical Pectra profile`, async () => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", script, ...args],
      env: { CHRONIX_DOCKER_SOCKET: "/nonexistent/chronix-maintained-check.sock" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(result.stderr);
    assert.equal(result.success, false, `${script} accepted Pectra`);
    assert.match(stderr, /not maintained/, stderr);
  });
}

Deno.test("lifecycle and e2e scenario defaults select only maintained profiles", () => {
  assert.deepEqual(testProfiles(undefined), [...maintainedProfiles]);
  assert.deepEqual(testProfiles("gloas"), ["gloas"]);
  assert.throws(() => testProfiles("pectra"), /not maintained/);
});

for (const workflow of ["images.yml", "lighthouse.yml"]) {
  Deno.test(`${workflow} offers only maintained profiles in its manual form`, async () => {
    const text = await Deno.readTextFile(`.github/workflows/${workflow}`);
    const input = /\n {6}profile:\n((?: {8}.*\n)+)/.exec(text)?.[1];
    assert(input, "missing profile input");
    assert.match(input, /^ {8}type: choice$/m, "profile must be a choice, not free text");
    const options = [...input.matchAll(/^ {10}- (\S+)$/gm)].map((match) => match[1]);
    assert.deepEqual(options, [...maintainedProfiles]);
    assert.match(input, new RegExp(`^ {8}default: ${maintainedProfiles[0]}$`, "m"));
  });
}
