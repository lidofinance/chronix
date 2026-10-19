import assert from "node:assert/strict";
import { resolve } from "node:path";
import { atomicJson } from "../src/artifacts.ts";
import type { BakeOptions } from "../src/baker.ts";
import { type Bake, bakePath, profiles, readBake, sha256, sourceHashes } from "../src/profiles.ts";

Deno.test("profile inputs and executable suites are owned by the hardfork or shared bake directory", async () => {
  for (const [name, recipe] of Object.entries(profiles)) {
    assert.equal(recipe.patch, `bakes/${name}/lighthouse.patch`);
    assert.equal(recipe.clockSource, "bakes/shared/controlled_clock.rs");
    assert.equal(recipe.clockTest, "bakes/shared/controlled_clock_test.rs");
    const hashes = await sourceHashes(recipe);
    for (const path of Object.keys(hashes)) {
      assert(path.startsWith(`bakes/${name}/`) || path.startsWith("bakes/shared/"));
    }
    assert(!Array.isArray(recipe.tests), "Each scenario must declare its executable path");
    for (const [scenario, path] of Object.entries(recipe.tests)) {
      assert(typeof path === "string");
      assert(path.startsWith(`bakes/${name}/tests/`) || path.startsWith("bakes/shared/tests/"));
      assert((await Deno.stat(path)).isFile, `${name}/${scenario} has no executable`);
    }
  }
});

Deno.test("a bake is Lighthouse only: the EL is a network option, not a bake input", () => {
  for (const field of ["elImage", "elRepository", "goBuilder"]) {
    assert(!Object.hasOwn(profiles.gloas, field), `gloas recipe still names ${field}`);
  }
  // @ts-expect-error The baker neither imports nor compiles an EL.
  const _image: BakeOptions = { elImage: "ethpandaops/geth:master" };
  // @ts-expect-error The baker neither imports nor compiles an EL.
  const _source: BakeOptions = { elRef: "master" };
  // @ts-expect-error No Go builder remains.
  const _go: BakeOptions = { goImage: "golang:1.25-bookworm" };
  // @ts-expect-error A bake manifest has no EL image.
  const _role: keyof Bake["images"] = "el";
  // @ts-expect-error A bake manifest has no EL source.
  const _commit: keyof Bake["source"] = "el";
});

Deno.test("a bake manifest without an EL image passes readBake", async () => {
  const root = await Deno.makeTempDir();
  try {
    const manifest = JSON.parse(await Deno.readTextFile(bakePath("gloas", "stable")));
    delete manifest.images.el;
    await atomicJson(`${root}/bakes/gloas/tags/without-el.json`, {
      ...manifest,
      tag: "without-el",
    });
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `--config=${resolve("deno.json")}`,
        `import { readBake } from ${
          JSON.stringify(new URL("../src/profiles.ts", import.meta.url).href)
        }; console.log(JSON.stringify(Object.keys((await readBake("gloas", "without-el")).images).sort()));`,
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(result.stdout)), [
      "baseline",
      "cl",
      "genesis",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bake tag namespace is separate from recipe and shared module names", () => {
  for (const tag of ["default", "recipe", "shared", "release.2"]) {
    assert.equal(bakePath("gloas", tag), `bakes/gloas/tags/${tag}.json`);
  }
});

Deno.test("tag listing reads new and legacy manifests without treating recipes as artifacts", async () => {
  const root = await Deno.makeTempDir();
  try {
    const base = await readBake("gloas", "stable");
    await atomicJson(`${root}/bakes/gloas/recipe.json`, profiles.gloas);
    await atomicJson(`${root}/bakes/gloas/legacy.json`, { ...base, tag: "legacy" });
    await atomicJson(`${root}/bakes/gloas/tags/recipe.json`, { ...base, tag: "recipe" });
    await atomicJson(`${root}/bakes/gloas/tags/shared.json`, { ...base, tag: "shared" });
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", `--config=${resolve("deno.json")}`, "-A", resolve("scripts/bakes.ts")],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    const listed = new TextDecoder().decode(result.stdout).trim().split("\n").map((line) =>
      JSON.parse(line)
    );
    assert.deepEqual(listed.map((b) => b.tag), ["legacy", "recipe", "shared"]);
    assert(listed.every((b) => b.key === base.key && b.verified === false));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("legacy and relocated copies may agree but conflicting immutable tags fail closed", async () => {
  const root = await Deno.makeTempDir();
  try {
    const base = { ...await readBake("gloas", "stable"), tag: "candidate" };
    const legacy = `${root}/bakes/gloas/candidate.json`;
    const current = `${root}/bakes/gloas/tags/candidate.json`;
    const read = () =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `--config=${resolve("deno.json")}`,
          `import { readBake } from ${
            JSON.stringify(new URL("../src/profiles.ts", import.meta.url).href)
          }; console.log(JSON.stringify(await readBake("gloas", "candidate")));`,
        ],
        cwd: root,
        stdout: "piped",
        stderr: "piped",
      }).output();
    await atomicJson(legacy, base);
    assert.equal((await read()).code, 0);
    await atomicJson(current, base);
    assert.equal((await read()).code, 0);
    await atomicJson(current, { ...base, key: "a".repeat(64) });
    const conflict = await read();
    assert.notEqual(conflict.code, 0, "Conflicting tag copies must not be silently selected");
    assert.match(new TextDecoder().decode(conflict.stderr), /conflict/i);
    await Deno.remove(legacy);
    const relocated = await read();
    assert.equal(relocated.code, 0, new TextDecoder().decode(relocated.stderr));
    assert.equal(JSON.parse(new TextDecoder().decode(relocated.stdout)).key, "a".repeat(64));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("legacy native input paths recover relocated bytes only on an exact hash match", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = `${root}/bakes/shared/controlled_clock.rs`;
    await Deno.mkdir(`${root}/bakes/shared`, { recursive: true });
    await Deno.writeTextFile(path, "original clock");
    const hash = await sha256("original clock");
    const recover = () =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `--config=${resolve("deno.json")}`,
          `import { snapshotSources } from ${
            JSON.stringify(new URL("../src/baker.ts", import.meta.url).href)
          }; console.log(JSON.stringify(await snapshotSources({"clients/controlled_clock.rs": ${
            JSON.stringify(hash)
          }}, "archive")));`,
        ],
        cwd: root,
        stdout: "piped",
        stderr: "piped",
      }).output();
    const recovered = await recover();
    assert.equal(recovered.code, 0, new TextDecoder().decode(recovered.stderr));
    assert.equal(
      JSON.parse(new TextDecoder().decode(recovered.stdout))["clients/controlled_clock.rs"],
      "original clock",
    );
    await Deno.remove(`${root}/archive`, { recursive: true });
    await Deno.writeTextFile(path, "different revision");
    const wrongRevision = await recover();
    assert.notEqual(wrongRevision.code, 0);
    assert.match(new TextDecoder().decode(wrongRevision.stderr), /Missing archived native source/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
