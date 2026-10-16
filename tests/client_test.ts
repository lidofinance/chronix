// Runtime-neutral: runs under `deno test` and `node --test`, so only erasable TypeScript syntax.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChronixClient, ChronixError, SnapshotOperationError } from "../client/mod.js";

interface Seen {
  method: string;
  path: string;
  body: string;
}
interface Reply {
  status?: number;
  json?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  hold?: boolean;
  /** Send these bytes after the headers and keep the response open. */
  stream?: Uint8Array;
}

/** A stub Chronix endpoint that records every request. */
async function stub(reply: (seen: Seen) => Reply) {
  const seen: Seen[] = [];
  const held: (() => void)[] = [];
  const closed: Promise<void>[] = [];
  const server = createServer((request, response) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        method: request.method ?? "",
        path: request.url ?? "",
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(entry);
      const answer = reply(entry);
      closed.push(new Promise((resolve) => response.on("close", () => resolve())));
      if (answer.stream) {
        response.writeHead(answer.status ?? 200, answer.headers);
        response.write(answer.stream);
        return;
      }
      const send = () => {
        if (answer.bytes) {
          response.writeHead(answer.status ?? 200, answer.headers);
          response.end(answer.bytes);
        } else {
          response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
          response.end(JSON.stringify(answer.json ?? { result: null }));
        }
      };
      if (answer.hold) held.push(send);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No stub address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    closed,
    async close() {
      for (const send of held) send();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections(); // keep-alive connections would hold close() open
      await closed;
    },
  };
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

test("commands POST their params array to /control/{method} and return the result", async () => {
  const chronix = await stub(() => ({ json: { result: { now: 24, slot: 2 } } }));
  try {
    const client = new ChronixClient(chronix.url);
    assert.deepEqual(await client.stepSlot(), { now: 24, slot: 2 });
    await client.advanceSlots(3);
    await client.advanceTime(60);
    await client.advanceTime(60, { mode: "fast" });
    await client.advanceTo(new Date(24_500));
    await client.setValidatorsOnline([1, "0xab"], false);
    await client.restartClient("bn", { kill: true });
    await client.missProposal(40);
    assert.deepEqual(
      chronix.seen.map(({ method, path, body }) => [method, path, JSON.parse(body)]),
      [
        ["POST", "/control/stepSlot", []],
        ["POST", "/control/advanceSlots", [3]],
        ["POST", "/control/advanceTime", [60]],
        ["POST", "/control/advanceTime", [60, { mode: "fast" }]],
        ["POST", "/control/advanceTo", [24.5]],
        ["POST", "/control/setValidatorsOnline", [[1, "0xab"], false]],
        ["POST", "/control/restartClient", ["bn", { kill: true }]],
        ["POST", "/control/missProposal", [40]],
      ],
    );
  } finally {
    await chronix.close();
  }
});

test("snapshot operations get a fresh operation UUID and accept a snapshot reference", async () => {
  const chronix = await stub(() => ({ json: { result: {} } }));
  try {
    const client = new ChronixClient(chronix.url);
    await client.createSnapshot();
    await client.restoreSnapshot({ id: "s1" } as Parameters<typeof client.restoreSnapshot>[0]);
    await client.removeSnapshot("s2", "op");
    const [create, restore, remove] = chronix.seen.map((entry) => JSON.parse(entry.body));
    assert.match(create[0], uuid);
    assert.equal(restore[0], "s1");
    assert.match(restore[1], uuid);
    assert.deepEqual(remove, ["s2", "op"]);
  } finally {
    await chronix.close();
  }
});

test("a failed command throws its error, status and snapshot operation", async () => {
  const operation = { state: "failed", stage: "captured", error: "disk full" };
  const chronix = await stub(({ path }) =>
    path.endsWith("/snapshotCreate")
      ? { status: 500, json: { error: "Error: disk full", operation } }
      : path.endsWith("/stepSlot")
      ? { status: 503, json: { error: "Error: Controller is stopping" } }
      : { status: 403, bytes: new TextEncoder().encode("Forbidden origin") }
  );
  try {
    const client = new ChronixClient(chronix.url);
    await assert.rejects(client.stepSlot(), (error) => {
      assert(error instanceof ChronixError);
      assert.equal(error.status, 503);
      assert.equal(error.message, "Error: Controller is stopping");
      return true;
    });
    await assert.rejects(client.createSnapshot(), (error) => {
      assert(error instanceof SnapshotOperationError);
      assert.equal(error.operation.stage, "captured");
      assert.equal(error.message, "disk full");
      return true;
    });
    await assert.rejects(client.status(), (error) => {
      assert(error instanceof ChronixError);
      assert.equal(error.status, 403);
      assert.match(error.message, /Forbidden origin/);
      return true;
    });
  } finally {
    await chronix.close();
  }
});

test("requests are bounded by the configured timeout", async () => {
  const chronix = await stub(() => ({ hold: true }));
  try {
    const client = new ChronixClient(chronix.url, { timeoutMs: 50 });
    await assert.rejects(client.stepSlot(), (error) => {
      assert.equal((error as Error).name, "TimeoutError");
      return true;
    });
  } finally {
    await chronix.close();
  }
});

test("rpc and beacon reach the execution and Beacon API proxies", async () => {
  const chronix = await stub(({ method, path, body }) => {
    if (method === "POST" && path === "/") {
      const call = JSON.parse(body);
      return call.method === "eth_chainId"
        ? { json: { jsonrpc: "2.0", id: call.id, result: "0x539" } }
        : { json: { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "no method" } } };
    }
    return path === "/eth/v1/node/version"
      ? { json: { data: { version: "Lighthouse" } } }
      : { status: 404, json: { message: "not found" } };
  });
  try {
    const client = new ChronixClient(chronix.url);
    assert.equal(await client.rpc("eth_chainId"), "0x539");
    await assert.rejects(client.rpc("eth_missing", [1]), /eth_missing: no method \(-32601\)/);
    assert.deepEqual(await client.beacon("/eth/v1/node/version"), {
      data: { version: "Lighthouse" },
    });
    await assert.rejects(client.beacon("/eth/v1/missing"), (error) => {
      assert(error instanceof ChronixError);
      assert.equal(error.status, 404);
      return true;
    });
    assert.deepEqual(JSON.parse(chronix.seen[1].body).params, [1]);
  } finally {
    await chronix.close();
  }
});

test("exportSnapshot verifies the checksum and never replaces a file", async () => {
  const archive = new TextEncoder().encode("snapshot bytes");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const chronix = await stub(({ path }) => ({
    bytes: archive,
    headers: { "x-chronix-sha256": path.includes("/bad/") ? "0".repeat(64) : sha256 },
  }));
  const directory = await mkdtemp(join(tmpdir(), "chronix-client-"));
  try {
    const client = new ChronixClient(chronix.url);
    const path = join(directory, "a.gz");
    assert.deepEqual(await client.exportSnapshot("good", path), {
      path,
      sha256,
      bytes: archive.length,
    });
    assert.deepEqual(new Uint8Array(await readFile(path)), archive);
    assert.equal(chronix.seen[0].path, "/snapshots/good/archive");
    await writeFile(path, "kept");
    await assert.rejects(client.exportSnapshot("good", path));
    assert.equal(await readFile(path, "utf8"), "kept");
    await assert.rejects(client.exportSnapshot("bad", join(directory, "b.gz")), /SHA-256/);
    assert.deepEqual(await readdir(directory), ["a.gz"]);
  } finally {
    await chronix.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("advanceUntil steps slots until the predicate holds or the limit is reached", async () => {
  const chronix = await stub(() => ({ json: { result: { now: 0, slot: 0 } } }));
  try {
    const client = new ChronixClient(chronix.url);
    let checks = 0;
    assert.equal(
      await client.advanceUntil(() => Promise.resolve(++checks === 3), { maxSlots: 5 }),
      2,
    );
    assert.equal(chronix.seen.length, 2);
    await assert.rejects(
      client.advanceUntil(() => Promise.resolve(false), { maxSlots: 1 }),
      /advanceUntil limit reached/,
    );
    await assert.rejects(client.advanceUntil(() => Promise.resolve(true), { maxSlots: -1 }));
  } finally {
    await chronix.close();
  }
});

test("mod.js stays checked against types.d.ts", async () => {
  const source = await readFile(new URL("../client/mod.js", import.meta.url), "utf8");
  assert.match(source, /^\/\/ @ts-check\n/);
  // A self-types directive replaces the module's types and silently disables the check.
  assert.doesNotMatch(source, /^\s*\/\/\s*@ts-self-types/m);
  assert.match(source, /@implements \{Api\}/);
});

test("client methods live on the prototype, so subclasses can override them", async () => {
  const chronix = await stub(() => ({ json: { result: { now: 0, slot: 7 } } }));
  try {
    for (const name of ["status", "stepSlot", "advanceTime", "rpc", "exportSnapshot"]) {
      assert.equal(
        typeof Object.getOwnPropertyDescriptor(ChronixClient.prototype, name)?.value,
        "function",
        name,
      );
    }
    class Counting extends ChronixClient {
      steps = 0;
      override async stepSlot() {
        this.steps++;
        return await super.stepSlot();
      }
    }
    const client = new Counting(chronix.url);
    assert.equal(
      await client.advanceUntil(() => Promise.resolve(client.steps === 2), { maxSlots: 5 }),
      2,
    );
    assert.equal((await client.stepSlot()).slot, 7);
  } finally {
    await chronix.close();
  }
});

test("an error document whose error is not a string still produces a readable message", async () => {
  const chronix = await stub(() => ({
    status: 500,
    json: { error: { code: -32000, message: "nope" } },
  }));
  try {
    await assert.rejects(new ChronixClient(chronix.url).stepSlot(), (error) => {
      assert(error instanceof ChronixError);
      assert.doesNotMatch(error.message, /\[object Object\]/);
      assert.match(error.message, /nope/);
      return true;
    });
  } finally {
    await chronix.close();
  }
});

test("exportSnapshot requires a well-formed checksum and enforces its byte limit", async () => {
  const archive = new TextEncoder().encode("snapshot bytes");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const chronix = await stub(({ path }): Reply => ({
    bytes: archive,
    headers: path.includes("/unsigned/")
      ? {}
      : { "x-chronix-sha256": path.includes("/upper/") ? sha256.toUpperCase() : sha256 },
  }));
  const directory = await mkdtemp(join(tmpdir(), "chronix-client-"));
  try {
    const client = new ChronixClient(chronix.url);
    await assert.rejects(client.exportSnapshot("unsigned", join(directory, "a.gz")), /no SHA-256/);
    await assert.rejects(
      client.exportSnapshot("upper", join(directory, "b.gz")),
      /64 lowercase hex digits/,
    );
    await assert.rejects(
      client.exportSnapshot("good", join(directory, "c.gz"), { maxBytes: archive.length - 1 }),
      /byte limit/,
    );
    assert.deepEqual(await readdir(directory), []);
    await client.exportSnapshot("good", join(directory, "d.gz"), { maxBytes: archive.length });
    assert.deepEqual(await readdir(directory), ["d.gz"]);
  } finally {
    await chronix.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed export releases the archive download instead of holding it open", async () => {
  const chronix = await stub((): Reply => ({
    stream: new Uint8Array(1024),
    headers: { "x-chronix-sha256": "0".repeat(64) },
  }));
  try {
    const client = new ChronixClient(chronix.url);
    await assert.rejects(
      client.exportSnapshot("s", join(tmpdir(), "chronix-missing-directory", "a.gz")),
      /ENOENT|no such file/i,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      chronix.closed[0],
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("download still open")), 2_000);
      }),
    ]).finally(() => clearTimeout(timer));
  } finally {
    await chronix.close();
  }
});
