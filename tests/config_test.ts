import assert from "node:assert/strict";
import { allowedHosts, configuration, entryNetwork, readNetwork } from "../src/config.ts";
import { dockerClient, Infrastructure, LABEL, ROLE } from "../src/docker.ts";
import { Network } from "../src/network.ts";
import {
  clockEnvironment,
  maintainedProfile,
  maintainedProfiles,
  profiles,
} from "../src/profiles.ts";

function withEnv(values: Record<string, string>, check: () => void): void {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, Deno.env.get(name)]),
  );
  try {
    for (const [name, value] of Object.entries(values)) Deno.env.set(name, value);
    check();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("Panda environment selects the hardfork and bake; explicit options take precedence", () => {
  withEnv({ PANDA_PROFILE: "gloas", PANDA_BAKE: "candidate" }, () => {
    assert.equal(configuration().profile, "gloas");
    assert.equal(configuration().bake, "candidate");
    assert.equal(configuration({ profile: "pectra", bake: "local" }).profile, "pectra");
    assert.equal(configuration({ profile: "pectra", bake: "local" }).bake, "local");
  });
});

Deno.test("defaults are absent keys, so v1.0.1 configurations keep their canonical value", () => {
  const legacy = [
    "bake",
    "chainId",
    "churnLimitQuotient",
    "consolidationChurnLimitQuotient",
    "genesisTime",
    "id",
    "mode",
    "profile",
    "validators",
  ];
  assert.deepEqual(Object.keys(configuration({})).sort(), legacy);
  assert.deepEqual(Object.keys(configuration({ history: "pruned" })).sort(), legacy);
  assert.equal(configuration({ history: "archive" }).history, "archive");
  assert.throws(() => configuration({ history: "full" as never }), /Invalid history mode/);
});

Deno.test("network options are one JSON object with known keys", async () => {
  const options = {
    chainId: 32382,
    genesisTime: 1_900_000_000,
    genesisForkVersion: "0x10000038",
    history: "archive",
    genesis: { gasLimit: 60_000_000 },
  } as const;
  assert.deepEqual(readNetwork(JSON.stringify(options)), options);
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, JSON.stringify(options));
    assert.deepEqual(readNetwork(path), options);
    await Deno.writeTextFile(path, "[]");
    assert.throws(() => readNetwork(path), /Network options must be an object/);
  } finally {
    await Deno.remove(path);
  }
  assert.throws(() => readNetwork('{"chainID":32382}'), /Unknown network option: chainID/);
  assert.deepEqual(entryNetwork(undefined, '{"gasLimit":60000000}'), {
    genesis: { gasLimit: 60_000_000 },
  });
  assert.deepEqual(entryNetwork("", ""), {});
  assert.throws(
    () => entryNetwork('{"genesis":{}}', '{"gasLimit":60000000}'),
    /not both/,
  );
});

Deno.test("allowed hosts are exact canonical host names", () => {
  assert.deepEqual(allowedHosts(undefined), []);
  assert.deepEqual(allowedHosts(""), []);
  assert.deepEqual(allowedHosts("panda,panda.ci.internal, 10.0.0.5"), [
    "panda",
    "panda.ci.internal",
    "10.0.0.5",
  ]);
  for (
    const entry of [
      "Panda",
      "panda:8545",
      "http://panda",
      "panda/x",
      "*",
      "*.ci",
      "0.0.0.0",
      "[::]",
    ]
  ) {
    assert.throws(() => allowedHosts(entry), /Invalid allowed host/, entry);
  }
});

Deno.test("genesis time is a whole number of seconds", () => {
  assert.throws(() => configuration({ genesisTime: 1.5 }), /Invalid genesis time/);
  assert.equal(configuration({ genesisTime: 1_900_000_000 }).genesisTime, 1_900_000_000);
});

Deno.test("clock launch and restart select the environment compiled into each bake", () => {
  for (const recipe of Object.values(profiles)) {
    assert.deepEqual(clockEnvironment(recipe), {
      startMs: "PANDA_CLOCK_START_MS",
      port: "PANDA_CLOCK_PORT",
    });
    const archivedRecipe = { ...recipe, clockEnvPrefix: undefined };
    assert.throws(
      () => clockEnvironment(archivedRecipe),
      /Missing clock environment namespace.*deno task bake/,
    );
    assert.throws(() => clockEnvironment({ ...recipe, clockEnvPrefix: "" }));
    assert.throws(() => clockEnvironment({ ...recipe, clockEnvPrefix: "bad=name" }));
  }
});

Deno.test("Panda Docker socket overrides DOCKER_HOST without allowing a remote daemon", () => {
  for (const host of ["tcp://remote:2375", "tcp://remote:2376"]) {
    withEnv({ PANDA_DOCKER_SOCKET: "/tmp/panda-test.sock", DOCKER_HOST: host }, () => {
      const client = dockerClient();
      assert.equal(Reflect.get(client.modem, "socketPath"), "/tmp/panda-test.sock");
      assert.equal(Reflect.get(client.modem, "host"), undefined);
      assert.equal(Reflect.get(client.modem, "protocol"), "http");
    });
  }
});

Deno.test("Panda state and Docker ownership use the project namespace", () => {
  const id = "namespace-test";
  assert.equal(new Network(configuration({ id })).directory, `${Deno.cwd()}/.panda/${id}`);
  assert.equal(LABEL, "io.panda.id");
  assert.equal(ROLE, "io.panda.role");
  assert.deepEqual(new Infrastructure(id).labels, { "io.panda.id": id });
});

Deno.test("Gloas is the default and only maintained profile; Pectra stays explicit history", () => {
  const previous = Deno.env.get("PANDA_PROFILE");
  Deno.env.delete("PANDA_PROFILE");
  try {
    assert.equal(configuration().profile, "gloas");
  } finally {
    if (previous !== undefined) Deno.env.set("PANDA_PROFILE", previous);
  }
  assert.deepEqual([...maintainedProfiles], ["gloas"]);
  assert.equal(maintainedProfile("gloas"), "gloas");
  assert.throws(() => maintainedProfile("pectra"), /not maintained/);
  assert.equal(configuration({ profile: "pectra" }).profile, "pectra", "history became unusable");
});

async function ciMatrix(script: string, selection: string) {
  const output = await Deno.makeTempFile();
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", script, "matrix", selection],
      env: {
        GITHUB_OUTPUT: output,
        GITHUB_REF: "refs/tags/v9.9.9",
        GITHUB_REPOSITORY_OWNER: "example",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = await Deno.readTextFile(output);
    const matrix = /^matrix=(.*)$/m.exec(text)?.[1];
    return {
      success: result.success,
      stderr: new TextDecoder().decode(result.stderr),
      profiles: matrix
        ? (JSON.parse(matrix).include as { profile: string }[]).map((item) => item.profile)
        : [],
    };
  } finally {
    await Deno.remove(output);
  }
}

for (const script of ["scripts/release_ci.ts", "scripts/lighthouse_ci.ts"]) {
  Deno.test(`${script} builds and publishes only maintained profiles`, async () => {
    const all = await ciMatrix(script, "all");
    assert.equal(all.success, true, all.stderr);
    assert.deepEqual(all.profiles, ["gloas"]);
    const pectra = await ciMatrix(script, "pectra");
    assert.equal(pectra.success, false, "CI accepted the historical Pectra profile");
    assert.match(pectra.stderr, /not maintained/);
  });
}

Deno.test("retained or saved configuration compares genesis parameters by value", async () => {
  const { configMismatch } = await import("../src/controller.ts");
  const genesis = {
    gasLimit: 60_000_000,
    accounts: { ["0x" + "11".repeat(20)]: { balance: "1" } },
  };
  const saved = configuration({ id: "saved", genesis: structuredClone(genesis) });
  assert.equal(configMismatch({ genesis: structuredClone(genesis) }, saved), undefined);
  assert.equal(configMismatch({ genesis: { gasLimit: 45_000_000 } }, saved), "genesis");
  assert.equal(configMismatch({ id: "other" }, saved, ["id"]), undefined, "ignored keys");
});

Deno.test("client run logs get unique names that sort by time", async () => {
  const { clientRunLog } = await import("../src/network.ts");
  const first = clientRunLog("bn", new Date("2026-10-13T12:00:00.123Z"));
  const second = clientRunLog("bn", new Date("2026-10-13T12:00:01.000Z"));
  assert.match(first, /^bn-run-[a-z0-9-]+$/);
  assert.notEqual(first, second);
  assert(first < second);
});
