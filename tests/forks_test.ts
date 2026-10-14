import assert from "node:assert/strict";
import { ForkSchedule, preGloasTiming } from "../src/forks.ts";
import { profiles } from "../src/profiles.ts";
import { Timeline } from "../src/time.ts";

const recipe = profiles.gloas;

Deno.test("pre-Gloas duties use the beacon node's due times; Gloas keeps the recipe phases", () => {
  // Fulu due times: 1/3 and 2/3 of a 12-second slot in basis points.
  const before = preGloasTiming({ ATTESTATION_DUE_BPS: "3333", AGGREGATE_DUE_BPS: "6667" });
  assert.deepEqual(before, { attestationMs: 4000, aggregateMs: 8001 });
  const schedule = new ForkSchedule(2, recipe, before);
  assert.deepEqual(schedule.timing(63), {
    gloas: false,
    phases: [0, 4000, 8001, 9000, 11500],
    attestationMs: 4000,
    aggregateMs: 8001,
  });
  assert.deepEqual(schedule.timing(64), {
    gloas: true,
    phases: recipe.phases,
    attestationMs: recipe.attestationMs,
    aggregateMs: recipe.aggregateMs,
  });
  assert.equal(new ForkSchedule(0, recipe).timing(0).gloas, true, "Gloas from genesis");
  assert.throws(() => new ForkSchedule(1, recipe), /pre-Gloas due times/);
});

Deno.test("the timeline executes each slot with its own fork's phases", async () => {
  const visited: [number, number | undefined][] = [];
  const schedule = new ForkSchedule(1, recipe, { attestationMs: 4000, aggregateMs: 8001 });
  const time = new Timeline(0, 31 * 12_000 + 11_500, {
    move: (at, phase) => Promise.resolve(void visited.push([at, phase])),
  }, (slot) => schedule.timing(slot).phases);
  await time.advanceSlots(1);
  assert.deepEqual(visited.map(([, phase]) => phase), recipe.phases, "slot 32 is Gloas");
  visited.length = 0;
  const early = new Timeline(0, 11_500, {
    move: (at, phase) => Promise.resolve(void visited.push([at, phase])),
  }, (slot) => schedule.timing(slot).phases);
  await early.advanceSlots(1);
  assert.deepEqual(visited.map(([, phase]) => phase), [0, 4000, 8001, 9000, 11500]);
});
