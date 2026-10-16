// Documentation only: use Deno's own parser, with no runtime schema or generator dependency.
export function apiDocs(doc, version = "unreleased") {
  if (doc.version !== 2) throw new Error(`Unsupported Deno doc version: ${doc.version}`);
  const symbols = new Map(
    Object.values(doc.nodes).flatMap((node) =>
      node.symbols.map((symbol) => [symbol.name, symbol.declarations])
    ),
  );
  const schemas = Object.create(null);
  const description = (value) => value.jsDoc?.doc ? { description: value.jsDoc.doc } : {};
  const unsupported = (kind) => {
    throw new Error(`Unsupported API documentation type: ${kind}`);
  };
  function object(def) {
    for (const key of ["methods", "callSignatures", "extends", "typeParams"]) {
      if (def[key]?.length) unsupported(key);
    }
    const properties = {};
    const required = [];
    for (const prop of def.properties ?? []) {
      if (prop.computed || !prop.tsType) unsupported(prop.name);
      properties[prop.name] = { ...schema(prop.tsType), ...description(prop) };
      if (!prop.optional) required.push(prop.name);
    }
    const index = def.indexSignatures ?? [];
    if (
      index.length > 1 || index[0]?.params[0]?.tsType?.value !== undefined &&
        index[0].params[0].tsType.value !== "string"
    ) unsupported("indexSignature");
    return {
      type: "object",
      properties,
      additionalProperties: index.length ? schema(index[0].tsType) : false,
      ...(required.length ? { required } : {}),
    };
  }
  function declaration(name) {
    const declarations = symbols.get(name);
    if (declarations?.length !== 1) unsupported(name);
    return declarations[0];
  }
  function reference(name) {
    if (!(name in schemas)) {
      const item = declaration(name);
      schemas[name] = {}; // Permit references back to a type currently being converted.
      if (item.kind === "interface") schemas[name] = object(item.def);
      else if (item.kind === "typeAlias" && !item.def.typeParams?.length) {
        schemas[name] = schema(item.def.tsType);
      } else unsupported(item.kind);
      Object.assign(schemas[name], description(item));
    }
    return { $ref: `#/components/schemas/${name}` };
  }
  /** String literal keys of a union type, such as `ClientRole`. */
  function keys(type) {
    if (type.kind === "typeRef" && !type.value.typeParams?.length) {
      const item = declaration(type.value.typeName);
      if (item.kind === "typeAlias") return keys(item.def.tsType);
    }
    if (type.kind === "literal" && type.value.kind === "string") return [type.value.string];
    if (type.kind === "union") return type.value.flatMap(keys);
    return unsupported(`record key ${type.kind}`);
  }
  function record([key, value], optional = false) {
    const item = schema(value);
    if (key.kind === "keyword" && key.value === "string") {
      return { type: "object", additionalProperties: item };
    }
    const names = keys(key);
    return {
      type: "object",
      properties: Object.fromEntries(names.map((name) => [name, item])),
      additionalProperties: false,
      ...(optional ? {} : { required: names }),
    };
  }
  function schema(type) {
    const { kind, value } = type;
    switch (kind) {
      case "keyword":
        if (value === "unknown") return {};
        if (value === "null") return { type: "null" };
        if (["string", "number", "boolean"].includes(value)) return { type: value };
        break;
      case "literal":
        if (["string", "number", "boolean"].includes(value.kind)) {
          return { const: value[value.kind] };
        }
        break;
      case "union":
        return { anyOf: value.map(schema) };
      case "parenthesized":
        return schema(value);
      case "array":
        return { type: "array", items: schema(value) };
      case "tuple":
        return {
          type: "array",
          ...(value.length ? { prefixItems: value.map(schema) } : {}),
          items: false,
          minItems: value.length,
          maxItems: value.length,
        };
      case "typeLiteral":
        return object(value);
      case "typeRef": {
        const params = value.typeParams ?? [];
        if (!params.length) return reference(value.typeName);
        if (value.typeName === "Record" && params.length === 2) return record(params);
        const inner = params[0];
        if (
          value.typeName === "Partial" && params.length === 1 && inner.kind === "typeRef" &&
          inner.value.typeName === "Record" && inner.value.typeParams?.length === 2
        ) return record(inner.value.typeParams, true);
        break;
      }
    }
    return unsupported(kind);
  }

  const commands = declaration("Commands").def.properties;
  const command = Object.fromEntries(commands.map((item) => {
    const wire = schema(item.tsType);
    if (!wire.required.includes("params")) unsupported(`${item.name} without params`);
    const params = wire.properties.params;
    const alternatives = params.anyOf ?? [params];
    return [item.name, {
      doc: item.jsDoc?.doc ?? "",
      params,
      paramsRequired: alternatives.every((alternative) => alternative.minItems > 0),
      result: wire.properties.result,
      resultRequired: wire.required.includes("result"),
    }];
  }));
  const json = (schema) => ({ "application/json": { schema } });
  const response = (description, schema, type = "application/json") => ({
    description,
    content: { [type]: { schema } },
  });
  const failure = reference("ControlError");
  // Startup input of the CI image (`CHRONIX_GENESIS`) and the CLI (`--genesis`), not an HTTP body.
  reference("Genesis");
  const responses = (schema, type, success = "Requested result.") => ({
    "200": response(success, schema, type),
    "403": response("Foreign Host/Origin.", { type: "string" }, "text/plain"),
    "500": response(
      "Request failed; inspect lifecycle and any recorded operation for current state.",
      failure,
    ),
    "503": response("Request failed while ingress is closed or not ready.", failure),
  });
  const envelope = ({ result, resultRequired }) => ({
    type: "object",
    properties: { result },
    additionalProperties: false,
    ...(resultRequired ? { required: ["result"] } : {}),
  });
  const paths = Object.fromEntries(
    Object.entries(command).map(([name, item]) => [`/control/${name}`, {
      post: {
        operationId: name,
        ...(item.doc ? { description: item.doc } : {}),
        requestBody: {
          required: item.paramsRequired,
          description: "Positional parameters; an empty body means [].",
          content: json(item.params),
        },
        responses: responses(envelope(item)),
      },
    }]),
  );
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Chronix control API",
      version,
      description:
        "Generated from client/types.d.ts. Execution JSON-RPC (POST /) and the Beacon API (/eth/*) are proxied unchanged.",
    },
    servers: [{ url: "http://127.0.0.1:8545" }],
    paths: {
      ...paths,
      "/control": {
        post: {
          operationId: "control",
          description: "Envelope form of every /control/{method} command.",
          requestBody: {
            required: true,
            content: json({
              oneOf: Object.entries(command).map(([name, item]) => ({
                type: "object",
                properties: { method: { const: name }, params: item.params },
                additionalProperties: false,
                required: item.paramsRequired ? ["method", "params"] : ["method"],
              })),
            }),
          },
          responses: responses({ anyOf: Object.values(command).map(envelope) }),
        },
      },
      "/lifecycle": {
        get: { operationId: "getLifecycle", responses: responses(reference("SnapshotLifecycle")) },
      },
      "/snapshots/{id}/archive": {
        get: {
          operationId: "exportSnapshotArchive",
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          }],
          responses: responses(
            { type: "string", format: "binary" },
            "application/gzip",
            "Compressed snapshot archive.",
          ),
        },
      },
    },
    components: { schemas },
  };
  spec.paths["/snapshots/{id}/archive"].get.responses["200"].headers = {
    "X-Chronix-SHA256": {
      description: "Compressed-file SHA-256.",
      schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    "Content-Length": {
      description: "Compressed byte count.",
      schema: { type: "integer", minimum: 0 },
    },
  };
  function typeName(value) {
    if (value.$ref) return value.$ref.split("/").at(-1);
    if (value.anyOf) return value.anyOf.map(typeName).join(" or ");
    if ("const" in value) return JSON.stringify(value.const);
    if (value.type === "array") {
      return value.items === false
        ? `[${(value.prefixItems ?? []).map(typeName).join(", ")}]`
        : `${typeName(value.items)}[]`;
    }
    return value.type ?? "any JSON";
  }
  const lines = [
    "# Control API reference",
    "",
    "Generated from `client/types.d.ts`. Regenerate with `deno task docs:api`; verify with `deno task docs:api --check`.",
    "",
    "[Client](client.md) · [OpenAPI 3.1](../client/openapi.json) · [Snapshots](snapshots.md)",
    "",
    'POST `/control/{method}` with the parameters array as the body (an empty body means `[]`), or POST `/control` with `{"method":...,"params":[...]}`. Responses wrap `{"result":...}`.',
    "",
    "| Method | Parameters | Result | Behavior |",
    "| --- | --- | --- | --- |",
    ...Object.entries(command).map(([name, item]) =>
      `| \`${name}\` | \`${typeName(item.params)}\` | \`${typeName(item.result)}\`${
        item.resultRequired ? "" : " (optional)"
      } | ${item.doc.replaceAll("\n", " ")} |`
    ),
    "",
    "An unknown `snapshotOperation` returns `{}`. Errors use `ControlError`: inspect lifecycle and any recorded operation after HTTP 500; HTTP 503 indicates closed or unready ingress. Foreign Host/Origin requests receive 403 with plain text.",
    "",
    "GET `/lifecycle` returns `SnapshotLifecycle` directly. GET `/snapshots/{id}/archive` returns gzip bytes with `X-Chronix-SHA256` and `Content-Length`. Import via startup `--snapshot` or `CHRONIX_SNAPSHOT`, not an HTTP upload.",
    "",
    "Field types, required properties and descriptions are defined in the linked OpenAPI schemas.",
  ];
  return { spec, markdown: `${lines.join("\n")}\n`, clientMarkdown: clientDocs() };

  /** The SDK reference: constructor, methods, errors and public types of `client/types.d.ts`. */
  function clientDocs() {
    const all = (name) => symbols.get(name) ?? [];
    const one = (name, kind) => {
      const found = all(name).filter((item) => item.kind === kind);
      if (found.length !== 1) unsupported(`${kind} ${name}`);
      return found[0];
    };
    const commandType = (name) => {
      const item = commands.find((command) => command.name === name);
      if (!item) unsupported(`command ${name}`);
      return item;
    };
    /** `Result<"x">` is the promise of command x's result. */
    const resultOf = (type) =>
      type.kind === "typeRef" && type.value.typeName === "Result" &&
        type.value.typeParams?.[0]?.kind === "literal"
        ? type.value.typeParams[0].value.string
        : undefined;
    function print(type) {
      const { kind, value } = type;
      switch (kind) {
        case "keyword":
          return value;
        case "literal":
          return value.kind === "string" ? JSON.stringify(value.string) : String(value[value.kind]);
        case "typeRef": {
          const command = resultOf(type);
          if (command) {
            const result = commandType(command).tsType.value.properties.find((prop) =>
              prop.name === "result"
            );
            return `Promise<${print(result.tsType)}${result.optional ? " | undefined" : ""}>`;
          }
          const params = value.typeParams ?? [];
          if (value.typeName === "Result" && params.length === 1) {
            return `Promise<Commands[${print(params[0])}]["result"]>`; // internal alias
          }
          return params.length
            ? `${value.typeName}<${params.map(print).join(", ")}>`
            : value.typeName;
        }
        case "union":
          return value.map(print).join(" | ");
        case "parenthesized":
          return `(${print(value)})`;
        case "array":
          return `${print(value)}[]`;
        case "tuple":
          return `[${value.map(print).join(", ")}]`;
        case "indexedAccess":
          return `${print(value.objType)}[${print(value.indexType)}]`;
        case "typeOperator":
          return `${value.operator} ${print(value.tsType)}`;
        case "fnOrConstructor":
          return `(${value.params.map(parameter).join(", ")}) => ${print(value.tsType)}`;
        case "typeLiteral": {
          const members = [
            ...(value.properties ?? []).map((prop) =>
              `${prop.name}${prop.optional ? "?" : ""}: ${print(prop.tsType)}`
            ),
            ...(value.indexSignatures ?? []).map((index) =>
              `[${index.params.map(parameter).join(", ")}]: ${print(index.tsType)}`
            ),
          ];
          return `{ ${members.join("; ")} }`;
        }
      }
      return unsupported(kind);
    }
    function parameter(param) {
      if (param.kind !== "identifier") unsupported(`parameter ${param.kind}`);
      return `${param.name}${param.optional ? "?" : ""}: ${print(param.tsType)}`;
    }
    const typeParams = (params = []) =>
      params.length
        ? `<${
          params.map((param) =>
            `${param.name}${param.constraint ? ` extends ${print(param.constraint)}` : ""}${
              param.default ? ` = ${print(param.default)}` : ""
            }`
          ).join(", ")
        }>`
        : "";
    const doc = (item) => item?.jsDoc?.doc ?? "";
    const cell = (text) => text.replaceAll("\n", " ").replaceAll("|", "\\|");
    const fields = (properties) => [
      "| Field | Type | Required | Description |",
      "| --- | --- | --- | --- |",
      ...properties.map((prop) =>
        `| \`${prop.name}\` | \`${cell(print(prop.tsType))}\` | ${prop.optional ? "no" : "yes"} | ${
          cell(doc(prop))
        } |`
      ),
    ];
    const code = (text) => ["```ts", text, "```"];

    const client = one("ChronixClient", "class");
    const api = one("ChronixClientApi", "interface").def;
    const options = one("ChronixClientOptions", "interface");
    const constructor = client.def.constructors[0];
    const out = [
      "# Chronix client API reference",
      "",
      "Generated from `client/types.d.ts`. Regenerate with `deno task docs:api`; verify with `deno task docs:api --check`.",
      "",
      "[Client guide](client.md) · [Control API reference](control-api.md) · [OpenAPI 3.1](../client/openapi.json)",
      "",
      "## `ChronixClient`",
      "",
      ...code(`new ChronixClient(${constructor.params.map(parameter).join(", ")})`),
      "",
      doc(client),
      "",
      `\`${api.properties.map((prop) => prop.name).join("`, `")}\` is read-only.`,
      "",
      "Options (`ChronixClientOptions`):",
      "",
      ...fields(options.def.properties),
      "",
      "## Methods",
    ];
    for (const method of api.methods) {
      const command = resultOf(method.returnType);
      const description = doc(method) || (command ? doc(commandType(command)) : "");
      out.push(
        "",
        `### \`${method.name}\``,
        "",
        ...code(
          `${method.name}${typeParams(method.typeParams)}(${
            method.params.map(parameter).join(", ")
          }): ${print(method.returnType)}`,
        ),
        ...(description ? ["", description] : []),
        ...(command ? ["", `Sends \`POST /control/${command}\`.`] : []),
      );
    }
    out.push("", "## Errors");
    for (const name of ["ChronixError", "SnapshotOperationError"]) {
      const item = one(name, "class");
      out.push(
        "",
        `### \`${name}\``,
        "",
        ...code(
          `class ${name}${item.def.extends ? ` extends ${item.def.extends}` : ""}`,
        ),
        "",
        doc(item),
        "",
        ...fields(item.def.properties),
      );
    }
    out.push(
      "",
      "## Types",
      "",
      "`Commands` maps every control command to its parameter tuple and result; see the [control API reference](control-api.md).",
    );
    const internal = new Set([
      "ChronixClient",
      "ChronixClientApi",
      "ChronixClientOptions",
      "ChronixError",
      "SnapshotOperationError",
      "Commands",
      "createClient",
    ]);
    const names = [...symbols.keys()].filter((name) =>
      !internal.has(name) &&
      all(name).some((item) =>
        item.declarationKind === "export" && ["interface", "typeAlias"].includes(item.kind)
      )
    ).sort();
    for (const name of names) {
      const item = all(name).find((entry) => ["interface", "typeAlias"].includes(entry.kind));
      out.push("", `### \`${name}\``, "");
      if (doc(item)) out.push(doc(item), "");
      if (item.kind === "interface") out.push(...fields(item.def.properties));
      else {out.push(
          ...code(`type ${name}${typeParams(item.def.typeParams)} = ${print(item.def.tsType)}`),
        );}
    }
    return `${out.join("\n")}\n`;
  }
}

if (import.meta.main) {
  if (Deno.args.some((arg) => arg !== "--check")) {
    throw new Error("Usage: api_docs.js [--check]");
  }
  const cwd = new URL("..", import.meta.url);
  const parsed = await new Deno.Command(Deno.execPath(), {
    cwd,
    args: ["doc", "--json", "client/types.d.ts"],
  }).output();
  if (!parsed.success) throw new Error(new TextDecoder().decode(parsed.stderr));
  const { spec, markdown, clientMarkdown } = apiDocs(
    JSON.parse(new TextDecoder().decode(parsed.stdout)),
  );
  for (
    const [path, value] of [
      ["client/openapi.json", JSON.stringify(spec)],
      ["docs/control-api.md", markdown],
      ["docs/client-api.md", clientMarkdown],
    ]
  ) {
    const fmt = new Deno.Command(Deno.execPath(), {
      cwd,
      args: ["fmt", `--ext=${path.endsWith("json") ? "json" : "md"}`, "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const input = fmt.stdin.getWriter();
    await input.write(new TextEncoder().encode(value));
    await input.close();
    const formatted = await fmt.output();
    if (!formatted.success) throw new Error(`Formatting failed: ${path}`);
    const text = new TextDecoder().decode(formatted.stdout);
    const file = new URL(path, cwd);
    if (Deno.args.includes("--check")) {
      const current = await Deno.readTextFile(file).catch(() => "");
      if (current !== text) throw new Error(`Stale ${path}; run deno task docs:api`);
    } else await Deno.writeTextFile(file, text);
    console.log(`${Deno.args.includes("--check") ? "Checked" : "Generated"} ${path}`);
  }
}
