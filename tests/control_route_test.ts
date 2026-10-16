import assert from "node:assert/strict";
import { ChronixClient } from "../client/mod.js";
import { Controller } from "../src/controller.ts";
import type { Manifest, Network } from "../src/network.ts";
import { Timeline } from "../src/time.ts";

function controller() {
  const time = new Timeline(0, 11500, { move: () => Promise.resolve() });
  const network = { stop: () => Promise.resolve() } as unknown as Network;
  return new Controller(network, { el: "http://127.0.0.1:1" } as Manifest, time);
}

Deno.test("POST /control/{method} takes the params array as its body", async () => {
  const chronix = controller();
  const url = chronix.serve(0);
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
    assert.equal((await new ChronixClient(url).advanceEpochs(1)).slot, 37);
  } finally {
    await chronix.close();
  }
});

Deno.test("ingress accepts only loopback and explicitly allowed hosts", async () => {
  const { request } = await import("node:http");
  const status = (url: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(`${url}/control/stepSlot`, {
        method: "POST",
        headers: { host, connection: "close" },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end("[]");
    });
  const chronix = controller();
  chronix.allowHosts(["chronix"]);
  const url = chronix.serve(0);
  const port = new URL(url).port;
  try {
    assert.equal(await status(url, `127.0.0.1:${port}`), 200);
    assert.equal(await status(url, `chronix:${port}`), 200, "an allowed sibling host");
    assert.equal(await status(url, "chronix"), 200);
    assert.equal(await status(url, `other:${port}`), 403);
    assert.equal(await status(url, `chronix.evil:${port}`), 403);
  } finally {
    await chronix.close();
  }
});
