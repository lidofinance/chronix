import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EngineGate } from "../src/engine.ts";

Deno.test("a re-attached Geth starts without payload readiness of the previous process", async () => {
  const gate = new EngineGate("http://127.0.0.1:1", 0);
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
