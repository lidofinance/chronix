import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

Deno.test("up reuses running, parked and recovery controllers unless selection explicitly differs", async (t) => {
  const directory = await Deno.makeTempDir();
  const id = "cli-selection";
  const profile = "gloas";
  const bake = "snapshot-minimal-r1";
  const el = "reth-main-f4676ea";
  let phase = "running";
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const path = new URL(request.url).pathname;
    const method = path === "/control" ? (await request.json()).method : path.slice(9);
    assert.equal(method, "lifecycle");
    return Response.json({ result: { id, profile, bake, el, phase, ready: phase === "running" } });
  });
  try {
    await Deno.mkdir(`${directory}/${id}`);
    await Deno.writeTextFile(
      `${directory}/${id}/controller.json`,
      JSON.stringify({ url: `http://127.0.0.1:${server.addr.port}` }),
    );
    const environment = Deno.env.toObject();
    delete environment.CHRONIX_PROFILE;
    delete environment.CHRONIX_BAKE;
    delete environment.CHRONIX_EL;
    const run = async (args: string[] = [], env: Record<string, string> = {}) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-env",
          "--allow-read",
          "--allow-net=127.0.0.1",
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "up",
          ...args,
        ],
        clearEnv: true,
        env: { ...environment, CHRONIX_ID: id, CHRONIX_DATA_DIR: directory, ...env },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: result.code,
        output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
      };
    };
    for (const state of ["running", "parked", "faulted"]) {
      await t.step(`plain up reuses ${state} owner`, async () => {
        phase = state;
        const result = await run();
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /"event":"already-running"/);
      });
    }
    await t.step("matching environment and flags select the existing owner", async () => {
      for (const args of [[], ["--profile", profile, "--bake", bake, "--el", el]]) {
        const result = await run(args, {
          CHRONIX_PROFILE: profile,
          CHRONIX_BAKE: bake,
          CHRONIX_EL: el,
        });
        assert.equal(result.code, 0, result.output);
      }
    });
    await t.step("flags take precedence over environment", async () => {
      const result = await run(["--profile", profile, "--bake", bake, "--el", el], {
        CHRONIX_PROFILE: "pectra",
        CHRONIX_BAKE: "other",
        CHRONIX_EL: "geth-master-5d8fd6b",
      });
      assert.equal(result.code, 0, result.output);
    });
    await t.step("explicit conflicts are rejected before starting another network", async () => {
      for (const selection of ["profile", "bake", "el"] as const) {
        const value = { profile: "pectra", bake: "other", el: "geth-master-5d8fd6b" }[selection];
        for (
          const result of [
            await run([`--${selection}`, value]),
            await run([], { [`CHRONIX_${selection.toUpperCase()}`]: value }),
          ]
        ) {
          assert.notEqual(result.code, 0, result.output);
          assert.match(
            result.output,
            /Running gloas:snapshot-minimal-r1 on reth-main-f4676ea; requested/,
          );
        }
      }
    });
  } finally {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});
