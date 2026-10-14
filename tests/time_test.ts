import assert from "node:assert/strict";
import { Timeline } from "../src/time.ts";

Deno.test("forward time executes phase barriers, exact dates and partial slots", async () => {
  const phases: [number, number | undefined][] = [];
  const time = new Timeline(0, 11_500, {
    move: (at, phase) => {
      phases.push([at, phase]);
      return Promise.resolve();
    },
  });
  await time.advanceTime(12);
  assert.equal(time.nowMs, 23_500);
  assert.deepEqual(phases.map((p) => p[1]), [0, 4000, 6000, 8000, 9000, 11500]);
  await time.advanceTo(24.25);
  assert.equal(time.nowMs, 24_250);
  assert.equal(time.slot, 2);
  await assert.rejects(time.advanceTo(24), /forward/);
  await time.advanceTime(0.75);
  assert.equal(time.nowMs, 25_000);
});
Deno.test("concurrent advances serialize and accumulate, rather than lose time", async () => {
  let active = 0;
  const time = new Timeline(0, 11_500, {
    async move() {
      assert.equal(++active, 1);
      await Promise.resolve();
      active--;
    },
  });
  await Promise.all(Array.from({ length: 20 }, () => time.stepSlot()));
  assert.equal(time.slot, 20);
  assert.equal(time.nowMs, 251_500);
});
Deno.test("a partially failed clock update faults subsequent mutations", async () => {
  let calls = 0;
  const time = new Timeline(0, 11_500, {
    move() {
      calls++;
      throw new Error("VC disconnected after BN advanced");
    },
  });
  await assert.rejects(time.stepSlot(), /disconnected/);
  await assert.rejects(time.stepSlot(), /reset required/);
  assert.equal(calls, 1);
});
Deno.test("advanceUntil is bounded, detects existing success and processes epochs", async () => {
  const time = new Timeline(0, 11_500, { move: () => Promise.resolve() });
  assert.equal(await time.advanceUntil(() => Promise.resolve(true), { maxSlots: 0 }), 0);
  await assert.rejects(time.advanceUntil(() => Promise.resolve(false), { maxSlots: 2 }), /limit/);
  assert.equal(time.slot, 2);
  await time.advanceEpochs(1);
  assert.equal(time.slot, 34);
});
Deno.test("skip has separate semantics and does not execute intervening duties", async () => {
  let moves = 0, skips = 0;
  const time = new Timeline(0, 11_500, {
    move: () => {
      moves++;
      return Promise.resolve();
    },
    skip: () => {
      skips++;
      return Promise.resolve();
    },
  });
  await time.skipSlots(8192);
  assert.equal(time.slot, 8192);
  assert.equal(moves, 0);
  assert.equal(skips, 1);
  await time.stepSlot();
  assert.equal(moves, 6);
});

Deno.test("shutdown interrupts a long advance at the next phase boundary", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let moves = 0;
  const time = new Timeline(0, 11_500, {
    async move() {
      moves++;
      entered.resolve();
      await release.promise;
    },
  });
  const advancing = time.advanceSlots(1000);
  await entered.promise;
  time.stop();
  release.resolve();
  await assert.rejects(advancing, /stopping/);
  assert.equal(moves, 1);
});

Deno.test("large advanceTime/advanceTo execute every slot and preserve partial-slot targets", async () => {
  const moves: [number, number | undefined][] = [];
  const skips: number[] = [];
  const time = new Timeline(0, 4_000, {
    move: (at, phase) => {
      moves.push([at, phase]);
      return Promise.resolve();
    },
    skip: (at) => {
      skips.push(at);
      return Promise.resolve();
    },
  });
  await time.advanceTime(8192 * 12);
  assert.equal(time.nowMs, 8192 * 12000 + 4000);
  assert.deepEqual(skips, [], "advanceTime must not model validator downtime");
  assert.deepEqual(
    moves.filter(([, phase]) => phase === 0).map(([at]) => at),
    Array.from({ length: 8192 }, (_, i) => (i + 1) * 12000),
  );
  assert.deepEqual(moves.slice(0, 4), [[6000, 6000], [8000, 8000], [9000, 9000], [11500, 11500]]);
  await time.advanceTo(16384 * 12 + 0.25);
  assert.equal(time.nowMs, 16384 * 12000 + 250);
  assert.equal(skips.length, 0);
  assert.equal(moves.filter(([, phase]) => phase === 0).length, 16384);
  assert.deepEqual(moves.at(-1), [16384 * 12000 + 250, undefined]);
  await assert.rejects(time.advanceTo(1), /forward/);
  await time.advanceTo(16384 * 12 + 11.999);
  await time.advanceTime(8192 * 12);
  assert.equal(time.nowMs, 24576 * 12000 + 11999);
});

Deno.test("failed explicit skip faults the timeline and continuous advancement never skips", async () => {
  let skips = 0;
  const time = new Timeline(0, 11500, {
    move: () => Promise.resolve(),
    skip: () => {
      skips++;
      throw new Error("skip interrupted");
    },
  });
  await time.advanceEpochs(2);
  assert.equal(skips, 0);
  await assert.rejects(time.skipSlots(8192), /skip interrupted/);
  await assert.rejects(time.stepSlot(), /reset required/);
});

Deno.test("fast warp finishes current duties, skips the gap and produces the exact destination", async () => {
  const moves: [number, number | undefined][] = [];
  const skips: number[] = [];
  const time = new Timeline(0, 4000, {
    move: (at, phase) => {
      moves.push([at, phase]);
      return Promise.resolve();
    },
    skip: (at) => {
      skips.push(at);
      return Promise.resolve();
    },
  });
  const advance = time.advanceTime.bind(time);
  const to = time.advanceTo.bind(time);
  await advance(8192 * 12, { mode: "fast" });
  assert.deepEqual(skips, [8191 * 12000 + 11500]);
  assert.deepEqual(moves.filter(([, phase]) => phase === 0), [[8192 * 12000, 0]]);
  assert.deepEqual(moves.slice(0, 4), [[6000, 6000], [8000, 8000], [9000, 9000], [11500, 11500]]);
  assert.equal(time.nowMs, 8192 * 12000 + 4000);
  await to(16384 * 12 + 0.25, { mode: "fast" });
  assert.equal(time.nowMs, 16384 * 12000 + 250);
  assert.equal(skips.length, 2);
  assert.deepEqual(moves.at(-1), [16384 * 12000 + 250, undefined]);
  await assert.rejects(to(1, { mode: "fast" }), /forward/);
  assert.equal(skips.length, 2);
});

Deno.test("fast warp preserves small jumps and mixed modes share one serialized timeline", async () => {
  const slots: number[] = [];
  const skips: number[] = [];
  const time = new Timeline(0, 11500, {
    move: (at, phase) => {
      if (phase === 0) slots.push(at / 12000);
      return Promise.resolve();
    },
    skip: (at) => {
      skips.push(at);
      return Promise.resolve();
    },
  });
  const advance = time.advanceTime.bind(time);
  await advance(32 * 12, { mode: "fast" });
  assert.equal(skips.length, 0);
  assert.equal(slots.length, 32);
  await Promise.all([
    advance(33 * 12, { mode: "honest" }),
    advance(8192 * 12, { mode: "fast" }),
    time.advanceSlots(2),
  ]);
  assert.equal(time.slot, 32 + 33 + 8192 + 2);
  assert.equal(skips.length, 1);
  assert.equal(slots.length, 32 + 33 + 1 + 2);
});

Deno.test("invalid warp modes and unavailable fast backend fail before mutation", async () => {
  let moves = 0;
  const time = new Timeline(0, 11500, {
    move: () => {
      moves++;
      return Promise.resolve();
    },
  });
  const advance = time.advanceTime.bind(time) as (
    seconds: number,
    options: unknown,
  ) => Promise<void>;
  for (const options of [{ mode: "quick" }, null, "fast", { mode: null }]) {
    await assert.rejects(async () => await advance(1000, options), /mode|options/i);
  }
  await assert.rejects(
    async () => await advance(8192 * 12, { mode: "fast" }),
    /support.*fast|support.*skip/i,
  );
  assert.equal(moves, 0);
  assert.equal(time.nowMs, 11500);
  await time.stepSlot();
  assert.equal(time.slot, 1, "bad requests must not poison a healthy timeline");
});

Deno.test("a failed fast warp faults both modes and cannot be retried over partial progress", async () => {
  let skips = 0;
  const time = new Timeline(0, 11500, {
    move: () => Promise.resolve(),
    skip: () => {
      skips++;
      throw new Error("VC restart interrupted");
    },
  });
  const advance = time.advanceTime.bind(time);
  await assert.rejects(advance(8192 * 12, { mode: "fast" }), /restart interrupted/);
  await assert.rejects(advance(12, { mode: "honest" }), /reset required/);
  await assert.rejects(advance(8192 * 12, { mode: "fast" }), /reset required/);
  assert.equal(skips, 1);
});
Deno.test("a stopped client refuses time mutations without faulting the timeline", async () => {
  let blocked: string | undefined = "Client vc is stopped; start it before advancing time";
  let moves = 0;
  const time = new Timeline(0, 11_500, { move: () => Promise.resolve(void moves++) });
  time.blocked = () => blocked;
  await assert.rejects(time.stepSlot(), /Client vc is stopped/);
  await assert.rejects(time.advanceTime(12, { mode: "fast" }), /Client vc is stopped/);
  await assert.rejects(time.skipSlots(1), /Client vc is stopped/);
  assert.equal(moves, 0, "a refused mutation reached the clients");
  // Client control itself runs in the same serialized queue without the guard.
  assert.equal(await time.serialized(() => Promise.resolve("restarted")), "restarted");
  blocked = undefined;
  await time.stepSlot();
  assert.equal(time.slot, 1, "a refusal must not fault later advancement");
});
