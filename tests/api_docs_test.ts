import assert from "node:assert/strict";
import { apiDocs } from "../scripts/api_docs.js";

async function parsed() {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", "client/types.d.ts"],
  }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

Deno.test("OpenAPI describes every control command at /control/{method}", async () => {
  const doc = await parsed();
  const { spec: generated, markdown } = apiDocs(doc, "1.2.3");
  // deno-lint-ignore no-explicit-any
  const spec = generated as any;
  const commands = Object.values(
    doc.nodes as Record<
      string,
      { symbols: { name: string; declarations: { def: { properties: { name: string }[] } }[] }[] }
    >,
  )
    .flatMap((node) => node.symbols)
    .find((symbol) => symbol.name === "Commands")!.declarations[0].def.properties
    .map((property) => property.name);
  const routes = Object.keys(spec.paths).filter((path) => /^\/control\/./.test(path));
  assert.deepEqual(routes, commands.map((name) => `/control/${name}`));
  assert.ok(commands.includes("withholdPayload") && commands.includes("snapshotCreate"));
  assert.equal(spec.info.version, "1.2.3");
  const body = (name: string) => spec.paths[`/control/${name}`].post.requestBody;
  const result = (name: string) =>
    spec.paths[`/control/${name}`].post.responses["200"].content["application/json"].schema
      .properties.result;

  // Optional parameters are alternative tuples; a command without parameters needs no body.
  assert.equal(body("snapshotCreate").required, false);
  assert.deepEqual(
    body("snapshotRestore").content["application/json"].schema.anyOf.map((
      item: { minItems: number },
    ) => item.minItems),
    [1, 2],
  );
  assert.equal(body("snapshotRestore").required, true);
  assert.equal(body("stepSlot").content["application/json"].schema.maxItems, 0);
  assert.deepEqual(body("setValidatorsOnline").content["application/json"].schema.prefixItems[0], {
    type: "array",
    items: { anyOf: [{ type: "number" }, { type: "string" }] },
  });
  assert.deepEqual(result("missProposal"), { type: "null" });
  // Record over a literal union: every role is required.
  assert.deepEqual(spec.components.schemas.Clients.required, ["el", "bn", "vc"]);
  // Partial<Record<...>>: every key allowed, none required.
  const spec_ = spec.components.schemas.Genesis.properties.spec;
  assert.ok("SHARD_COMMITTEE_PERIOD" in spec_.properties && !spec_.required);
  // Index signatures keep extra fields of proxied documents.
  assert.deepEqual(spec.components.schemas.Status.properties.el.additionalProperties, {});
  // The Beacon finality document also carries execution_optimistic and finalized.
  assert.deepEqual(spec.components.schemas.Status.properties.finality.additionalProperties, {});
  assert.deepEqual(spec.components.schemas.ProfileName.anyOf, [
    { const: "gloas" },
    { const: "pectra" },
  ]);
  const snapshotOperation =
    spec.paths["/control/snapshotOperation"].post.responses["200"].content["application/json"]
      .schema;
  assert.ok(!snapshotOperation.required, "unknown operations return {}");
  assert.ok(markdown.includes("| `withholdPayload` |"));
  assert.ok(!JSON.stringify(spec).includes("file:///"));
  assert.ok(!("PandaClientApi" in spec.components.schemas), "only wire types are described");
});

Deno.test("a changed wire type changes the spec and an unsupported type fails", async () => {
  const doc = await parsed();
  const source = doc.nodes[new URL("../client/types.d.ts", import.meta.url).href];
  const ref = source.symbols.find((symbol: { name: string }) => symbol.name === "SnapshotRef");
  ref.declarations[0].def.properties.push({
    name: "newRequiredField",
    tsType: { kind: "keyword", value: "boolean" },
  });
  assert.ok(apiDocs(doc).spec.components.schemas.SnapshotRef.required.includes("newRequiredField"));
  ref.declarations[0].def.properties.at(-1).tsType = { kind: "conditional" };
  assert.throws(() => apiDocs(doc), /Unsupported.*conditional/);
});
