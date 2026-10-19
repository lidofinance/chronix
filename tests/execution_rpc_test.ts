import assert from "node:assert/strict";
import { resolvedEl } from "../src/el_client.ts";
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
  // The EL answers malformed JSON itself without any state change.
  assert.equal(forbiddenExecutionMethod("{"), undefined);
  // An EL may decode only the first JSON value and match field names case-insensitively (Geth
  // does), so any body JavaScript reads differently is refused when it can name a debug method.
  const setHead = JSON.stringify(call("debug_setHead"));
  for (
    const body of [
      `${setHead} x`,
      `${setHead}{}`,
      setHead.replace('"method"', '"Method"'),
      `{"jsonrpc":"2.0","id":1,"method":"eth_chainId","Method":"debug_setHead"}`,
      `${setHead.replace("debug_setHead", "\\u0064ebug_setHead")} x`,
    ]
  ) assert.notEqual(forbiddenExecutionMethod(body), undefined, body);
});

Deno.test("controller refuses a mutating debug call before it reaches the EL", async () => {
  const seen: string[] = [];
  const el = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const body = await request.json();
    seen.push(body.method);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: "forwarded" });
  });
  const endpoint = `http://127.0.0.1:${el.addr.port}`;
  const controller = new Controller({} as Network, {
    config: configuration(),
    execution: resolvedEl("reth-main-f4676ea", "linux/arm64"),
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
    await el.shutdown();
  }
});

Deno.test("a transaction body that an EL may decode but JavaScript cannot is still a write", async () => {
  const { submitsTransaction } = await import("../src/controller.ts");
  const send = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendRawTransaction",
    params: [],
  });
  assert.equal(submitsTransaction(send), true);
  assert.equal(submitsTransaction(`${send} x`), true, "an EL may execute the first JSON value");
  assert.equal(submitsTransaction(JSON.stringify({ method: "eth_chainId" })), false);
  assert.equal(submitsTransaction("{"), false);
});
