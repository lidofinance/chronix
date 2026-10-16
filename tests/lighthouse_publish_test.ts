import assert from "node:assert/strict";
import { lighthouseBuild } from "../src/lighthouse_build.ts";
import { validateLighthousePublication } from "../src/lighthouse_publish.ts";
import { type ProfileName, profiles, readBake } from "../src/profiles.ts";

async function fixture(profile: ProfileName) {
  const bake = await readBake(profile, "ci-main-merge");
  // No profile verification report exists for this fresh native artifact fixture.
  bake.tag = `unit-publication-${crypto.randomUUID()}`;
  bake.lighthouse = await lighthouseBuild(profiles[profile], "linux/amd64");
  for (const [role, image] of Object.entries(bake.images)) {
    image.platform = "linux/amd64";
    image.digest = `example.test/${role}@sha256:${"a".repeat(64)}`;
  }
  const source = "b".repeat(40);
  const info = {
    Os: "linux",
    Architecture: "amd64",
    Config: {
      Labels: {
        "io.chronix.lighthouse.build": JSON.stringify(bake.lighthouse),
        "org.opencontainers.image.revision": source,
      },
    },
  };
  return { bake, build: bake.lighthouse, info, source };
}

for (const profile of ["pectra", "gloas"] as const) {
  Deno.test(`${profile} Lighthouse publication does not require a Chronix profile report`, async () => {
    const { bake, build, info, source } = await fixture(profile);
    assert.equal(await validateLighthousePublication(bake, build, profile, info), source);
  });
}

Deno.test("Lighthouse publication still rejects imported or mismatched native artifacts", async () => {
  const { bake, build, info } = await fixture("gloas");
  await assert.rejects(async () => {
    await validateLighthousePublication(
      {
        ...bake,
        source: { ...bake.source, importedCl: bake.images.cl.id },
      },
      build,
      "gloas",
      info,
    );
  }, /original native Lighthouse bake/);
  await assert.rejects(async () => {
    await validateLighthousePublication(bake, build, "pectra", info);
  }, /original native Lighthouse bake/);
  await assert.rejects(async () => {
    await validateLighthousePublication(bake, build, "gloas", { ...info, Architecture: "arm64" });
  }, /identity mismatch/);
  await assert.rejects(async () => {
    const changed = structuredClone(build);
    changed.baker.version++;
    await validateLighthousePublication(bake, changed, "gloas", info);
  }, /upstream\/baker versions/);
  await assert.rejects(async () => {
    const changed = structuredClone(info);
    changed.Config.Labels["org.opencontainers.image.revision"] = "";
    await validateLighthousePublication(bake, build, "gloas", changed);
  }, /original Lighthouse build source commit/);
});

Deno.test("full profile validation gates Chronix publication, independently of the Lighthouse release", async () => {
  const lighthouse = await Deno.readTextFile(".github/workflows/lighthouse.yml");
  assert.doesNotMatch(lighthouse, /task test:profile/);
  const chronix = await Deno.readTextFile(".github/workflows/images.yml");
  const verify = chronix.indexOf("task test:profile");
  const packageImage = chronix.indexOf("scripts/package_image.ts");
  const smoke = chronix.indexOf("scripts/test_image.ts");
  const publish = chronix.indexOf("docker push");
  assert.ok(verify > 0 && packageImage > verify && smoke > packageImage && publish > smoke);
  assert.doesNotMatch(chronix, /continue-on-error:/);
});
