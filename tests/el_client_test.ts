import assert from "node:assert/strict";
import { ensureImage } from "../src/client_images.ts";
import { resolve } from "node:path";
import { configuration } from "../src/config.ts";
import { Infrastructure } from "../src/docker.ts";
import { elClients, elEntry, elImage, elReady, readEl } from "../src/el_client.ts";
import { checkEngineCapabilities } from "../src/engine.ts";
import { genesisEnvironment, genesisScript } from "../src/genesis.ts";
import { deadline } from "../src/http.ts";
import { readBake } from "../src/profiles.ts";

const reth =
  "ethpandaops/reth@sha256:249a5be9cfefeab2f3a51ca0a051e04ccdce0bff9babb5ac73f74cf72142b527";
const geth =
  "ethpandaops/geth@sha256:bd9af83c652f8b24774245fb5122128298561fff38d2ae3cf9853be3273fea07";

Deno.test("the EL catalog pins a registry image and its image id per platform", async () => {
  for await (const file of Deno.readDir("clients/el")) {
    assert.deepEqual(
      readEl(file.name.slice(0, -".json".length)),
      JSON.parse(await Deno.readTextFile(`clients/el/${file.name}`)),
      file.name,
    );
  }
  const entry = readEl("reth-main-f4676ea");
  assert.equal(entry.client, "reth");
  assert.deepEqual(elImage(entry, "linux/amd64"), {
    ref: reth,
    id: "sha256:abedd96cad0a77f6da717635768609090f3210d37712bf4649cbd52aca3506c1",
    digest: reth,
    platform: "linux/amd64",
  });
  assert.deepEqual(elImage(entry, "linux/arm64"), {
    ref: reth,
    id: "sha256:c0829596463ba0511b5a16e1de232efb3844349d5718fc2655b366db67cf2a3d",
    digest: reth,
    platform: "linux/arm64",
  });
  // The Geth that today's bakes pin keeps its exact image.
  assert.equal(readEl("geth-master-5d8fd6b").client, "geth");
  assert.deepEqual(elImage(readEl("geth-master-5d8fd6b"), "linux/arm64"), {
    ref: geth,
    id: "sha256:50acd60c272047362ff5369de1eae09dc0094ba714eeff0f88e8ab64d53903e5",
    digest: geth,
    platform: "linux/arm64",
  });
  assert.throws(() => elImage(entry, "linux/riscv64"), /linux\/riscv64/);
});

Deno.test("a local EL build has one platform and no registry digest", () => {
  const id = `sha256:${"80".repeat(32)}`;
  const local = elEntry(
    { client: "geth", image: "chronix-geth:p17-fix", ids: { "linux/arm64": id } },
    "geth-p17-fix",
  );
  assert.deepEqual(elImage(local, "linux/arm64"), {
    ref: "chronix-geth:p17-fix",
    id,
    platform: "linux/arm64",
  });
  assert.throws(() => elImage(local, "linux/amd64"), /linux\/amd64/);
});

Deno.test("invalid or unknown EL catalog entries are refused by name", () => {
  const id = `sha256:${"ab".repeat(32)}`;
  const ids = { "linux/amd64": id };
  for (
    const [name, value] of [
      ["unknown client", { client: "besu", image: reth, ids }],
      ["missing client", { image: reth, ids }],
      ["short digest", { client: "reth", image: "ethpandaops/reth@sha256:249a5be9", ids }],
      ["no platform", { client: "reth", image: reth, ids: {} }],
      ["mutable id", { client: "reth", image: reth, ids: { "linux/amd64": "latest" } }],
      ["non-Linux platform", { client: "reth", image: reth, ids: { "darwin/arm64": id } }],
      ["local build with two platforms", {
        client: "geth",
        image: "chronix-geth:local",
        ids: { ...ids, "linux/arm64": `sha256:${"cd".repeat(32)}` },
      }],
      ["unknown field", { client: "reth", image: reth, ids, tag: "main-f4676ea" }],
      ["array", []],
      ["null", null],
    ] as const
  ) {
    assert.throws(() => elEntry(value, "bad-entry"), /bad-entry/, name);
  }
  assert.throws(() => readEl("nethermind-main"), /Unknown EL.*nethermind-main/);
  for (const name of ["../reth-main-f4676ea", "Reth-main-f4676ea", ""]) {
    assert.throws(() => readEl(name), Error, name);
  }
});

Deno.test("Geth initializes and starts with today's exact arguments", () => {
  const client = elClients.geth;
  const pruned = configuration({ el: "geth-master-5d8fd6b" });
  assert.deepEqual(client.init(pruned), ["--datadir=/el", "init", "/shared/metadata/genesis.json"]);
  assert.deepEqual(client.start(pruned), [
    "--datadir=/el",
    "--ipcdisable",
    "--networkid=1337",
    "--http",
    "--http.addr=0.0.0.0",
    "--http.vhosts=*",
    "--http.api=eth,net,web3,txpool,debug",
    "--authrpc.addr=0.0.0.0",
    "--authrpc.vhosts=*",
    "--authrpc.jwtsecret=/shared/jwt/jwtsecret",
    "--nodiscover",
    "--maxpeers=0",
    "--syncmode=full",
    "--cache=64",
    "--verbosity=3",
    "--log.json",
  ]);
  const custom = configuration({
    el: "geth-master-5d8fd6b",
    chainId: 32382,
    history: "archive",
    genesis: { gasLimit: 60_000_000 },
  });
  assert.deepEqual(client.init(custom), [
    "--datadir=/el",
    "--state.scheme=hash",
    "init",
    "/shared/metadata/genesis.json",
  ]);
  assert.deepEqual(client.start(custom), [
    "--datadir=/el",
    "--ipcdisable",
    "--networkid=32382",
    "--http",
    "--http.addr=0.0.0.0",
    "--http.vhosts=*",
    "--http.api=eth,net,web3,txpool,debug",
    "--authrpc.addr=0.0.0.0",
    "--authrpc.vhosts=*",
    "--authrpc.jwtsecret=/shared/jwt/jwtsecret",
    "--nodiscover",
    "--maxpeers=0",
    "--syncmode=full",
    "--state.scheme=hash",
    "--gcmode=archive",
    "--cache=64",
    "--verbosity=3",
    "--log.json",
    "--miner.gaslimit=60000000",
  ]);
});

Deno.test("Geth's payload gate waits for its Updated payload log", () => {
  assert.deepEqual(elClients.geth.gate, { mode: "log", message: "Updated payload" });
});

Deno.test("Geth's stop check requires persisted state and no trie failure", () => {
  for (
    const [logs, archive, accepted] of [
      ['{"msg":"Persisted dirty state to file"}\n{"msg":"Blockchain stopped"}', false, true],
      ['{"msg":"Persisted dirty state to disk"}\n{"msg":"Blockchain stopped"}', false, true],
      ['{"msg":"Blockchain stopped"}', false, false],
      ['{"msg":"Persisted dirty state to file"}', false, false],
      // An archive node commits every block, so it has no dirty state left to persist.
      ['{"msg":"Blockchain stopped"}', true, true],
      ['{"msg":"Failed to close trie database"}\n{"msg":"Blockchain stopped"}', true, false],
      [
        "Persisted dirty state to file\nFailed to journal in-memory trie nodes\nBlockchain stopped",
        false,
        false,
      ],
      [
        "Persisted dirty state to file\nFailed to commit recent state trie\nBlockchain stopped",
        false,
        false,
      ],
      ["Dangling trie nodes after full cleanup\nBlockchain stopped", true, false],
    ] as const
  ) {
    assert.equal(elClients.geth.stopped(logs, archive), accepted, logs);
  }
});

Deno.test("a started or restarted EL is ready once its RPC answers eth_chainId", async () => {
  const methods: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    methods.push((await request.json()).method);
    return methods.length === 1
      ? new Response("starting", { status: 503 })
      : Response.json({ jsonrpc: "2.0", id: 1, result: "0x539" });
  });
  try {
    assert.equal(await elReady(`http://127.0.0.1:${server.addr.port}`), "0x539");
    assert.deepEqual(methods, ["eth_chainId", "eth_chainId"]);
  } finally {
    await server.shutdown();
  }
});

const rethStart = [
  "node",
  "--chain=/shared/metadata/genesis.json",
  "--datadir=/el",
  "--ipcdisable",
  "--http",
  "--http.addr=0.0.0.0",
  "--http.api=eth,net,web3,txpool,debug",
  "--authrpc.addr=0.0.0.0",
  "--authrpc.jwtsecret=/shared/jwt/jwtsecret",
  "--disable-discovery",
  "--max-peers=0",
  "--nat=none",
  "--no-persist-peers",
  "--log.stdout.format=json",
  "--log.stdout.filter=info,engine::tree=debug",
  "--log.file.max-files=0",
  "--engine.persistence-threshold=0",
  "--db.growth-step=4MB",
];

Deno.test("Reth starts from the genesis file with arguments from the network options", () => {
  const client = elClients.reth;
  const pruned = configuration({ el: "reth-main-f4676ea" });
  assert.equal(client.init(pruned), undefined, "Reth writes genesis on its first start");
  assert.deepEqual(client.start(pruned), [
    ...rethStart,
    "--prune.account-history.distance=10064",
    "--prune.storage-history.distance=10064",
  ]);
  // The chain ID comes from genesis.json; archive history prunes nothing.
  assert.deepEqual(
    client.start(configuration({
      el: "reth-main-f4676ea",
      chainId: 32382,
      history: "archive",
      genesis: { gasLimit: 60_000_000 },
    })),
    [...rethStart, "--builder.gaslimit=60000000"],
  );
});

Deno.test("Reth's getPayload waits for its own build, so the payload gate forwards it", () => {
  assert.deepEqual(elClients.reth.gate, { mode: "none" });
});

Deno.test("Reth's stop check requires the engine tree's completed persistence", () => {
  const complete = JSON.stringify({
    level: "DEBUG",
    fields: { message: "persistence complete, signaling termination" },
    target: "engine::tree",
  });
  const failed = JSON.stringify({
    level: "ERROR",
    fields: { message: "Termination failed", err: "channel closed" },
    target: "engine::tree",
  });
  for (
    const [logs, accepted] of [
      [complete, true],
      [`${failed}\n${complete}`, false],
      [failed, false],
      ['{"fields":{"message":"Received SIGTERM"}}', false],
      ["", false],
    ] as const
  ) {
    for (const archive of [false, true]) {
      assert.equal(elClients.reth.stopped(logs, archive), accepted, logs);
    }
  }
});

Deno.test({
  name: "the pinned Reth starts from a generated genesis with the profile's arguments",
  ignore: Deno.env.get("CHRONIX_DOCKER_TEST") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const config = configuration({
      id: `reth-${crypto.randomUUID().slice(0, 8)}`,
      el: "reth-main-f4676ea",
    });
    const bake = await readBake(config.profile, config.bake);
    const infra = new Infrastructure(config.id);
    await Deno.mkdir(".cache", { recursive: true });
    const directory = await Deno.makeTempDir({ dir: resolve(".cache"), prefix: "reth-start-" });
    const user = `${Deno.uid()}:${Deno.gid()}`;
    const port = { HostIp: "127.0.0.1", HostPort: "" };
    try {
      await Deno.mkdir(`${directory}/shared`);
      await Deno.mkdir(`${directory}/el`);
      const network = await infra.network();
      const genesis = await infra.container("genesis", {
        Image: await ensureImage(infra, bake.images.genesis),
        User: user,
        Env: genesisEnvironment(config, bake.recipe),
        Entrypoint: ["/bin/bash"],
        Cmd: ["-ec", genesisScript(config)],
        HostConfig: { Binds: [`${directory}/shared:/data`], NetworkMode: network },
      });
      await genesis.start();
      assert.equal((await genesis.wait()).StatusCode, 0, await infra.logs(genesis));
      const client = elClients.reth;
      // The controller's user, as for Geth: the image's own user is not used.
      const el = await infra.container("el", {
        Image: await ensureImage(infra, elImage(readEl(config.el), bake.images.cl.platform)),
        User: user,
        Cmd: client.start(config),
        ExposedPorts: { "8545/tcp": {}, "8551/tcp": {} },
        HostConfig: {
          Binds: [`${directory}/shared:/shared:ro`, `${directory}/el:/el`],
          NetworkMode: network,
          PortBindings: { "8545/tcp": [port], "8551/tcp": [port] },
        },
      });
      await el.start();
      const ports = (await el.inspect()).NetworkSettings.Ports;
      const url = (value: number) => `http://127.0.0.1:${ports[`${value}/tcp`]![0].HostPort}`;
      const chainId = await deadline(elReady(url(8545)), 120_000, "Reth RPC").catch(
        async (error) => assert.fail(`${error}\n${await infra.logs(el)}`),
      );
      assert.equal(BigInt(chainId), BigInt(config.chainId));
      await checkEngineCapabilities(
        url(8551),
        await Deno.readTextFile(`${directory}/shared/jwt/jwtsecret`),
        bake.recipe.engineMethods,
      );
      await el.stop({ t: 30 });
      const logs = await infra.logs(el);
      assert.equal((await el.inspect()).State.ExitCode, 0, logs);
      assert(client.stopped(logs, config.history === "archive"), logs);
    } finally {
      await infra.cleanup("network");
      await Deno.remove(directory, { recursive: true });
    }
  },
});
