import assert from "node:assert/strict";
import { Consensus, type ExecutionBlock } from "../src/consensus.ts";
import { type Manifest, Network } from "../src/network.ts";
import { type ScheduledFault, type SlotView, ValidatorControl } from "../src/validator_control.ts";

const root = `0x${"ab".repeat(32)}`;

async function clockFixture(
  nativeWait: boolean,
  response: (path: string) => Response,
  test: (consensus: Consensus, endpoint: string, paths: string[]) => Promise<void>,
) {
  const paths: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return response(path);
  });
  try {
    const manifest = { bake: { recipe: { clockWait: nativeWait } } } as unknown as Manifest;
    await test(new Consensus(manifest), `http://127.0.0.1:${server.addr.port}`, paths);
  } finally {
    await server.shutdown();
  }
}

Deno.test("native completion barrier replaces mark polling", async () => {
  await clockFixture(
    true,
    () => Response.json({ nowMs: 123, marks: { proposal: 7, execution: 7 } }),
    async (consensus, endpoint, paths) => {
      await consensus.mark(endpoint, ["proposal", "execution"], 7);
      assert.deepEqual(paths, ["/wait/7/30000/proposal,execution"]);
    },
  );
});

Deno.test("legacy bakes keep their existing mark protocol", async () => {
  await clockFixture(
    false,
    () => Response.json({ nowMs: 123, marks: { proposal: 7 } }),
    async (consensus, endpoint, paths) => {
      await consensus.mark(endpoint, ["proposal"], 7);
      assert.deepEqual(paths, ["/"]);
    },
  );
});

Deno.test("native barrier must confirm every requested completion at the exact slot", async () => {
  for (const marks of [{ proposal: 7 }, { proposal: 7, execution: 8 }]) {
    await clockFixture(
      true,
      (path) =>
        Response.json({
          nowMs: 123,
          marks: path === "/" ? { proposal: 7, execution: 7 } : marks,
        }),
      async (consensus, endpoint) => {
        await assert.rejects(consensus.mark(endpoint, ["proposal", "execution"], 7));
      },
    );
  }
});

Deno.test("native barrier timeout is a failure, not a polling fallback", async () => {
  await clockFixture(
    true,
    (path) =>
      path === "/"
        ? Response.json({ nowMs: 123, marks: { proposal: 7 } })
        : new Response("unfinished phase", { status: 408 }),
    async (consensus, endpoint, paths) => {
      await assert.rejects(consensus.mark(endpoint, ["proposal"], 7, 30_000));
      assert.equal(paths.length, 1);
    },
  );
});

async function restartedPayloadFixture(
  payload: (attempt: number) => Response | Promise<Response>,
  test: (consensus: Consensus, paths: string[]) => Promise<void>,
) {
  const slot = 8193;
  const paths: string[] = [];
  let attempts = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path.endsWith("/payload_attestations")) return payload(++attempts);
    return Response.json({ marks: { state_advance: slot, fork_choice: slot } });
  });
  const skipValidator = Network.prototype.skipValidator;
  // Isolate the controller's post-restart wait policy; no mock establishes CL compatibility.
  Network.prototype.skipValidator = () => Promise.resolve();
  try {
    const endpoint = `http://127.0.0.1:${server.addr.port}`;
    const manifest = {
      config: { id: "unit-restarted-payload", profile: "gloas", genesisTime: 0 },
      bake: { recipe: { clockWait: true, preparedSkip: true } },
      bnClock: `${endpoint}/bn`,
      vcClock: `${endpoint}/vc`,
    } as unknown as Manifest;
    await test(new Consensus(manifest), paths);
  } finally {
    Network.prototype.skipValidator = skipValidator;
    await server.shutdown();
  }
}

Deno.test("post-restart payload barrier accepts completion after native 30-second timeouts", async () => {
  await restartedPayloadFixture(
    (attempt) =>
      Response.json({ marks: attempt < 4 ? {} : { payload_attestations: 8193 } }, {
        status: attempt < 4 ? 408 : 200,
      }),
    async (consensus, paths) => {
      await consensus.skip(8192 * 12000);
      await consensus.move(8193 * 12000 + 9000, 9000);
      assert.deepEqual(paths, [
        `/bn/advance/${8193 * 12000 + 9000}`,
        `/vc/advance/${8193 * 12000 + 9000}`,
        ...Array(4).fill("/vc/wait/8193/30000/payload_attestations"),
        "/bn/wait/8193/30000/state_advance",
      ]);
    },
  );
});

Deno.test("post-restart payload barrier fails after the configured native wait budget without advancing time", async () => {
  await restartedPayloadFixture(
    () => Response.json({ marks: { attestations: 8193 } }, { status: 408 }),
    async (consensus, paths) => {
      await consensus.skip(8192 * 12000);
      await assert.rejects(consensus.move(8193 * 12000 + 9000, 9000), /408/);
      assert.equal(paths.filter((path) => path.endsWith("/payload_attestations")).length, 120);
      assert.equal(paths.filter((path) => path.includes("/advance/")).length, 2);
      assert(!paths.some((path) => path.endsWith("/state_advance") || path === "/vc"));
    },
  );
});

Deno.test("post-restart payload barrier does not retry non-timeout errors or wrong marks", async () => {
  for (const status of [400, 409, 500, 200]) {
    await restartedPayloadFixture(
      () => Response.json({ marks: { payload_attestations: 8194 } }, { status }),
      async (consensus, paths) => {
        await consensus.skip(8192 * 12000);
        await assert.rejects(consensus.move(8193 * 12000 + 9000, 9000));
        assert.equal(paths.filter((path) => path.endsWith("/payload_attestations")).length, 1);
      },
    );
  }
});

Deno.test("post-restart payload barrier has one total real-time deadline", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  let budgets = 0;
  // Compress only the hour-long budget; exercise real HTTP cancellation without a one-hour test.
  AbortSignal.timeout = (ms) => {
    if (ms === 3_600_000) budgets++;
    return timeout(ms === 3_600_000 ? 20 : ms);
  };
  try {
    await restartedPayloadFixture(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return Response.json({ marks: { payload_attestations: 8193 } });
      },
      async (consensus, paths) => {
        await consensus.skip(8192 * 12000);
        await assert.rejects(
          consensus.move(8193 * 12000 + 9000, 9000),
          /Timed out.*8193.*payload_attestations.*3600000/,
        );
        assert(budgets >= 1);
        assert.equal(paths.filter((path) => path.endsWith("/payload_attestations")).length, 1);
      },
    );
  } finally {
    AbortSignal.timeout = timeout;
  }
});

Deno.test("ordinary native barriers also survive repeated 30-second waits", async () => {
  let attempts = 0;
  await clockFixture(true, () => {
    attempts++;
    return Response.json({ marks: { proposal: 7 } }, { status: attempts <= 5 ? 408 : 200 });
  }, async (consensus, endpoint, paths) => {
    await consensus.mark(endpoint, ["proposal"], 7);
    assert.equal(paths.length, 6);
  });
});

Deno.test("direct sync requires BN coverage for the current root, independently of VC success", async () => {
  const root = `0x${"12".repeat(32)}`;
  for (const scenario of ["complete", "missing", "changed head"]) {
    let headers = 0;
    const paths: string[] = [];
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/committees")) return Response.json({ data: [] });
      if (path.endsWith("/headers/head")) {
        const currentRoot = scenario === "changed head" && headers++ > 0
          ? `0x${"34".repeat(32)}`
          : root;
        return Response.json({ data: { root: currentRoot, header: { message: { slot: "7" } } } });
      }
      if (path === "/bn/wait/7/30000/slot") return Response.json({ marks: { slot: 7 } });
      if (path.startsWith("/bn/wait/")) {
        // A complete set for another root at this very same slot is insufficient.
        return Response.json({
          marks: {
            [
              `sync_contributions_${
                scenario === "missing" ? "0xdead" : path.split("sync_contributions_")[1]
              }`
            ]: 7,
          },
        });
      }
      return Response.json({ marks: { attestations: 7, sync_messages: 7 } });
    });
    const endpoint = `http://127.0.0.1:${server.addr.port}`;
    try {
      const manifest = {
        config: { profile: "gloas", genesisTime: 0 },
        bake: { recipe: { clockWait: true, directSync: true, attestationMs: 3000 } },
        beacon: endpoint,
        bnClock: `${endpoint}/bn`,
        vcClock: `${endpoint}/vc`,
      } as unknown as Manifest;
      const consensus = new Consensus(manifest);
      // Execution for the phase-0 head is valid; a later head has not been checked.
      consensus.consistency = () =>
        Promise.resolve({ hash: "valid-phase-0-execution" } as ExecutionBlock);
      await consensus.move(7 * 12000, 0);
      const advancing = consensus.move(7 * 12000 + 3000, 3000);
      if (scenario === "complete") await advancing;
      else await assert.rejects(advancing, /Incomplete native barrier|head changed/i);
      if (scenario !== "changed head") {
        assert(paths.includes(`/bn/wait/7/30000/sync_contributions_${root}`));
      }
    } finally {
      await server.shutdown();
    }
  }
});

// Duty-aware barriers. HTTP adapter fixtures only; real clients are covered by the
// validators scenario.
async function dutyFixture(
  options: {
    headSlot: number;
    view: Partial<SlotView>;
    schedule?: [ScheduledFault, number][];
    parentHash?: string;
  },
  run: (consensus: Consensus, paths: string[], calls: unknown[][]) => Promise<void>,
) {
  const headRoot = `0x${String(options.headSlot).padStart(2, "0").repeat(32)}`;
  const paths: string[] = [];
  const calls: unknown[][] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    paths.push(path + (path.startsWith("/eth/v1/beacon/states/head/committees") ? url.search : ""));
    if (path === "/" && request.method === "POST") {
      const body = await request.json();
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { hash: options.parentHash, timestamp: "0x0" },
      });
    }
    if (path.endsWith("/committees")) {
      return Response.json({ data: [{ index: "0", validators: ["0", "1"] }] });
    }
    if (path.endsWith("/headers/head")) {
      return Response.json({
        data: { root: headRoot, header: { message: { slot: String(options.headSlot) } } },
      });
    }
    if (path === "/eth/v2/beacon/blocks/head") {
      return Response.json({
        execution_optimistic: false,
        data: {
          message: {
            slot: String(options.headSlot),
            body: {
              signed_execution_payload_bid: {
                message: { parent_block_hash: options.parentHash, block_hash: "0xnew" },
              },
            },
          },
        },
      });
    }
    const wait = /^\/(bn|vc)\/wait\/(\d+)\/\d+\/(.+)$/.exec(path);
    if (wait) {
      return Response.json({
        marks: Object.fromEntries(wait[3].split(",").map((name) => [name, Number(wait[2])])),
      });
    }
    return Response.json({ nowMs: 0, marks: {} });
  });
  const endpoint = `http://127.0.0.1:${server.addr.port}`;
  try {
    const manifest = {
      config: { profile: "gloas", genesisTime: 0 },
      bake: {
        recipe: { clockWait: true, directSync: true, attestationMs: 3000, aggregateMs: 6000 },
      },
      el: endpoint,
      beacon: endpoint,
      bnClock: `${endpoint}/bn`,
      vcClock: `${endpoint}/vc`,
    } as unknown as Manifest;
    const consensus = new Consensus(manifest);
    const control = new ValidatorControl();
    for (const [kind, slot] of options.schedule ?? []) control.schedule(kind, slot, 0);
    control.view = () =>
      Promise.resolve({
        silent: new Set<number>(),
        uncertain: new Set<number>(),
        proposer: 1,
        syncSeats: Array(512).fill(1),
        ptc: [1],
        pubkeys: new Map(),
        ...options.view,
      });
    consensus.control = control;
    consensus.aggregator = {
      publish: (...args: unknown[]) => {
        calls.push(["publish", ...args]);
        return Promise.resolve([]);
      },
    };
    consensus.consistency = (slot: number) => {
      calls.push(["consistency", slot]);
      return Promise.resolve({ hash: "checked" } as ExecutionBlock);
    };
    await run(consensus, paths, calls);
  } finally {
    await server.shutdown();
  }
}
const phases = async (consensus: Consensus, slot: number) => {
  for (const phase of [0, 3000, 6000, 9000, 11500]) {
    await consensus.move(slot * 12000 + phase, phase);
  }
};
const vcWaits = (paths: string[]) => paths.filter((path) => path.startsWith("/vc/wait/"));

Deno.test("a missed proposal keeps the previous head and skips the PTC mark of that slot", async () => {
  await dutyFixture(
    { headSlot: 6, view: {}, schedule: [["missProposal", 7]] },
    async (consensus, paths, calls) => {
      consensus.control!.relay("POST", "/eth/v4/validator/blocks/7");
      await phases(consensus, 7);
      assert.deepEqual(calls, [["consistency", 6]], "execution checked for the existing head");
      assert(paths.includes(`/bn/wait/7/30000/sync_contributions_0x${"06".repeat(32)}`));
      assert.deepEqual(vcWaits(paths), [
        "/vc/wait/7/30000/attestations,sync_messages",
        "/vc/wait/7/30000/aggregates_0",
      ]);
    },
  );
});

Deno.test("silent validators have no expected duty marks; their proposal is missed", async () => {
  await dutyFixture(
    {
      headSlot: 6,
      view: { silent: new Set([0, 1]), proposer: 0, ptc: [0], syncSeats: Array(512).fill(2) },
    },
    async (consensus, paths, calls) => {
      await phases(consensus, 7);
      assert.deepEqual(calls, [["consistency", 6]]);
      // Committee {0,1} is silent; the sync committee (all seats validator 2) still signs.
      assert.deepEqual(vcWaits(paths), ["/vc/wait/7/30000/sync_messages"]);
    },
  );
});

Deno.test("a withheld payload keeps EL at the bid parent and still runs the slot's PTC", async () => {
  await dutyFixture(
    { headSlot: 7, view: {}, schedule: [["withholdPayload", 7]], parentHash: "0xparent" },
    async (consensus, paths, calls) => {
      consensus.control!.relay("GET", `/eth/v1/validator/execution_payload_envelopes/7/${root}`);
      await phases(consensus, 7);
      assert.deepEqual(calls, [], "a withheld envelope cannot be read as the head's execution");
      assert(paths.includes(`/bn/wait/7/30000/sync_contributions_0x${"07".repeat(32)}`));
      assert.deepEqual(vcWaits(paths), [
        "/vc/wait/7/30000/attestations,sync_messages",
        "/vc/wait/7/30000/aggregates_0",
        "/vc/wait/7/30000/payload_attestations",
      ]);
    },
  );
  await dutyFixture(
    { headSlot: 7, view: {}, schedule: [["withholdPayload", 7]], parentHash: "0xother" },
    async (consensus) => {
      consensus.control!.relay("GET", `/eth/v1/validator/execution_payload_envelopes/7/${root}`);
      // The fixture's EL head differs from the bid parent only through parentHash; emulate a
      // payload that was nevertheless executed by reporting a different EL head.
      consensus.executionHead = () => Promise.resolve("0xexecuted");
      await assert.rejects(consensus.move(7 * 12000, 0), /withheld payload/i);
    },
  );
});

Deno.test("silent sync committee seats are aggregated by Panda instead of direct sync", async () => {
  const seats = Array.from({ length: 512 }, (_, seat) => seat % 4);
  await dutyFixture(
    { headSlot: 7, view: { silent: new Set([3]), proposer: 1, syncSeats: seats } },
    async (consensus, paths, calls) => {
      await phases(consensus, 7);
      assert.deepEqual(calls[0], ["consistency", 7]);
      assert.equal(calls[1][0], "publish");
      assert.equal(calls[1][1], 7);
      assert.equal(calls[1][2], `0x${"07".repeat(32)}`);
      assert.deepEqual(calls[1][3], seats);
      assert(!paths.some((path) => path.includes("sync_contributions_")));
    },
  );
});

Deno.test("recently changed keys may vote but are never awaited until the VC refreshes", async () => {
  await dutyFixture(
    {
      headSlot: 7,
      view: { uncertain: new Set([0, 1]), proposer: 2, ptc: [1], syncSeats: Array(512).fill(2) },
    },
    async (consensus, paths) => {
      await phases(consensus, 7);
      // Committee {0,1} and the PTC member just changed; only the stable sync seats are required.
      assert.deepEqual(vcWaits(paths), ["/vc/wait/7/30000/sync_messages"]);
    },
  );
});

Deno.test("committees of a missed epoch-boundary slot are read for that slot's epoch", async () => {
  await dutyFixture(
    { headSlot: 31, view: {}, schedule: [["missProposal", 32]] },
    async (consensus, paths) => {
      consensus.control!.relay("POST", "/eth/v4/validator/blocks/32");
      await phases(consensus, 32);
      // The head state is still in epoch 0; without the epoch the beacon node rejects slot 32.
      const committees = paths.filter((path) => path.includes("/committees"));
      assert(committees.length > 0);
      for (const path of committees) assert.match(path, /\?epoch=1&slot=32$/);
    },
  );
});
