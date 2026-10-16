import assert from "node:assert/strict";
import { json, waitFor } from "../src/http.ts";

Deno.test("HTTP and readiness defaults allow an hour; explicit test budgets remain strict", async () => {
  const fetch = globalThis.fetch;
  const timeout = AbortSignal.timeout;
  const now = performance.now;
  const previous = Deno.env.get("CHRONIX_TIMEOUT_MS");
  Deno.env.delete("CHRONIX_TIMEOUT_MS");
  const budgets: number[] = [];
  AbortSignal.timeout = (ms) => {
    budgets.push(ms);
    return timeout(ms);
  };
  globalThis.fetch = () => Promise.resolve(Response.json({ ok: true }));
  try {
    await json("http://fixture");
    assert.deepEqual(budgets, [3_600_000]);
    let elapsed = 0;
    let probes = 0;
    performance.now = () => elapsed;
    assert.equal(
      await waitFor("slow readiness", () => {
        elapsed += 180_000;
        return Promise.resolve(++probes === 2 ? "ready" : undefined);
      }),
      "ready",
    );
    performance.now = now;
    // Even a probe which never returns must respect the caller's explicit wall-time budget.
    await assert.rejects(waitFor("hung probe", () => new Promise(() => {}), 20), /hung probe/);
    Deno.env.set("CHRONIX_TIMEOUT_MS", "25");
    await json("http://fixture");
    assert.equal(budgets.at(-1), 25);
    await assert.rejects(
      waitFor("strict readiness", () => Promise.resolve(undefined)),
      /strict readiness/,
    );
    for (const invalid of ["0", "-1", "oops", "1.5", "2147483648"]) {
      Deno.env.set("CHRONIX_TIMEOUT_MS", invalid);
      await assert.rejects(json("http://fixture"), /CHRONIX_TIMEOUT_MS/);
    }
  } finally {
    globalThis.fetch = fetch;
    AbortSignal.timeout = timeout;
    performance.now = now;
    if (previous === undefined) Deno.env.delete("CHRONIX_TIMEOUT_MS");
    else Deno.env.set("CHRONIX_TIMEOUT_MS", previous);
  }
});
