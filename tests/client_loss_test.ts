/** Controller, network and Docker adapters only: no daemon, client process or consensus claim. */
import assert from "node:assert/strict";
import { configuration } from "../src/config.ts";
import { Controller } from "../src/controller.ts";
import { LABEL } from "../src/docker.ts";
import { resolvedEl } from "../src/el_client.ts";
import { deadline, delay } from "../src/http.ts";
import { type Manifest, Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
import { Timeline } from "../src/time.ts";
import { type FakeClient, fakeClients, runningClients } from "./fixtures/client_containers.ts";

const recovery = /restore a snapshot, or down and up/;

/** The refusal of a client that exited on its own: role, exit code, OOM kill and recovery. */
function lost(role: string, exitCode: number, oomKilled: boolean) {
  return (error: unknown) => {
    const message = String(error);
    assert.match(message, new RegExp(`Client ${role} exited on its own`));
    assert.match(message, new RegExp(`exit ${exitCode}\\b`));
    if (oomKilled) assert.match(message, /OOMKilled/);
    else assert.doesNotMatch(message, /OOMKilled/);
    assert.match(message, recovery);
    return true;
  };
}

async function fixture(
  clients: FakeClient[],
  run: (f: {
    controller: Controller;
    network: Network;
    calls: ReturnType<typeof fakeClients>;
    moves: () => number;
    skips: () => number;
  }) => Promise<void>,
) {
  const hash = `0x${"12".repeat(32)}`;
  const base = await Deno.makeTempDir({ prefix: "chronix-client-loss-" });
  const prior = Deno.env.get("CHRONIX_DATA_DIR");
  Deno.env.set("CHRONIX_DATA_DIR", base);
  // The EL and beacon node reads of `status`; a client that is down no longer answers on its port.
  const up = (role: string) =>
    clients.some((client) => client.role === role && client.running && !client.previous);
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    if (request.method === "POST") {
      if (!up("el")) return new Response("EL connection refused", { status: 502 });
      const { id } = await request.json();
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: { hash, number: "0x0", timestamp: "0x0" },
      });
    }
    if (!up("bn")) return new Response("beacon node connection refused", { status: 502 });
    return Response.json({ data: { finalized: { epoch: "0", root: hash } } });
  });
  const url = `http://127.0.0.1:${server.addr.port}`;
  const bake = await readBake("gloas", "snapshot-minimal-r1");
  const config = configuration({
    id: `unit-loss-${crypto.randomUUID().slice(0, 8)}`,
    profile: "gloas",
    bake: bake.tag,
    el: "reth-main-f4676ea",
  });
  const network = new Network(config);
  const calls = fakeClients(network, clients);
  let moves = 0;
  let skips = 0;
  const genesisMs = config.genesisTime * 1000;
  const time = new Timeline(genesisMs, genesisMs + 11_500, {
    move: () => Promise.resolve(void moves++),
    skip: () => Promise.resolve(void skips++),
  });
  const manifest: Manifest = {
    config,
    bake,
    execution: resolvedEl(config.el, bake.images.cl.platform),
    directory: network.directory,
    el: url,
    beacon: url,
    bnClock: url,
    vcClock: url,
    vc: url,
  };
  const controller = new Controller(network, manifest, time);
  try {
    await run({ controller, network, calls, moves: () => moves, skips: () => skips });
  } finally {
    await controller.interval.stop();
    await controller.automine.stop();
    await server.shutdown();
    if (prior === undefined) Deno.env.delete("CHRONIX_DATA_DIR");
    else Deno.env.set("CHRONIX_DATA_DIR", prior);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("a client that exited on its own faults the timeline and names its exit", async () => {
  const clients = runningClients();
  clients[1] = { role: "bn", running: false, exitCode: 137, oomKilled: true };
  await fixture(clients, async ({ controller, moves }) => {
    await assert.rejects(controller.command("stepSlot"), lost("bn", 137, true));
    assert.equal(moves(), 0, "the refused slot reached the clients");
    // Like other unrecoverable errors: the client API cannot start a client it did not stop.
    assert.equal(
      controller.lifecycle().recoveryRequired,
      true,
      "the loss did not fault the timeline",
    );
    await assert.rejects(
      controller.command("advanceSlots", [1]),
      /reset required.*Client bn exited on its own/,
    );
    // The status read stays available for diagnosis; the beacon read fails, the loss is named.
    await assert.rejects(controller.command("status"), lost("bn", 137, true));
    assert.equal(moves(), 0);
  });
});

Deno.test("every time mutation checks the clients before it moves time", async (t) => {
  const mutations: [string, (controller: Controller) => unknown[]][] = [
    ["stepSlot", () => []],
    ["advanceSlots", () => [2]],
    ["advanceEpochs", () => [1]],
    ["advanceTime", () => [12]],
    ["advanceTo", (controller) => [controller.time.timestamp + 12]],
    ["skipSlots", () => [1]],
    ["missProposal", () => [5]],
  ];
  for (const [method, params] of mutations) {
    await t.step(method, async () => {
      const clients = runningClients();
      clients[0] = { role: "el", running: false, exitCode: 1 };
      await fixture(clients, async ({ controller, moves, skips }) => {
        await assert.rejects(controller.command(method, params(controller)), lost("el", 1, false));
        assert.equal(moves() + skips(), 0, `${method} reached the clients`);
        assert.equal(controller.lifecycle().recoveryRequired, true);
      });
    });
  }
});

Deno.test("a removed client container faults the timeline like an exited one", async () => {
  await fixture(runningClients().filter((client) => client.role !== "vc"), async (f) => {
    await assert.rejects(f.controller.command("stepSlot"), (error: unknown) => {
      assert.match(String(error), /Client vc is missing/);
      assert.match(String(error), recovery);
      return true;
    });
    assert.equal(f.moves(), 0);
    assert.equal(f.controller.lifecycle().recoveryRequired, true);
  });
});

Deno.test("a client stopped through the API is not lost, but another client's exit faults", async () => {
  const clients = runningClients();
  // `stopClient("vc", { kill: true })`: the container exits with SIGKILL's code.
  clients[2] = { role: "vc", running: false, exitCode: 137 };
  await fixture(clients, async ({ controller, network, moves }) => {
    network.stoppedClients.add("vc");
    await assert.rejects(
      controller.command("stepSlot"),
      /Client vc is stopped; start it before advancing time/,
    );
    assert.equal(controller.lifecycle().recoveryRequired, false, "a deliberate stop faulted");
    assert.equal((await controller.status()).clientError, undefined);
    clients[1] = { role: "bn", running: false, exitCode: 1 };
    // Starting vc cannot help: the unrecoverable loss is reported first.
    await assert.rejects(controller.command("stepSlot"), lost("bn", 1, false));
    assert.equal(controller.lifecycle().recoveryRequired, true);
    assert.equal(moves(), 0);
  });
});

Deno.test("status reports a client that exited on its own without moving time", async () => {
  const clients = runningClients();
  await fixture(clients, async ({ controller, moves }) => {
    assert.equal((await controller.status()).clientError, undefined, "healthy clients");
    clients[2] = { role: "vc", running: false, exitCode: 137, oomKilled: true };
    const before = controller.time.nowMs;
    const { clientError } = await controller.status();
    assert.ok(clientError, "status hid the lost client");
    lost("vc", 137, true)(clientError);
    assert.equal(controller.time.nowMs, before);
    assert.equal(moves(), 0);
  });
});

Deno.test("status names a lost EL or beacon node instead of the failed read of its port", async (t) => {
  for (const role of ["el", "bn"] as const) {
    await t.step(role, async () => {
      const clients = runningClients();
      clients[role === "el" ? 0 : 1] = { role, running: false, exitCode: 137 };
      await fixture(clients, async ({ controller }) => {
        await assert.rejects(controller.status(), lost(role, 137, false));
      });
    });
  }
});

Deno.test("a client stopped through the API whose container is then removed is missing", async () => {
  // `stopClient("vc")`, then `docker rm` outside Chronix: `startClient` has nothing to start.
  const clients = runningClients().filter((client) => client.role !== "vc");
  await fixture(clients, async ({ controller, network, moves }) => {
    network.stoppedClients.add("vc");
    await assert.rejects(controller.command("stepSlot"), (error: unknown) => {
      assert.match(String(error), /Client vc is missing/);
      assert.match(String(error), recovery);
      return true;
    });
    assert.equal(controller.lifecycle().recoveryRequired, true);
    assert.equal(moves(), 0);
  });
});

Deno.test("the container replacement of a client start is not a lost client", async () => {
  const clients = runningClients();
  clients[2] = { role: "vc", running: false, exitCode: 0 };
  await fixture(clients, async ({ controller, network }) => {
    await network.store.initialize();
    network.stoppedClients.add("vc");
    network.infra.logs = () => Promise.resolve("previous run");
    const docker = network.infra.docker;
    const get = docker.getContainer.bind(docker);
    docker.getContainer = ((reference: string) => ({
      ...get(reference),
      rename: ({ name }: { name: string }) => {
        clients[2].previous = name.endsWith("-previous");
        return Promise.resolve();
      },
    })) as unknown as typeof docker.getContainer;
    // The old container is renamed `-previous` and no new one exists yet.
    let during: string | undefined = "not checked";
    network.infra.container = (async () => {
      during = await network.lostClient();
      throw new Error("end of the fixture");
    }) as typeof network.infra.container;
    await assert.rejects(
      network.startClient("vc", controller.manifest, controller.time.nowMs),
      /end of the fixture/,
    );
    assert.equal(during, undefined, "the start's own container replacement was reported");
    // The failed start renamed the stopped container back; it stays stopped, not lost.
    assert.equal(clients[2].previous, false);
    assert.ok(network.stoppedClients.has("vc"));
    assert.equal(await network.lostClient(), undefined);
  });
});

Deno.test("a Docker query that never answers is refused after its deadline", async () => {
  await fixture(runningClients(), async ({ network }) => {
    const docker = network.infra.docker;
    docker.listContainers = (() =>
      new Promise(() => {})) as unknown as typeof docker.listContainers;
    // The outer limit only keeps a missing deadline from hanging this test.
    await assert.rejects(
      deadline(network.lostClient(20), 2_000, "test limit"),
      /Timed out: client container list/,
    );
  });
});

Deno.test("interval mining stops with the lost client's error instead of skipping slots", async () => {
  const clients = runningClients();
  clients[1] = { role: "bn", running: false, exitCode: 137, oomKilled: true };
  await fixture(clients, async ({ controller, moves }) => {
    await controller.interval.set(10);
    const end = performance.now() + 2_000;
    while (controller.interval.ms !== 0 && performance.now() < end) await delay(10);
    assert.equal(controller.interval.ms, 0, "interval mining kept running without bn");
    lost("bn", 137, true)(controller.interval.error);
    assert.equal(moves(), 0);
  });
});

Deno.test("interval mining stops on a lost client even while another is stopped through the API", async () => {
  const clients = runningClients();
  clients[1] = { role: "bn", running: false, exitCode: 137, oomKilled: true };
  clients[2] = { role: "vc", running: false, exitCode: 137 };
  await fixture(clients, async ({ controller, network, moves }) => {
    network.stoppedClients.add("vc");
    await controller.interval.set(10);
    const end = performance.now() + 2_000;
    while (controller.interval.ms !== 0 && performance.now() < end) await delay(10);
    assert.equal(controller.interval.ms, 0, "the stopped vc hid the lost bn from interval mining");
    lost("bn", 137, true)(controller.interval.error);
    assert.equal(moves(), 0);
  });
});

Deno.test("the validator restart of a fast skip is not a lost client", async () => {
  const clients = runningClients();
  await fixture(clients, async ({ controller, network }) => {
    const docker = network.infra.docker;
    const get = docker.getContainer.bind(docker);
    let during: string | undefined = "not checked";
    docker.getContainer = ((reference: string) => ({
      ...get(reference),
      stop: async () => {
        clients[2] = { role: "vc", running: false, exitCode: 0 };
        during = await network.lostClient();
        throw new Error("end of the fixture");
      },
    })) as unknown as typeof docker.getContainer;
    await assert.rejects(
      network.skipValidator(controller.manifest, controller.time.nowMs + 12_000),
      /end of the fixture/,
    );
    assert.equal(during, undefined, "the skip's own VC stop was reported as lost");
    // A skip that ends without its replacement VC leaves a lost client.
    lost("vc", 0, false)(await network.lostClient());
  });
});

Deno.test("each time command checks clients with one Docker list scoped by the exact id", async () => {
  const clients = runningClients();
  await fixture(clients, async ({ controller, network, calls, moves }) => {
    const id = network.config.id;
    // The container a client restart replaced comes first; down/reset removes it at the latest.
    clients.unshift({ role: "bn", running: false, exitCode: 0, previous: true });
    // Another network whose id and container names start with this network's.
    clients.push({ role: "bn", running: false, exitCode: 137, oomKilled: true, id: `${id}-x` });
    await controller.command("stepSlot");
    await controller.command("advanceSlots", [3]);
    assert.equal(controller.time.slot, 4);
    assert.ok(moves() > 0);
    assert.equal(calls.list.length, 2, "expected one container list per time command");
    for (const labels of calls.list) {
      assert.ok(labels.includes(`${LABEL}=${id}`), `unscoped list: ${labels.join(", ")}`);
    }
    assert.deepEqual(calls.inspect, [], "running clients need no inspect");
  });
});

Deno.test("a failed Docker query refuses the time command without faulting the timeline", async () => {
  await fixture(runningClients(), async ({ controller, network, moves }) => {
    const docker = network.infra.docker;
    const list = docker.listContainers;
    docker.listContainers = (() =>
      Promise.reject(
        new Error("connect ENOENT /var/run/docker.sock"),
      )) as unknown as typeof docker.listContainers;
    await assert.rejects(controller.command("stepSlot"), /ENOENT/);
    assert.equal(moves(), 0);
    assert.equal(controller.lifecycle().recoveryRequired, false, "an unanswered query faulted");
    docker.listContainers = list;
    await controller.command("stepSlot");
    assert.equal(controller.time.slot, 1);
  });
});
