import assert from "node:assert/strict";
import {
  Consensus,
  executionAt,
  type ExecutionBlock,
  finalizedExecutionHash,
} from "../src/consensus.ts";
import { ForkSchedule } from "../src/forks.ts";
import { abortable, deadline } from "../src/http.ts";
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
    committee?: number[];
    envelope?: boolean;
    /**
     * The head is the Fulu genesis block of a network started at `time`. Its body carries an
     * all-zero payload, and the genesis state's execution header names `executionHash`. The
     * execution agreement then runs for real against the EL head `parentHash`.
     */
    fuluGenesis?: { time: number; executionHash: string };
  },
  run: (consensus: Consensus, paths: string[], calls: unknown[][]) => Promise<void>,
) {
  const headRoot = `0x${String(options.headSlot).padStart(2, "0").repeat(32)}`;
  const genesisTime = options.fuluGenesis?.time ?? 0;
  const zero = `0x${"00".repeat(32)}`;
  const paths: string[] = [];
  const calls: unknown[][] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    paths.push(path);
    if (path === "/" && request.method === "POST") {
      const body = await request.json();
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { hash: options.parentHash, timestamp: `0x${genesisTime.toString(16)}` },
      });
    }
    if (options.fuluGenesis && path.startsWith("/eth/v2/beacon/blocks/")) {
      // The Beacon API serves the genesis block with a default execution payload.
      return Response.json({
        version: "fulu",
        execution_optimistic: false,
        data: {
          message: {
            slot: "0",
            state_root: `0x${"5e".repeat(32)}`,
            body: { execution_payload: { block_number: "0", timestamp: "0", block_hash: zero } },
          },
        },
      });
    }
    if (options.fuluGenesis && path.startsWith("/eth/v2/debug/beacon/states/")) {
      return Response.json({
        version: "fulu",
        execution_optimistic: false,
        data: {
          slot: "0",
          latest_execution_payload_header: {
            block_number: "0",
            timestamp: String(genesisTime),
            block_hash: options.fuluGenesis.executionHash,
          },
        },
      });
    }
    if (path.endsWith("/headers/head")) {
      return Response.json({
        data: { root: headRoot, header: { message: { slot: String(options.headSlot) } } },
      });
    }
    if (path.startsWith("/eth/v2/beacon/blocks/")) {
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
    if (path.startsWith("/eth/v1/beacon/execution_payload_envelopes/")) {
      return options.envelope === false
        ? Response.json({ code: 404, message: "NOT_FOUND" }, { status: 404 })
        : Response.json({ data: { message: { payload: {} } } });
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
      config: { profile: "gloas", genesisTime },
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
        committees: [{ index: 0, validators: options.committee ?? [0, 1] }],
        pubkeys: new Map(),
        ...options.view,
      });
    consensus.control = control;
    consensus.aggregator = {
      publish: (...args: unknown[]) => {
        calls.push(["publish", ...args]);
        return Promise.resolve([]);
      },
      selectedAttestationAggregator: () => Promise.resolve(true),
    };
    consensus.consistency = (slot: number) => {
      calls.push(["consistency", slot]);
      return options.fuluGenesis
        ? Consensus.prototype.consistency.call(consensus, slot)
        : Promise.resolve({ hash: "checked" } as ExecutionBlock);
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

Deno.test("silent sync committee seats are aggregated by Chronix instead of direct sync", async () => {
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

/** Fail instead of hanging: a barrier that waits for a block that never comes runs for an hour. */
function bounded<T>(work: Promise<T>, ms = 10_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stalled for ${ms} ms`)), ms);
  });
  return Promise.race([work, stalled]).finally(() => clearTimeout(timer));
}

Deno.test("a recently changed proposer asking before its VC knows the key's index leaves the slot empty", async () => {
  await dutyFixture(
    {
      headSlot: 6,
      view: { uncertain: new Set([1]), proposer: 1, pubkeys: new Map([[1, "0xkey"]]) },
    },
    async (consensus, _paths, calls) => {
      // The key changed, then the VC asked for its block before it learned the index again.
      consensus.control!.invalidate(["0xkey"], 7);
      consensus.control!.observe("POST", "/eth/v4/validator/blocks/7", "sent");
      consensus.control!.observe("POST", "/eth/v4/validator/blocks/7", "answered");
      await bounded(consensus.move(7 * 12000, 0));
      assert.deepEqual(calls, [["consistency", 6]], "the slot is empty; the old head stays");
    },
  );
});

Deno.test("a VC that asks for a block before learning the key's index has settled once answered", () => {
  const control = new ValidatorControl();
  control.invalidate(["0xKEY"], 7);
  control.observe("POST", "/eth/v4/validator/blocks/7", "sent");
  assert.equal(control.proposalSettled(7, "0xkey"), false, "the request is still in flight");
  control.observeIndex("0xkey", true);
  control.observe("POST", "/eth/v4/validator/blocks/7", "answered");
  assert.equal(control.proposalSettled(7, "0xkey"), true, "the index came after the request");
});

Deno.test("a VC that knew the key's index is awaited until it publishes", () => {
  const control = new ValidatorControl();
  control.observeIndex("0xkey", true);
  control.observe("POST", "/eth/v4/validator/blocks/7", "sent");
  control.observe("POST", "/eth/v4/validator/blocks/7", "answered");
  assert.equal(control.proposalSettled(7, "0xkey"), false, "its block is expected");
  control.proposalGraceMs = 0;
  assert.equal(control.proposalSettled(7, "0xkey"), true, "answered long ago, nothing published");
  control.observe("POST", "/eth/v2/beacon/blocks", "sent");
  assert.equal(control.proposalSettled(7, "0xkey"), false, "a published block is on its way");
});

Deno.test("an invalid index answer does not count, and a key change forgets the index", () => {
  const control = new ValidatorControl();
  control.observeIndex("0xkey", false);
  control.observeIndex("0xother", true);
  control.invalidate(["0xother"], 3);
  for (const key of ["0xkey", "0xother"]) {
    control.observe("POST", "/eth/v4/validator/blocks/7", "sent");
    control.observe("POST", "/eth/v4/validator/blocks/7", "answered");
    assert.equal(control.proposalSettled(7, key), true, `${key} has no index in the VC`);
  }
});

Deno.test("a proposal the VC never asked for is awaited, and old attempts are forgotten", () => {
  const control = new ValidatorControl();
  control.proposalGraceMs = 0;
  assert.equal(control.proposalSettled(7, "0xkey"), false, "no request: keep the block barrier");
  control.observe("POST", "/eth/v4/validator/blocks/7", "sent");
  control.observe("POST", "/eth/v4/validator/blocks/7", "answered");
  control.observe("POST", "/eth/v4/validator/blocks/1000", "sent");
  assert.equal(control.proposalSettled(7, "0xkey"), false, "the slot 7 attempt was pruned");
});

Deno.test("re-aggregation after a restart republishes existing votes without requiring any", async () => {
  const seats = Array.from({ length: 512 }, (_, seat) => seat % 4);
  await dutyFixture(
    { headSlot: 0, view: { silent: new Set([3]), syncSeats: seats } },
    async (consensus, _paths, calls) => {
      await consensus.resumeAggregation(11_500);
      const publish = calls.find((call) => call[0] === "publish")!;
      const required = publish[6] as (index: number) => boolean;
      // Coverage was enforced when the slot ran; genesis has no sync votes at all.
      assert.deepEqual([0, 1, 2, 3].map(required), [false, false, false, false]);
    },
  );
});

Deno.test("large committees await aggregates only when an enabled member is selected", async () => {
  for (const selected of [true, false]) {
    await dutyFixture(
      { headSlot: 7, view: {}, committee: Array.from({ length: 32 }, (_, index) => index) },
      async (consensus, paths, calls) => {
        consensus.aggregator!.selectedAttestationAggregator = (...args: unknown[]) => {
          calls.push(["selected", ...args]);
          return Promise.resolve(selected);
        };
        await phases(consensus, 7);
        const waits = vcWaits(paths);
        assert.equal(waits.includes("/vc/wait/7/30000/aggregates_0"), selected);
        const call = calls.find((item) => item[0] === "selected")!;
        assert.equal(call[1], 7);
        assert.equal((call[2] as number[]).length, 32);
      },
    );
  }
});

Deno.test("small committees keep the established every-member-aggregates barrier", async () => {
  await dutyFixture({ headSlot: 7, view: {} }, async (consensus, paths) => {
    consensus.aggregator!.selectedAttestationAggregator = () => {
      throw new Error("no selection proofs for committees below 32 members");
    };
    await phases(consensus, 7);
    assert(vcWaits(paths).includes("/vc/wait/7/30000/aggregates_0"));
  });
});

Deno.test("pre-Gloas slots wait for Fulu duties and never for payload timeliness", async () => {
  await dutyFixture({ headSlot: 7, view: {} }, async (consensus, paths) => {
    consensus.schedule = new ForkSchedule(1, consensus.manifest.bake.recipe, {
      attestationMs: 4000,
      aggregateMs: 8001,
    });
    for (const phase of [0, 4000, 8001, 9000, 11500]) {
      await consensus.move(7 * 12000 + phase, phase);
    }
    assert.deepEqual(vcWaits(paths), [
      "/vc/wait/7/30000/attestations,sync_messages",
      "/vc/wait/7/30000/aggregates_0",
    ]);
  });
});

Deno.test("execution is read from the block body before Gloas and from envelopes after", async () => {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () =>
    Response.json({
      version: "fulu",
      execution_optimistic: false,
      data: {
        message: {
          slot: "3",
          body: { execution_payload: { block_hash: "0xabc", timestamp: "36" } },
        },
      },
    }));
  try {
    const m = {
      config: { profile: "gloas" },
      beacon: `http://127.0.0.1:${server.addr.port}`,
    } as unknown as Manifest;
    assert.deepEqual(await executionAt(m, "head"), { block_hash: "0xabc", timestamp: "36" });
    assert.equal(await finalizedExecutionHash(m), "0xabc");
  } finally {
    await server.shutdown();
  }
});

Deno.test("the first Gloas epoch does not await payload attestations the VC cannot know", async () => {
  for (const [slot, awaited] of [[32, false], [63, false], [64, true]] as const) {
    await dutyFixture({ headSlot: slot, view: {} }, async (consensus, paths) => {
      consensus.schedule = new ForkSchedule(1, consensus.manifest.bake.recipe, {
        attestationMs: 4000,
        aggregateMs: 8001,
      });
      await phases(consensus, slot);
      assert.equal(
        vcWaits(paths).includes(`/vc/wait/${slot}/30000/payload_attestations`),
        awaited,
        `slot ${slot}`,
      );
    });
  }
});

Deno.test("key changes within a slot refresh its duty view", async () => {
  await dutyFixture({ headSlot: 7, view: {} }, async (consensus) => {
    let views = 0;
    const view = consensus.control!.view;
    consensus.control!.view = (...args) => {
      views++;
      return view.apply(consensus.control!, args);
    };
    await consensus.move(7 * 12000, 0);
    await consensus.move(7 * 12000 + 3000, 3000);
    assert.equal(views, 1, "the view of one slot is reused");
    consensus.control!.invalidate();
    await consensus.move(7 * 12000 + 6000, 6000);
    assert.equal(views, 2, "a changed key set was not reconsidered");
  });
});

Deno.test("a missed slot after a withheld payload is recognized from the chain itself", async () => {
  // A fresh controller (no in-memory record) at slot 8 whose head is slot 7 with no envelope.
  await dutyFixture(
    {
      headSlot: 7,
      view: { proposer: 3, silent: new Set([3]) },
      parentHash: "0xparent",
      envelope: false,
    },
    async (consensus, _paths, calls) => {
      await consensus.move(8 * 12000, 0);
      assert.deepEqual(calls, [], "execution of a withheld head was read from a missing envelope");
    },
  );
});

/** Fail by a real deadline instead of the hour-long watchdog, and stop every wait of the move. */
async function moveWithin(consensus: Consensus, at: number, phase: number, ms = 2_000) {
  const abort = new AbortController();
  const moving = abortable(abort.signal, () => consensus.move(at, phase));
  try {
    await deadline(moving, ms, `move to ${at} at phase ${phase}`);
  } finally {
    abort.abort();
    await moving.catch(() => {});
  }
}

Deno.test("a missed slot on the Fulu genesis head checks the EL against the genesis execution header", async () => {
  const time = 2_000_000_000;
  const genesis = `0x${"9e".repeat(32)}`;
  for (const executionHash of [genesis, `0x${"77".repeat(32)}`]) {
    await dutyFixture(
      {
        // The proposer of slot 1 is an offline key, so the head stays at the genesis block.
        headSlot: 0,
        view: { proposer: 63, silent: new Set([63]) },
        parentHash: genesis,
        fuluGenesis: { time, executionHash },
      },
      async (consensus, paths, calls) => {
        consensus.schedule = new ForkSchedule(2, consensus.manifest.bake.recipe, {
          attestationMs: 4000,
          aggregateMs: 8001,
        });
        const moving = moveWithin(consensus, time * 1000 + 12_000, 0);
        if (executionHash === genesis) {
          await moving;
          assert.deepEqual(calls, [["consistency", 0]], "execution checked for the genesis head");
          // Every reader of the head's execution sees the genesis header, not the empty payload.
          assert.equal((await executionAt(consensus.manifest, "head")).block_hash, genesis);
        } else await assert.rejects(moving, /Timed out/, "another EL genesis was accepted");
        assert(paths.includes("/"), "the EL head was never compared");
      },
    );
  }
});

interface Registered {
  activation: number;
  exit?: number;
  /** Whether the VC holds an enabled key for the validator. */
  key: boolean;
}
/**
 * A beacon node whose head block lags the slot: after a fast jump whose destination has no block,
 * or at the first slot of an epoch before its block. As in Lighthouse, every state query reads the
 * head block's post-state (a slot from the head block up to the clock resolves to it) and answers
 * only what that state knows, while duty queries advance a state to the requested epoch, up to one
 * epoch (or sync committee period) past the beacon node's clock.
 */
async function laggingHeadFixture(
  options: {
    headSlot: number;
    /** The beacon node's clock until a move advances it; the head slot by default. */
    clockSlot?: number;
    registry: Registered[];
    /** The only committee of each slot. */
    committee: (slot: number) => number[];
    /** The 512 seats of each sync committee period. */
    seats: (period: number) => number[];
  },
  run: (fixture: {
    consensus: Consensus;
    control: ValidatorControl;
    manifest: Manifest;
    paths: string[];
    setHead: (slot: number) => void;
  }) => Promise<void>,
) {
  let headSlot = options.headSlot;
  let clockSlot = options.clockSlot ?? options.headSlot;
  const headEpoch = () => Math.floor(headSlot / 32);
  const period = (epoch: number) => Math.floor(epoch / 256);
  const pubkey = (index: number) => `0x${index.toString(16).padStart(96, "0")}`;
  const status = ({ activation, exit }: Registered) =>
    activation > headEpoch()
      ? "pending_queued"
      : exit !== undefined && exit <= headEpoch()
      ? "exited_unslashed"
      : "active_ongoing";
  const refuse = (message: string) =>
    Response.json({ code: 400, message: `BAD_REQUEST: ${message}` }, { status: 400 });
  const directory = await Deno.makeTempDir();
  await Deno.mkdir(`${directory}/validator-keys/keys`, { recursive: true });
  await Deno.writeTextFile(`${directory}/validator-keys/keys/api-token.txt`, "token\n");
  const paths: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    paths.push(path + url.search);
    const epoch = Number(url.searchParams.get("epoch"));
    if (path === "/lighthouse/validators") {
      return Response.json({
        data: options.registry.flatMap(({ key }, index) =>
          key ? [{ voting_pubkey: pubkey(index), enabled: true }] : []
        ),
      });
    }
    if (/^\/eth\/v1\/beacon\/states\/[^/]+\/validators$/.test(path)) {
      return Response.json({
        data: options.registry.map((entry, index) => ({
          index: String(index),
          status: status(entry),
          validator: {
            pubkey: pubkey(index),
            activation_epoch: String(entry.activation),
            exit_epoch: String(entry.exit ?? 2n ** 64n - 1n),
          },
        })),
      });
    }
    // A state knows the sync committees of its own period and the next one.
    if (/^\/eth\/v1\/beacon\/states\/[^/]+\/sync_committees$/.test(path)) {
      return period(epoch) > period(headEpoch()) + 1
        ? refuse(`state at epoch ${headEpoch()} has no sync committee for epoch ${epoch}`)
        : Response.json({ data: { validators: options.seats(period(epoch)).map(String) } });
    }
    // Committees up to the state's next epoch.
    if (/^\/eth\/v1\/beacon\/states\/[^/]+\/committees$/.test(path)) {
      const slot = Number(url.searchParams.get("slot"));
      return epoch > headEpoch() + 1
        ? refuse(`epoch ${epoch} out of bounds for state at ${headEpoch()}`)
        : Response.json({
          data: [{
            index: "0",
            slot: String(slot),
            validators: options.committee(slot).map(String),
          }],
        });
    }
    const duty = /^\/eth\/v1\/validator\/duties\/(proposer|attester|sync|ptc)\/(\d+)$/.exec(path);
    if (duty) {
      const [, kind, requested] = duty;
      const current = Math.floor(clockSlot / 32);
      if (
        kind === "sync"
          ? period(Number(requested)) > period(current) + 1
          : Number(requested) > current + 1
      ) {
        return refuse(`request epoch ${requested} is more than one epoch past epoch ${current}`);
      }
      const slots = Array.from({ length: 32 }, (_, offset) => Number(requested) * 32 + offset);
      if (kind === "proposer") {
        return Response.json({
          data: slots.map((slot) => {
            const index = slot % options.registry.length;
            return { pubkey: pubkey(index), validator_index: String(index), slot: String(slot) };
          }),
        });
      }
      const indices = new Set((await request.json() as string[]).map(Number));
      if (kind === "sync") {
        const seats = options.seats(period(Number(requested)));
        return Response.json({
          data: [...indices].filter((index) => seats.includes(index)).map((index) => ({
            pubkey: pubkey(index),
            validator_index: String(index),
            validator_sync_committee_indices: seats.flatMap((seat, position) =>
              seat === index ? [String(position)] : []
            ),
          })),
        });
      }
      // Attester duties, and payload timeliness duties drawn from the same committees.
      return Response.json({
        data: slots.flatMap((slot) => {
          const committee = options.committee(slot);
          return committee.flatMap((index, position) =>
            indices.has(index)
              ? [{
                pubkey: pubkey(index),
                validator_index: String(index),
                slot: String(slot),
                ...(kind === "attester"
                  ? {
                    committee_index: "0",
                    committee_length: String(committee.length),
                    committees_at_slot: "1",
                    validator_committee_index: String(position),
                  }
                  : {}),
              }]
              : []
          );
        }),
      });
    }
    if (path === "/eth/v1/beacon/headers/head") {
      return Response.json({
        data: { root: `0x${"11".repeat(32)}`, header: { message: { slot: String(headSlot) } } },
      });
    }
    const wait = /^\/(bn|vc)\/wait\/(\d+)\/\d+\/(.+)$/.exec(path);
    if (wait) {
      return Response.json({
        marks: Object.fromEntries(wait[3].split(",").map((name) => [name, Number(wait[2])])),
      });
    }
    const advance = /^\/bn\/advance\/(\d+)$/.exec(path);
    if (advance) clockSlot = Math.floor(Number(advance[1]) / 12_000);
    return Response.json({ nowMs: 0, marks: {} });
  });
  const endpoint = `http://127.0.0.1:${server.addr.port}`;
  try {
    const manifest = {
      config: { profile: "gloas", genesisTime: 0 },
      bake: { recipe: { clockWait: true, attestationMs: 3000, aggregateMs: 6000 } },
      directory,
      vc: endpoint,
      el: endpoint,
      beacon: endpoint,
      bnClock: `${endpoint}/bn`,
      vcClock: `${endpoint}/vc`,
    } as unknown as Manifest;
    const consensus = new Consensus(manifest);
    const control = new ValidatorControl();
    consensus.control = control;
    consensus.aggregator = {
      publish: () => Promise.resolve([]),
      selectedAttestationAggregator: () => Promise.resolve(true),
    };
    await run({
      consensus,
      control,
      manifest,
      paths,
      setHead: (slot) => {
        headSlot = slot;
      },
    });
  } finally {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
}
const rotatingSeats = (period: number) =>
  Array.from({ length: 512 }, (_, seat) => (seat + period) % 8);
/** Validators 6 and 7 are active but have no key in the VC. */
const keyless = Array.from({ length: 8 }, (_, index) => ({ activation: 0, key: index < 6 }));

Deno.test("the slot view after a fast jump over two sync committee periods has the destination's committee", async () => {
  // The head block stays at slot 1561 (epoch 48, sync period 0) while a 72-hour fast jump ends at
  // slot 23161 (epoch 723, sync period 2), as on a stand with keys that Chronix does not manage.
  await laggingHeadFixture(
    {
      headSlot: 1561,
      clockSlot: 23161,
      registry: keyless,
      committee: (slot) => [slot % 6, 6 + slot % 2],
      seats: rotatingSeats,
    },
    async ({ control, manifest }) => {
      const view = await control.view(manifest, 23161);
      assert(view);
      assert.deepEqual([...view.silent].sort(), [6, 7]);
      assert.deepEqual(view.syncSeats, rotatingSeats(2));
    },
  );
});

Deno.test("attestation barriers of an empty slot epochs after the head block read that slot's committee", async () => {
  // A 100-slot fast jump stays in sync period 0, but its destination proposer is silent: the head
  // block stays at slot 1561 (epoch 48) while slot 1661 is in epoch 51.
  await laggingHeadFixture(
    {
      headSlot: 1561,
      registry: keyless,
      committee: (slot) => [slot % 6, 6 + slot % 2],
      seats: rotatingSeats,
    },
    async ({ consensus, paths }) => {
      await consensus.move(1661 * 12000 + 3000, 3000);
      // The committee of slot 1661 is {5, 7}; validator 5 has an enabled key.
      assert.deepEqual(vcWaits(paths), ["/vc/wait/1661/30000/attestations,sync_messages"]);
    },
  );
});

Deno.test("a validator activating at an epoch boundary without a VC key is never awaited", async () => {
  // The first view of epoch 49 runs at slot 1568 before its block, on the head state of epoch 48.
  // Validators 4, 5 and 6 have no key, and 6 activates at epoch 49. They alone form the committee
  // of slot 1582, so the VC has no attestation duty there and never sets that mark.
  const registry = [
    ...Array.from({ length: 4 }, () => ({ activation: 0, key: true })),
    { activation: 45, key: false },
    { activation: 48, key: false },
    { activation: 49, key: false },
  ];
  await laggingHeadFixture(
    {
      headSlot: 1567,
      registry,
      committee: (slot) => slot === 1582 ? [4, 5, 6] : [slot % 4, 4],
      seats: () => Array.from({ length: 512 }, (_, seat) => seat % 4),
    },
    async ({ consensus, paths, setHead }) => {
      await consensus.move(1568 * 12000 + 3000, 3000);
      setHead(1581);
      await consensus.move(1582 * 12000 + 3000, 3000);
      assert.deepEqual(vcWaits(paths), [
        "/vc/wait/1568/30000/attestations,sync_messages",
        "/vc/wait/1582/30000/sync_messages",
      ]);
    },
  );
});

Deno.test("a sync committee seat of an exited validator without a VC key is silent", async () => {
  // Validator 4 exited at epoch 40 and its key is gone, but it keeps its seats until the period
  // ends. Every other validator signs; without this silent seat direct sync waits for all 512.
  const registry = [
    ...Array.from({ length: 4 }, () => ({ activation: 0, key: true })),
    { activation: 0, exit: 40, key: false },
  ];
  await laggingHeadFixture(
    {
      headSlot: 1567,
      clockSlot: 1568,
      registry,
      committee: (slot) => [slot % 4],
      seats: () => Array.from({ length: 512 }, (_, seat) => seat % 5),
    },
    async ({ control, manifest }) => {
      const view = await control.view(manifest, 1568);
      assert(view, "the barriers would wait for votes of a seat that never signs");
      assert(view.silent.has(4));
      assert(view.syncSeats.includes(4));
    },
  );
});

Deno.test("without a slot view, committees are read only from a head block at that slot", async () => {
  // Every validator signs, so there is no view; a head block epochs behind cannot give them.
  await laggingHeadFixture(
    {
      headSlot: 1561,
      registry: Array.from({ length: 8 }, () => ({ activation: 0, key: true })),
      committee: (slot) => [slot % 8],
      seats: rotatingSeats,
    },
    async ({ consensus }) => {
      await assert.rejects(
        consensus.move(1661 * 12000 + 3000, 3000),
        /Head block at slot 1561 cannot give the committees of slot 1661/,
      );
    },
  );
});

Deno.test("a committee member or sync seat holder outside the registry fails the slot view", async () => {
  // Validator 8 is not in the registry, so no duty query returns it. Its committee position and
  // its seats stay unfilled; the view fails instead of dropping a member that may have to act.
  const cases = [
    {
      committee: (slot: number) => [slot % 6, 8],
      seats: rotatingSeats,
      error: /Committee 0 at slot 1568 has no member at position 1/,
    },
    {
      committee: (slot: number) => [slot % 6, 6 + slot % 2],
      seats: () => Array.from({ length: 512 }, (_, seat) => seat % 9),
      error: /Sync committee seat 8 for epoch 49 has no holder/,
    },
  ];
  for (const { committee, seats, error } of cases) {
    await laggingHeadFixture(
      { headSlot: 1567, clockSlot: 1568, registry: keyless, committee, seats },
      async ({ control, manifest }) => {
        await assert.rejects(control.view(manifest, 1568), error);
      },
    );
  }
});
