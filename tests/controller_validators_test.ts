import assert from "node:assert/strict";
import { Controller } from "../src/controller.ts";
import { configuration } from "../src/config.ts";
import { type Manifest, type Network } from "../src/network.ts";
import { Timeline } from "../src/time.ts";
import { ValidatorControl } from "../src/validator_control.ts";

// HTTP adapter unit tests; these do not certify validator/signature behavior.
async function fixture(
  run: (f: {
    call: (method: string, params: unknown[]) => Promise<{ status: number; body: unknown }>;
    requests: { path: string; authorization: string | null; body: unknown; method?: string }[];
  }) => Promise<void>,
) {
  const directory = await Deno.makeTempDir();
  await Deno.mkdir(`${directory}/validator-keys/keys`, { recursive: true });
  await Deno.writeTextFile(`${directory}/validator-keys/keys/api-token.txt`, "unit-secret\n");
  const requests: {
    path: string;
    authorization: string | null;
    body: unknown;
    method?: string;
  }[] = [];
  const keys = [0, 1, 2].map((index) => `0x${String(index).repeat(96)}`);
  for (const pubkey of keys) {
    await Deno.mkdir(`${directory}/validator-keys/keys/${pubkey}`, { recursive: true });
    await Deno.mkdir(`${directory}/validator-keys/secrets`, { recursive: true });
    await Deno.writeTextFile(
      `${directory}/validator-keys/keys/${pubkey}/voting-keystore.json`,
      JSON.stringify({ version: 4, pubkey: pubkey.slice(2) }),
    );
    await Deno.writeTextFile(`${directory}/validator-keys/secrets/${pubkey}`, `secret-${pubkey}`);
  }
  // The VC's own definitions locate each key and its password, as Lighthouse writes them.
  await Deno.writeTextFile(
    `${directory}/validator-keys/keys/validator_definitions.yml`,
    "---\n" +
      keys.map((pubkey) =>
        `- enabled: true\n  voting_public_key: "${pubkey}"\n  type: local_keystore\n` +
        `  voting_keystore_path: /shared/validator-keys/keys/${pubkey}/voting-keystore.json\n` +
        `  voting_keystore_password_path: /shared/validator-keys/secrets/${pubkey}\n`
      ).join(""),
  );
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (r) => {
    const text = await r.text();
    const path = new URL(r.url).pathname;
    requests.push({
      path,
      authorization: r.headers.get("authorization"),
      body: text ? JSON.parse(text) : null,
      ...(r.method === "GET" || r.method === "POST" ? {} : { method: r.method }),
    });
    if (path === "/lighthouse/validators") {
      return Response.json({
        data: keys.map((voting_pubkey) => ({ enabled: true, description: "", voting_pubkey })),
      });
    }
    if (path === "/eth/v1/beacon/states/head/validators") {
      return Response.json({
        data: keys.map((pubkey, index) => ({
          index: String(index),
          status: "active_ongoing",
          validator: { pubkey },
        })),
      });
    }
    if (path.startsWith("/lighthouse/validators/")) return new Response(null);
    if (path === "/eth/v1/keystores" && r.method === "DELETE") {
      return Response.json({
        data: [{ status: "deleted" }],
        slashing_protection: '{"metadata":{},"data":[]}',
      });
    }
    if (/\/(feerecipient|gas_limit|graffiti)$/.test(path)) {
      return new Response(null, { status: 202 });
    }
    if (path === "/eth/v1/keystores") return Response.json({ data: [{ status: "imported" }] });
    if (path.endsWith("/voluntary_exit")) {
      return Response.json({
        data: { message: { epoch: "3", validator_index: "64" }, signature: "signed-by-keymanager" },
      });
    }
    if (path === "/eth/v1/beacon/pool/voluntary_exits") return new Response(null, { status: 200 });
    return new Response(null, { status: 404 });
  });
  const endpoint = `http://127.0.0.1:${upstream.addr.port}`;
  const time = new Timeline(0, 11_500, { move: async () => {} });
  const controller = new Controller({ validatorControl: new ValidatorControl() } as Network, {
    config: configuration(),
    directory,
    vc: endpoint,
    beacon: endpoint,
    el: endpoint,
  } as Manifest, time);
  const url = controller.serve(0);
  try {
    await run({
      requests,
      call: async (method, params) => {
        const response = await fetch(`${url}/control`, {
          method: "POST",
          body: JSON.stringify({ method, params }),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    await controller.server!.shutdown();
    await controller.automine.stop();
    await upstream.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("control imports a validator using the private authenticated keymanager", async () => {
  await fixture(async ({ call, requests }) => {
    const keystore = JSON.stringify({ version: 4, pubkey: "ab".repeat(48) });
    const result = await call("importValidator", [keystore, "password"]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, { result: null });
    assert.deepEqual(requests, [{
      path: "/eth/v1/keystores",
      authorization: "Bearer unit-secret",
      body: { keystores: [keystore], passwords: ["password"] },
    }]);
    assert.equal((await call("importValidator", ["{}", "password"])).status, 500);
    assert.equal(requests.length, 1);
  });
});

Deno.test("control forwards a signed exit to Beacon without forwarding the keymanager token", async () => {
  await fixture(async ({ call, requests }) => {
    const pubkey = `0x${"ab".repeat(48)}`;
    const result = await call("exitValidator", [pubkey]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, { result: null });
    assert.equal(requests[0].path, `/eth/v1/validator/${pubkey}/voluntary_exit`);
    assert.equal(requests[0].authorization, "Bearer unit-secret");
    assert.deepEqual(requests[1], {
      path: "/eth/v1/beacon/pool/voluntary_exits",
      authorization: null,
      body: { message: { epoch: "3", validator_index: "64" }, signature: "signed-by-keymanager" },
    });
    const invalid = await call("exitValidator", ["../../other"]);
    assert.equal(invalid.status, 500);
    assert.match(JSON.stringify(invalid.body), /pubkey/);
    assert.equal(requests.length, 2);
  });
});

Deno.test("control turns validators off and on through the VC by index or public key", async () => {
  await fixture(async ({ call, requests }) => {
    const result = await call("setValidatorsOnline", [[2, `0x${"1".repeat(96)}`], false]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const patches = requests.filter((request) => request.method === "PATCH");
    assert.deepEqual(patches, [
      {
        path: `/lighthouse/validators/0x${"2".repeat(96)}`,
        authorization: "Bearer unit-secret",
        body: { enabled: false },
        method: "PATCH",
      },
      {
        path: `/lighthouse/validators/0x${"1".repeat(96)}`,
        authorization: "Bearer unit-secret",
        body: { enabled: false },
        method: "PATCH",
      },
    ]);
    const unknown = await call("setValidatorsOnline", [[7], false]);
    assert.equal(unknown.status, 500);
    assert.match(JSON.stringify(unknown.body), /not managed/);
    assert.equal((await call("setValidatorsOnline", [[1], "no"])).status, 500);
  });
});

Deno.test("control removes a key and returns it with its slashing protection history", async () => {
  await fixture(async ({ call, requests }) => {
    const pubkey = `0x${"1".repeat(96)}`;
    const result = await call("removeValidator", [pubkey]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, {
      result: {
        pubkey,
        keystore: JSON.stringify({ version: 4, pubkey: pubkey.slice(2) }),
        password: `secret-${pubkey}`,
        slashingProtection: '{"metadata":{},"data":[]}',
      },
    });
    assert.deepEqual(requests.find((request) => request.method === "DELETE"), {
      path: "/eth/v1/keystores",
      authorization: "Bearer unit-secret",
      body: { pubkeys: [pubkey] },
      method: "DELETE",
    });
  });
});

Deno.test("control configures one validator's fee recipient, gas limit and graffiti", async () => {
  await fixture(async ({ call, requests }) => {
    const pubkey = `0x${"0".repeat(96)}`;
    const recipient = `0x${"cd".repeat(20)}`;
    const result = await call("configureValidator", [pubkey, {
      feeRecipient: recipient,
      gasLimit: 45_000_000,
      graffiti: "chronix",
    }]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(
      requests.map(({ path, body }) => ({ path, body })),
      [
        { path: `/eth/v1/validator/${pubkey}/feerecipient`, body: { ethaddress: recipient } },
        { path: `/eth/v1/validator/${pubkey}/gas_limit`, body: { gas_limit: "45000000" } },
        { path: `/eth/v1/validator/${pubkey}/graffiti`, body: { graffiti: "chronix" } },
      ],
    );
    assert.equal(
      (await call("configureValidator", [pubkey, { feeRecipient: "0x12" }])).status,
      500,
    );
    assert.equal((await call("configureValidator", [pubkey, { other: 1 }])).status, 500);
  });
});

Deno.test("control schedules slot faults only for future slots", async () => {
  await fixture(async ({ call }) => {
    assert.equal((await call("missProposal", [0])).status, 500, "current slot accepted");
    assert.equal((await call("missProposal", [3])).status, 200);
    assert.equal((await call("withholdPayload", [4])).status, 200);
    assert.equal((await call("withholdPayload", ["5"])).status, 500);
  });
});
