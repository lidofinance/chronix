import assert from "node:assert/strict";
import { Controller } from "../src/controller.ts";
import { configuration } from "../src/config.ts";
import { forbiddenExecutionMethod } from "../src/execution_rpc.ts";
import type { Manifest, Network } from "../src/network.ts";
import { Timeline } from "../src/time.ts";

const call = (method: string) => ({ jsonrpc: "2.0", id: 1, method, params: [] });

Deno.test("only read-only debug methods are allowed on the public execution RPC", () => {
  for (
    const method of [
      "eth_blockNumber",
      "debug_traceTransaction",
      "debug_traceCall",
      "debug_traceBlockByNumber",
      "debug_storageRangeAt",
      "debug_getRawReceipts",
    ]
  ) assert.equal(forbiddenExecutionMethod(JSON.stringify(call(method))), undefined, method);
  for (const method of ["debug_setHead", "debug_setGCPercent", "debug_chaindbCompact"]) {
    assert.equal(forbiddenExecutionMethod(JSON.stringify(call(method))), method);
  }
  assert.equal(
    forbiddenExecutionMethod(JSON.stringify([call("eth_chainId"), call("debug_setHead")])),
    "debug_setHead",
    "a batch must not smuggle a mutating debug call",
  );
  // Geth answers malformed JSON itself without any state change.
  assert.equal(forbiddenExecutionMethod("{"), undefined);
});

Deno.test("controller refuses a mutating debug call before it reaches Geth", async () => {
  const seen: string[] = [];
  const geth = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const body = await request.json();
    seen.push(body.method);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: "forwarded" });
  });
  const endpoint = `http://127.0.0.1:${geth.addr.port}`;
  const controller = new Controller({} as Network, {
    config: configuration(),
    el: endpoint,
    beacon: endpoint,
  } as Manifest, new Timeline(0, 11_500, { move: async () => {} }));
  const url = controller.serve(0);
  try {
    const post = (method: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call(method)),
      });
    const allowed = await post("debug_traceTransaction");
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).result, "forwarded");
    const refused = await post("debug_setHead");
    assert.equal(refused.status, 403);
    const body = await refused.json();
    assert.equal(body.error.code, -32601);
    assert.match(body.error.message, /debug_setHead/);
    assert.deepEqual(seen, ["debug_traceTransaction"]);
  } finally {
    await controller.server!.shutdown();
    await controller.automine.stop();
    await geth.shutdown();
  }
});
