import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { atomicJson } from "../src/artifacts.ts";
import { readBake } from "../src/profiles.ts";
import {
  currentEvidence,
  elIdentity,
  profileEnvironment,
  profileSelection,
  reportPath,
  suiteHash,
  verificationStatus,
} from "../src/verification.ts";

const reth = "reth-main-f4676ea";
const geth = "geth-master-5d8fd6b";

Deno.test("immutable bake verification ignores other profiles, new build recipes and unrelated tests", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (
      const path of [
        "client",
        "src",
        "scripts",
        "bakes",
        "tests",
        "deno.json",
        "deno.lock",
      ]
    ) {
      await cp(path, `${root}/${path}`, { recursive: true });
    }
    const pectra = () => suiteHash({ profile: "pectra" }, root);
    const gloas = () => suiteHash({ profile: "gloas" }, root);
    const before = { pectra: await pectra(), gloas: await gloas() };
    const selectedPath = `${root}/bakes/pectra/recipe.json`;
    const original = await Deno.readTextFile(selectedPath);
    const remapped = JSON.parse(original);
    [remapped.tests.baseline, remapped.tests.e2e] = [remapped.tests.e2e, remapped.tests.baseline];
    await Deno.writeTextFile(selectedPath, JSON.stringify(remapped));
    assert.notEqual(await pectra(), before.pectra, "Changing scenario routing changes the suite");
    assert.equal(await gloas(), before.gloas);
    await Deno.writeTextFile(selectedPath, original);
    await Deno.writeTextFile(`${root}/bakes/gloas/tests/gloas.ts`, "\n// new Gloas assertion\n", {
      append: true,
    });
    assert.equal(await pectra(), before.pectra);
    assert.notEqual(await gloas(), before.gloas);
    const changedGloas = await gloas();
    for (const profile of ["pectra", "gloas"]) {
      const path = `${root}/bakes/${profile}/recipe.json`;
      const recipe = JSON.parse(await Deno.readTextFile(path));
      recipe.clRef = "a-different-client-for-a-future-bake";
      recipe.patch = `bakes/${profile}/a-new-patch.patch`;
      await Deno.writeTextFile(path, JSON.stringify(recipe));
    }
    await Deno.writeTextFile(`${root}/bakes/shared/controlled_clock.rs`, "new clock source");
    await Deno.writeTextFile(`${root}/tests/profiles_test.ts`, "new baker unit test");
    await Deno.writeTextFile(`${root}/src/baker.ts`, "new build implementation");
    assert.equal(await pectra(), before.pectra);
    assert.equal(await gloas(), changedGloas);
    const defaultsPath = `${root}/bakes/pectra/recipe.json`;
    const defaults = JSON.parse(await Deno.readTextFile(defaultsPath));
    defaults.churnLimitQuotient = 4;
    await Deno.writeTextFile(defaultsPath, JSON.stringify(defaults));
    assert.notEqual(await pectra(), before.pectra);
    assert.equal(await gloas(), changedGloas);
    defaults.churnLimitQuotient = 65536;
    await Deno.writeTextFile(defaultsPath, JSON.stringify(defaults));
    assert.equal(await pectra(), before.pectra);
    await Deno.writeTextFile(
      `${root}/bakes/shared/tests/validators.ts`,
      "\n// shared validator assertion\n",
      { append: true },
    );
    assert.notEqual(await pectra(), before.pectra);
    const shared = await pectra();
    await Deno.writeTextFile(`${root}/src/time.ts`, "\n// changed shared timeline\n", {
      append: true,
    });
    assert.notEqual(await pectra(), shared);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("profile evidence lives under its bake tag and the EL it ran on", () => {
  assert.equal(
    reportPath("gloas", "chronix", reth, "e2e"),
    "reports/profiles/gloas/chronix/reth-main-f4676ea/e2e.json",
  );
  assert.equal(
    reportPath("gloas", "chronix", geth, "verification"),
    "reports/profiles/gloas/chronix/geth-master-5d8fd6b/verification.json",
  );
  for (
    const [profile, tag, el] of [
      ["main", "chronix", reth],
      ["gloas", "../chronix", reth],
      ["gloas", "chronix", "../reth-main-f4676ea"],
    ] as const
  ) {
    assert.throws(() => reportPath(profile as "gloas", tag, el, "e2e"), `${profile}/${tag}/${el}`);
  }
});

Deno.test("evidence binds the EL name and its catalog image id at the bake platform", async () => {
  const bake = await readBake("gloas", "snapshot-minimal-r1");
  assert.equal(bake.images.cl.platform, "linux/arm64");
  assert.deepEqual(elIdentity(bake, reth), {
    el: reth,
    elImage: "sha256:c0829596463ba0511b5a16e1de232efb3844349d5718fc2655b366db67cf2a3d",
  });
  assert.deepEqual(elIdentity(bake, geth), {
    el: geth,
    elImage: "sha256:50acd60c272047362ff5369de1eae09dc0094ba714eeff0f88e8ab64d53903e5",
  });
});

Deno.test("a scenario report is evidence only for its own run, bake and EL", async () => {
  const bake = await readBake("gloas", "snapshot-minimal-r1");
  const expected = { runId: "run-1", bakeKey: bake.key, ...elIdentity(bake, reth) };
  assert.equal(currentEvidence({ ...expected, passed: true }, expected), true);
  for (
    const report of [
      { ...expected, el: geth },
      { ...expected, elImage: elIdentity(bake, geth).elImage },
      { ...expected, runId: "run-2" },
      { ...expected, bakeKey: "00".repeat(32) },
      { runId: expected.runId, bakeKey: expected.bakeKey },
    ]
  ) {
    assert.equal(currentEvidence(report, expected), false, JSON.stringify(report));
  }
});

Deno.test("test:profile takes a hardfork, an optional bake and an optional EL", () => {
  const previous = Deno.env.get("CHRONIX_EL");
  // The harness chooses the EL; an inherited environment does not.
  Deno.env.set("CHRONIX_EL", geth);
  try {
    assert.deepEqual(profileSelection(["gloas"]), { profile: "gloas", tag: "default", el: reth });
  } finally {
    if (previous === undefined) Deno.env.delete("CHRONIX_EL");
    else Deno.env.set("CHRONIX_EL", previous);
  }
  const selection = profileSelection(["gloas", "--bake", "chronix", "--el", geth]);
  assert.deepEqual(selection, { profile: "gloas", tag: "chronix", el: geth });
  assert.deepEqual(profileEnvironment(selection, "run-1"), {
    CHRONIX_E2E: "1",
    CHRONIX_PROFILE: "gloas",
    CHRONIX_BAKE: "chronix",
    CHRONIX_EL: geth,
    CHRONIX_VERIFY_RUN: "run-1",
  });
  for (
    const [args, error] of [
      [[], /Usage/],
      [["gloas", "pectra"], /Usage/],
      [["pectra"], /not maintained/],
      [["gloas", "--el", "nethermind-main"], /Unknown EL/],
      [["gloas", "--engine", "reth"], /Unknown option/],
    ] as const
  ) {
    assert.throws(() => profileSelection([...args]), error, args.join(" "));
  }
});

Deno.test("verification status reads the report of the selected EL only", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (
      const path of [
        "client",
        "clients",
        "src",
        "scripts",
        "bakes",
        "tests",
        "deno.json",
        "deno.lock",
      ]
    ) {
      await cp(path, `${root}/${path}`, { recursive: true });
    }
    const bake = await readBake("gloas", "snapshot-minimal-r1");
    const passed = {
      passed: true,
      bakeKey: bake.key,
      suiteHash: await suiteHash(bake, root),
      finishedAt: "2026-10-19T12:00:00.000Z",
    };
    const directory = `${root}/reports/profiles/gloas/snapshot-minimal-r1`;
    // An EL-less report is not evidence for any EL.
    await atomicJson(`${directory}/verification.json`, passed);
    assert.deepEqual(await verificationStatus(bake, reth, root), { verified: false });
    await atomicJson(`${directory}/${reth}/verification.json`, {
      ...passed,
      ...elIdentity(bake, reth),
    });
    assert.deepEqual(await verificationStatus(bake, reth, root), {
      verified: true,
      verifiedAt: passed.finishedAt,
    });
    assert.deepEqual(await verificationStatus(bake, geth, root), { verified: false });
    await atomicJson(`${directory}/${reth}/verification.json`, {
      ...passed,
      ...elIdentity(bake, reth),
      elImage: elIdentity(bake, geth).elImage,
    });
    assert.deepEqual(await verificationStatus(bake, reth, root), { verified: false });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
