import assert from "node:assert/strict";
import { IntervalMining } from "../src/interval.ts";
import { Timeline } from "../src/time.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A timeline whose slots cost nothing beyond `move`; `slots()` counts completed slots. */
function timeline(move: () => Promise<void> = () => Promise.resolve()) {
  let slots = 0;
  const time = new Timeline(0, 11_500, {
    move: async (_at, phase) => {
      await move();
      if (phase === 11_500) slots++;
    },
  });
  return { time, slots: () => slots };
}

Deno.test("interval mining steps one slot per interval and wakes automine after each", async () => {
  const { time, slots } = timeline();
  let woken = 0;
  const interval = new IntervalMining(time, () => woken++);
  await interval.set(40);
  await sleep(150);
  await interval.set(0);
  const produced = slots();
  assert(produced >= 2 && produced <= 4, `${produced} slots in 150 ms at one per 40 ms`);
  assert.equal(woken, produced);
  await sleep(100);
  assert.equal(slots(), produced, "a slot after interval mining was turned off");
  assert.equal(interval.ms, 0);
});

Deno.test("turning interval mining off waits for the slot in flight and arms no other", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const { time, slots } = timeline(async () => {
    if (!first) return;
    first = false;
    entered.resolve();
    await release.promise;
  });
  const interval = new IntervalMining(time, () => {});
  await interval.set(10);
  await entered.promise;
  let off = false;
  const turningOff = interval.set(0).then(() => {
    off = true;
  });
  await sleep(30);
  assert.equal(off, false, "set(0) returned before the slot in flight finished");
  release.resolve();
  await turningOff;
  await sleep(60);
  assert.equal(slots(), 1);
});

Deno.test("a jump holding the timeline delays interval slots without a burst afterwards", async () => {
  const { time, slots } = timeline();
  const interval = new IntervalMining(time, () => {});
  await interval.set(30);
  // About seven intervals pass while another time command holds the timeline.
  await time.exclusive(() => sleep(200));
  const afterJump = slots();
  await sleep(45);
  await interval.set(0);
  assert(slots() - afterJump <= 2, `${slots() - afterJump} slots within 45 ms after the jump`);
});

Deno.test("a failed slot turns interval mining off and keeps the error", async () => {
  const { time } = timeline(() => Promise.reject(new Error("engine down")));
  const interval = new IntervalMining(time, () => {});
  await interval.set(10);
  await sleep(60);
  assert.equal(interval.ms, 0);
  assert.match(interval.error ?? "", /engine down/);
});

Deno.test("a stopped client skips interval slots without turning interval mining off", async () => {
  const { time, slots } = timeline();
  let stopped: string | undefined = "Execution client is stopped";
  time.blocked = () => stopped;
  const interval = new IntervalMining(time, () => {});
  await interval.set(10);
  await sleep(60);
  assert.equal(slots(), 0);
  assert.equal(interval.ms, 10);
  assert.equal(interval.error, undefined);
  stopped = undefined;
  await sleep(60);
  assert(slots() > 0, "interval mining did not resume after the client started");
  await interval.set(0);
});

Deno.test("interval mining accepts only a whole number of milliseconds and stays off after stop", async () => {
  const { time, slots } = timeline();
  const interval = new IntervalMining(time, () => {});
  await assert.rejects(interval.set(-1), /integer/);
  await assert.rejects(interval.set(1.5), /integer/);
  await interval.stop();
  await interval.set(10);
  await sleep(40);
  assert.equal(slots(), 0);
  assert.equal(interval.ms, 0);
});

Deno.test("the latest change wins over an earlier one waiting for the same slot", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const { time, slots } = timeline(async () => {
    if (!first) return;
    first = false;
    entered.resolve();
    await release.promise;
  });
  const interval = new IntervalMining(time, () => {});
  await interval.set(10);
  await entered.promise;
  const on = interval.set(20);
  const off = interval.set(0);
  release.resolve();
  await Promise.all([on, off]);
  await sleep(80);
  assert.equal(interval.ms, 0);
  assert.equal(slots(), 1, "slots ran after the later set(0)");
});

Deno.test("stopping during a long jump returns promptly without an error", async () => {
  const { time } = timeline(() => sleep(20));
  const interval = new IntervalMining(time, () => {});
  const jump = time.advanceSlots(1000).catch(() => {});
  await interval.set(10);
  await sleep(40); // The interval slot now waits behind the jump.
  const started = performance.now();
  const stopping = interval.stop();
  time.stop();
  await stopping;
  await jump;
  assert(performance.now() - started < 500, `stop took ${performance.now() - started} ms`);
  assert.equal(interval.error, undefined);
});

Deno.test("interval mining rejects an interval the timer cannot hold", async () => {
  const { time } = timeline();
  const interval = new IntervalMining(time, () => {});
  await assert.rejects(interval.set(2 ** 31), /at most/);
});
