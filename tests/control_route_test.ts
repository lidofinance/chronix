import assert from "node:assert/strict";
import { PandaClient } from "../client/mod.js";
import { Controller } from "../src/controller.ts";
import type { Manifest, Network } from "../src/network.ts";
import { Timeline } from "../src/time.ts";

function controller() {
  const time = new Timeline(0, 11500, { move: () => Promise.resolve() });
  const network = { stop: () => Promise.resolve() } as unknown as Network;
  return new Controller(network, { el: "http://127.0.0.1:1" } as Manifest, time);
}

Deno.test("POST /control/{method} takes the params array as its body", async () => {
  const panda = controller();
  const url = panda.serve(0);
  try {
    const post = (path: string, body?: string) =>
      fetch(`${url}${path}`, { method: "POST", body }).then(async (response) => ({
        status: response.status,
        body: response.headers.get("content-type")?.includes("json")
          ? await response.json()
          : await response.text(),
      }));
    const advanced = await post("/control/advanceSlots", "[2]");
    assert.equal(advanced.status, 200);
    assert.deepEqual(Object.keys(advanced.body.result).sort(), ["now", "slot"]);
    assert.equal(advanced.body.result.slot, 2);
    assert.deepEqual((await post("/control/stepSlot")).body.result.slot, 3, "empty body is []");
    assert.equal((await post("/control/stepSlot", "")).body.result.slot, 4);
    const unknown = await post("/control/noSuchCommand", "[]");
    assert.equal(unknown.status, 500);
    assert.match(unknown.body.error, /Unknown control method: noSuchCommand/);
    assert.match((await post("/control/advanceSlots", '{"count":1}')).body.error, /array/);
    assert.equal((await post("/control/stepSlot/extra", "[]")).status, 404);
    // The legacy envelope keeps working.
    const legacy = await post("/control", JSON.stringify({ method: "stepSlot", params: [] }));
    assert.equal(legacy.body.result.slot, 5);
    // The typed client uses the per-method route.
    assert.equal((await new PandaClient(url).advanceEpochs(1)).slot, 37);
  } finally {
    await panda.close();
  }
});
