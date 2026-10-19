import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { elClients } from "../src/el_client.ts";
import { EngineGate } from "../src/engine.ts";

/** An Engine API JWT for the gate, as a consensus client signs it. */
async function jwt(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret.match(/../g)!.map((byte) => parseInt(byte, 16))),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
  const message = `${json({ alg: "HS256", typ: "JWT" })}.${
    json({ iat: Math.floor(Date.now() / 1000) })
  }`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return `${message}.${encode(new Uint8Array(signature))}`;
}

Deno.test("a re-attached Geth starts without payload readiness of the previous process", async () => {
  const gate = new EngineGate("http://127.0.0.1:1", 0, elClients.geth.gate);
  const streams: PassThrough[] = [];
  const container = {
    logs: () => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve(stream);
    },
  };
  // Internals of the gate: a readiness event of the old Geth for the same payload id.
  gate["infra"] = { docker: { modem: { demuxStream() {} } } } as never;
  gate["payloadReady"]("0x01");
  assert.equal(gate["ready"].size, 1);
  await gate.attach(container as never, "http://127.0.0.1:2");
  assert.equal(gate["ready"].size, 0, "an old process's payload id would skip the new build");
  assert.equal(gate.upstream, "http://127.0.0.1:2");
  for (const stream of streams) stream.destroy();
});

Deno.test("an EL without a readiness log gets getPayload at once and no log follower", async () => {
  const upstream = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const call = await request.json();
      return Response.json({ jsonrpc: "2.0", id: call.id, result: call.method });
    },
  );
  let followed = 0;
  const container = {
    logs: () => {
      followed++;
      return Promise.resolve(new PassThrough());
    },
  };
  const secret = "ab".repeat(32);
  const gate = await EngineGate.start(
    { docker: { modem: { demuxStream() {} } } } as never,
    container as never,
    `http://127.0.0.1:${upstream.addr.port}`,
    0,
    secret,
    elClients.reth.gate,
  );
  try {
    await gate.attach(container as never, `http://127.0.0.1:${upstream.addr.port}`);
    assert.equal(followed, 0, "the gate followed EL logs");
    // No readiness event ever arrives; the call must be forwarded without waiting for one.
    const response = await fetch(`http://127.0.0.1:${gate["server"]!.addr.port}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await jwt(secret)}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "engine_getPayloadV6",
        params: ["0x01"],
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal((await response.json()).result, "engine_getPayloadV6");
  } finally {
    await gate.close();
    await upstream.shutdown();
  }
});
