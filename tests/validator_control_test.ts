import assert from "node:assert/strict";
import { BeaconRelay } from "../src/beacon_relay.ts";
import { ConsensusMessages } from "../src/consensus_messages.ts";
import { ValidatorControl } from "../src/validator_control.ts";

const root = `0x${"ab".repeat(32)}`;

Deno.test("scheduled slot faults refuse only the VC's block or envelope request of that slot", () => {
  const control = new ValidatorControl();
  control.schedule("missProposal", 7, 5);
  control.schedule("withholdPayload", 9, 5);
  assert.equal(control.relay("POST", "/eth/v4/validator/blocks/7")?.status, 503);
  assert.equal(control.relay("POST", "/eth/v4/validator/blocks/8"), undefined);
  assert.equal(control.relay("GET", "/eth/v1/beacon/headers/head"), undefined);
  assert.equal(
    control.relay("GET", `/eth/v1/validator/execution_payload_envelopes/9/${root}`)?.status,
    503,
  );
  assert.equal(
    control.relay("GET", `/eth/v1/validator/execution_payload_envelopes/7/${root}`),
    undefined,
    "a missed proposal must not also withhold a different slot's payload",
  );
  assert.equal(control.refused(7, "block"), true);
  assert.equal(control.refused(9, "envelope"), true);
  assert.equal(control.refused(8, "block"), false);
  assert.deepEqual(control.pending(5), [
    { kind: "missProposal", slot: 7 },
    { kind: "withholdPayload", slot: 9 },
  ]);
  assert.deepEqual(control.pending(9), [], "past schedules are not pending");
});

Deno.test("slot faults must be scheduled for a future slot", () => {
  const control = new ValidatorControl();
  assert.throws(() => control.schedule("missProposal", 5, 5), /future slot/);
  assert.throws(() => control.schedule("withholdPayload", 1.5, 0), /future slot/);
});

Deno.test("the private VC relay answers a refused request without forwarding it", async () => {
  const forwarded: string[] = [];
  const native = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    forwarded.push(new URL(request.url).pathname);
    return Response.json({ data: {} });
  });
  const control = new ValidatorControl();
  control.schedule("missProposal", 7, 0);
  const relay = new BeaconRelay(
    `http://127.0.0.1:${native.addr.port}`,
    new ConsensusMessages(() => 0),
    undefined,
    control,
  );
  const base = relay.url.replace("host.docker.internal", "127.0.0.1");
  try {
    const refused = await fetch(base + "eth/v4/validator/blocks/7", { method: "POST", body: "{}" });
    assert.equal(refused.status, 503);
    await refused.body?.cancel();
    const allowed = await fetch(base + "eth/v4/validator/blocks/8", { method: "POST", body: "{}" });
    assert.equal(allowed.status, 200);
    await allowed.body?.cancel();
    assert.deepEqual(forwarded, ["/eth/v4/validator/blocks/8"]);
  } finally {
    await relay.close();
    await native.shutdown();
  }
});

Deno.test("key material follows the VC's definitions for generated and imported keys", async () => {
  const { validatorKey } = await import("../src/validator_control.ts");
  const directory = await Deno.makeTempDir();
  try {
    const keys = `${directory}/validator-keys/keys`;
    const generated = `0x${"a1".repeat(48)}`;
    const imported = `0x${"b2".repeat(48)}`;
    for (const pubkey of [generated, imported]) {
      await Deno.mkdir(`${keys}/${pubkey}`, { recursive: true });
      await Deno.writeTextFile(`${keys}/${pubkey}/voting-keystore.json`, `{"pubkey":"${pubkey}"}`);
    }
    await Deno.mkdir(`${directory}/validator-keys/secrets`, { recursive: true });
    await Deno.writeTextFile(`${directory}/validator-keys/secrets/${generated}`, "file-secret\n");
    await Deno.writeTextFile(
      `${keys}/validator_definitions.yml`,
      `---
- enabled: true
  voting_public_key: "${generated}"
  description: ""
  type: local_keystore
  voting_keystore_path: /shared/validator-keys/keys/${generated}/voting-keystore.json
  voting_keystore_password_path: /shared/validator-keys/secrets/${generated}
- enabled: false
  voting_public_key: "${imported}"
  description: ""
  type: local_keystore
  voting_keystore_path: /shared/validator-keys/keys/${imported}/voting-keystore.json
  voting_keystore_password: "inline \\"quoted\\" secret"
`,
    );
    const manifest = { directory } as Parameters<typeof validatorKey>[0];
    assert.deepEqual(await validatorKey(manifest, generated), {
      keystore: `{"pubkey":"${generated}"}`,
      password: "file-secret",
    });
    assert.deepEqual(await validatorKey(manifest, imported.toUpperCase().replace("0X", "0x")), {
      keystore: `{"pubkey":"${imported}"}`,
      password: 'inline "quoted" secret',
    });
    assert.equal(await validatorKey(manifest, `0x${"c3".repeat(48)}`), undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a payload can only be withheld from a Gloas slot", () => {
  const control = new ValidatorControl();
  control.gloasForkSlot = 64;
  assert.throws(() => control.schedule("withholdPayload", 40, 10), /Gloas/);
  control.schedule("withholdPayload", 64, 10);
  control.schedule("missProposal", 40, 10);
});

Deno.test("passwords follow Lighthouse: trailing newlines only, YAML double-quote escapes", async () => {
  const { validatorKey } = await import("../src/validator_control.ts");
  const directory = await Deno.makeTempDir();
  try {
    const keys = `${directory}/validator-keys/keys`;
    const filed = `0x${"d4".repeat(48)}`;
    const inline = `0x${"e5".repeat(48)}`;
    for (const pubkey of [filed, inline]) {
      await Deno.mkdir(`${keys}/${pubkey}`, { recursive: true });
      await Deno.writeTextFile(`${keys}/${pubkey}/voting-keystore.json`, "{}");
    }
    await Deno.mkdir(`${directory}/validator-keys/secrets`, { recursive: true });
    await Deno.writeTextFile(`${directory}/validator-keys/secrets/${filed}`, "  spaced  \r\n");
    await Deno.writeTextFile(
      `${keys}/validator_definitions.yml`,
      `---
- enabled: true
  voting_public_key: "${filed}"
  type: local_keystore
  voting_keystore_path: /shared/validator-keys/keys/${filed}/voting-keystore.json
  voting_keystore_password_path: /shared/validator-keys/secrets/${filed}
- enabled: true
  voting_public_key: "${inline}"
  type: local_keystore
  voting_keystore_path: /shared/validator-keys/keys/${inline}/voting-keystore.json
  voting_keystore_password: "tab\\there \\x41\\_\\u00e9"
`,
    );
    const manifest = { directory } as Parameters<typeof validatorKey>[0];
    assert.equal((await validatorKey(manifest, filed))?.password, "  spaced  ");
    assert.equal((await validatorKey(manifest, inline))?.password, "tab\there A é");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a missed proposal refuses every block request method of that slot", () => {
  const control = new ValidatorControl();
  control.schedule("missProposal", 7, 0);
  // Pre-Gloas VCs produce blocks with GET /eth/v3; Gloas VCs POST to /eth/v4.
  assert.equal(control.relay("GET", "/eth/v3/validator/blocks/7")?.status, 503);
  assert.equal(control.relay("POST", "/eth/v4/validator/blocks/7")?.status, 503);
  assert.equal(control.refused(7, "block"), true);
});

Deno.test("shutdown clears scheduled faults of the session", () => {
  const control = new ValidatorControl();
  control.schedule("missProposal", 7, 0);
  control.clearScheduled();
  assert.deepEqual(control.pending(0), []);
  const version = control.version;
  control.invalidate();
  assert.equal(control.version, version + 1, "a key change must invalidate slot views");
});
