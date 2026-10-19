import assert from "node:assert/strict";
import { resolvedEl } from "../src/el_client.ts";
import { Devnet } from "../src/api.ts";
import { configuration } from "../src/config.ts";
import { Controller } from "../src/controller.ts";
import type { Manifest, Network } from "../src/network.ts";
import { Timeline } from "../src/time.ts";

Deno.test("public API forwards warp modes through HTTP and defaults to honest advancement", async () => {
  const skips: number[] = [];
  const proposals: number[] = [];
  const time = new Timeline(0, 11500, {
    move: (at, phase) => {
      if (phase === 0) proposals.push(at / 12000);
      return Promise.resolve();
    },
    skip: (at) => {
      skips.push(at);
      return Promise.resolve();
    },
  });
  const network = { stop: () => Promise.resolve() } as unknown as Network;
  const manifest = {
    el: "http://127.0.0.1:1",
    config: configuration({ el: "reth-main-f4676ea" }),
    execution: resolvedEl("reth-main-f4676ea", "linux/arm64"),
  } as Manifest;
  const controller = new Controller(network, manifest, time);
  const net = new Devnet(controller.serve(0));
  const advance = net.advanceTime.bind(net);
  const to = net.advanceTo.bind(net);
  try {
    await net.advanceTime(33 * 12);
    assert.equal(skips.length, 0);
    assert.equal(proposals.length, 33);
    await advance(8192 * 12, { mode: "fast" });
    assert.equal(skips.length, 1);
    assert.equal(proposals.length, 34);
    const target = new Date((time.timestamp + 8192 * 12 + 0.125) * 1000);
    await to(target, { mode: "fast" });
    assert.equal(skips.length, 2);
    assert.equal(time.nowMs, target.getTime());
    const before = time.nowMs;
    const invalid = await fetch(`${net.url}/control`, {
      method: "POST",
      body: JSON.stringify({ method: "advanceTime", params: [3600, { mode: "quick" }] }),
    });
    assert.equal(invalid.status, 500);
    assert.match((await invalid.json()).error, /mode/i);
    assert.equal(time.nowMs, before);
    await advance(12, { mode: "honest" });
    assert.equal(skips.length, 2);
  } finally {
    await controller.close();
  }
});
