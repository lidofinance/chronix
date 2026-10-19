import assert from "node:assert/strict";
import { request } from "node:http";
import { PassThrough, Readable, Writable } from "node:stream";
import { Infrastructure, LABEL, ROLE } from "../src/docker.ts";
import { tcpRelay } from "../container/relay.ts";
import { clientCommand } from "../container/clients.ts";

function server(handler: (request: Request) => Response | Promise<Response>) {
  const http = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, handler);
  return { http, url: `http://127.0.0.1:${http.addr.port}` };
}

Deno.test("native relay preserves VC authentication, request bodies and CL event streams", async () => {
  const upstream = server(async (req) => {
    if (new URL(req.url).pathname === "/eth/v1/events") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: head\ndata: live\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (req.headers.get("authorization") !== "Bearer fixture-token") {
      return new Response("Unauthorized", {
        status: req.headers.has("authorization") ? 403 : 401,
      });
    }
    return Response.json({ method: req.method, body: await req.json() });
  });
  let relay: ReturnType<typeof tcpRelay> | undefined;
  try {
    relay = tcpRelay(() => upstream.url, 0, "127.0.0.1");
    const url = `http://127.0.0.1:${relay.port}`;
    for (const token of [undefined, "wrong-token"]) {
      const denied = await fetch(`${url}/eth/v1/keystores`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      assert.equal(denied.status, token ? 403 : 401);
      await denied.body?.cancel();
    }
    const accepted = await fetch(`${url}/eth/v1/keystores`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
      body: JSON.stringify({ keystores: ["fixture"] }),
    });
    assert.deepEqual(await accepted.json(), { method: "POST", body: { keystores: ["fixture"] } });
    const events = await fetch(`${url}/eth/v1/events`, { signal: AbortSignal.timeout(2000) });
    assert.equal(events.headers.get("content-type"), "text/event-stream");
    const reader = events.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: head/);
    await reader.cancel();
  } finally {
    await relay?.close();
    await upstream.http.shutdown();
  }
});

Deno.test("relay resolves the current VC after restart and closes active connections", async () => {
  const first = server(() => new Response("before restart"));
  const second = server(() => new Response("after restart"));
  let current = first.url;
  let relay: ReturnType<typeof tcpRelay> | undefined;
  let socket: Deno.TcpConn | undefined;
  try {
    relay = tcpRelay(() => current, 0, "127.0.0.1");
    const url = `http://127.0.0.1:${relay.port}`;
    assert.equal(
      await (await fetch(url, { headers: { connection: "close" } })).text(),
      "before restart",
    );
    current = second.url;
    assert.equal(
      await (await fetch(url, { headers: { connection: "close" } })).text(),
      "after restart",
    );
    socket = await Deno.connect({ hostname: "127.0.0.1", port: relay.port });
    await socket.write(new TextEncoder().encode("GET / HTTP/1.1\r\n"));
    await relay.close();
    try {
      assert.equal(await socket.read(new Uint8Array(1)), null);
    } catch (error) {
      if (!(error instanceof Deno.errors.ConnectionReset)) throw error;
    }
    await assert.rejects(Deno.connect({ hostname: "127.0.0.1", port: relay.port }));
  } finally {
    socket?.close();
    await relay?.close();
    await first.http.shutdown();
    await second.http.shutdown();
  }
});

Deno.test("relay preserves controller Host and Origin restrictions", async () => {
  const upstream = server((req) => {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    return new Response(null, {
      status: url.hostname === "127.0.0.1" && (!origin || origin === url.origin) ? 200 : 403,
    });
  });
  let relay: ReturnType<typeof tcpRelay> | undefined;
  try {
    relay = tcpRelay(() => upstream.url, 0, "127.0.0.1");
    for (const headers of [{ host: "foreign.example" }, { origin: "https://foreign.example" }]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(`http://127.0.0.1:${relay!.port}/`, {
          headers: { ...headers, connection: "close" },
        }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 403);
    }
  } finally {
    await relay?.close();
    await upstream.http.shutdown();
  }
});

function frame(channel: number, text: string) {
  const data = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

Deno.test("client logs select exact owner and role, demux stdout/stderr, and support follow", async () => {
  const infra = new Infrastructure("unit-logs");
  const data = Buffer.concat([frame(1, "EL output\n"), frame(2, "EL error\n")]);
  infra.docker.listContainers = (options) => {
    assert.deepEqual(options, {
      all: true,
      filters: { label: [`${LABEL}=unit-logs`, `${ROLE}=el`] },
    });
    return Promise.resolve([{ Id: "owned" }]) as ReturnType<typeof infra.docker.listContainers>;
  };
  let follow = false;
  infra.docker.getContainer = (id) => {
    assert.equal(id, "owned");
    return {
      logs(options: unknown) {
        assert.deepEqual(options, { stdout: true, stderr: true, follow, tail: 42 });
        return Promise.resolve(
          follow ? Readable.from([data.subarray(0, 5), data.subarray(5)]) : data,
        );
      },
    } as unknown as ReturnType<typeof infra.docker.getContainer>;
  };
  for (follow of [false, true]) {
    let stdout = "";
    let stderr = "";
    const writer = (append: (text: string) => void) =>
      new Writable({
        write(chunk, _encoding, done) {
          append(chunk.toString());
          done();
        },
      });
    await infra.clientLogs(
      "el",
      { follow, tail: 42 },
      writer((s) => stdout += s),
      writer((s) => stderr += s),
    );
    assert.equal(stdout, "EL output\n");
    assert.equal(stderr, "EL error\n");
  }
  infra.docker.listContainers = () => Promise.resolve([]);
  const sink = new PassThrough();
  await assert.rejects(infra.clientLogs("el", {}, sink, sink), /Expected exactly one owned el/);
  sink.destroy();
});

Deno.test("container CLI selects client logs and requires explicit token access", () => {
  assert.deepEqual(clientCommand(["logs", "cl", "--tail", "42", "--follow"]), {
    command: "logs",
    role: "bn",
    tail: 42,
    follow: true,
  });
  assert.deepEqual(clientCommand(["logs", "vc", "--tail", "all"]), {
    command: "logs",
    role: "vc",
    tail: "all",
    follow: false,
  });
  assert.deepEqual(clientCommand(["validator-token"]), { command: "validator-token" });
  assert.deepEqual(clientCommand(["clients", "save"]), { command: "clients-save" });
  assert.deepEqual(clientCommand(["clients", "save", "geth-master-5d8fd6b"]), {
    command: "clients-save",
    el: "geth-master-5d8fd6b",
  });
  for (
    const args of [
      [],
      ["logs", "genesis"],
      ["logs", "el", "--tail"],
      [
        "logs",
        "vc",
        "--tail",
        "-1",
      ],
      ["validator-token", "extra"],
      ["clients"],
      ["clients", "load"],
      [
        "clients",
        "save",
        "reth-main-f4676ea",
        "extra",
      ],
    ]
  ) {
    assert.throws(() => clientCommand(args), /Usage:/);
  }
});
