// Consumer check of the client package: Node unit tests of the source, then the GitHub install
// path (`npm i git+...#<commit>`) of a throwaway commit of the working tree, a strict `tsc` of the
// installed types and a Node run of the installed JavaScript. Requires Node 22+ and network access
// for the pinned TypeScript compiler.
import assert from "node:assert/strict";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const typescript = "typescript@5.9.3";
const root = new URL("..", import.meta.url).pathname;

async function run(command: string, args: string[], cwd = root): Promise<string> {
  const result = await new Deno.Command(command, { args, cwd, stdout: "piped", stderr: "piped" })
    .output();
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  if (!result.success) throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
  return output;
}

const node = (await run("node", ["--version"])).trim();
assert(Number(node.slice(1).split(".")[0]) >= 22, `Node 22+ is required, found ${node}`);
console.log(await run("node", ["--test", "tests/client_test.ts"]));

const work = await Deno.makeTempDir({ prefix: "panda-client-consumer-" });
try {
  // The package as GitHub serves it: a commit of every tracked and new, non-ignored file.
  const repository = join(work, "repository");
  const files = (await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"]))
    .split("\n").filter(Boolean);
  for (const file of files) {
    try {
      await mkdir(dirname(join(repository, file)), { recursive: true });
      await cp(join(root, file), join(repository, file));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error; // deleted, not yet staged
    }
  }
  await run("git", ["init", "-q"], repository);
  await run("git", ["add", "-A"], repository);
  await run("git", [
    "-c",
    "user.name=panda",
    "-c",
    "user.email=panda@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "client consumer check",
  ], repository);
  const commit = (await run("git", ["rev-parse", "HEAD"], repository)).trim();

  const consumer = join(work, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  await run("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    `git+file://${repository}#${commit}`,
    typescript,
  ], consumer);
  const installed = join(consumer, "node_modules/@lidofinance/panda-client");
  const listing = async (path: string): Promise<string[]> =>
    (await Promise.all(
      (await readdir(path, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? listing(join(path, entry.name)).then((names) =>
            names.map((name) => `${entry.name}/${name}`)
          )
          : [entry.name]
      ),
    )).flat().sort();
  assert.deepEqual(await listing(installed), [
    "LICENSE",
    "README.md",
    "client/mod.js",
    "client/openapi.json",
    "client/types.d.ts",
    "package.json",
  ]);

  // Types as a strict TypeScript project sees them, without any tsconfig changes.
  await writeFile(
    join(consumer, "check.ts"),
    `import { PandaClient, PandaError, type Commands, type Step } from "@lidofinance/panda-client";
export async function scenario(client: PandaClient): Promise<number> {
  const step: Step = await client.advanceSlots(2);
  await client.advanceTime(60, { mode: "fast" });
  const removed: Commands["removeValidator"]["result"] = await client.removeValidator("0x00");
  // @ts-expect-error a slot count is a number
  await client.advanceSlots("2");
  // @ts-expect-error unknown commands are rejected
  await client.command("noSuchCommand", []);
  // @ts-expect-error warp modes are honest or fast
  await client.advanceTime(1, { mode: "quick" });
  return step.slot + removed.slashingProtection.length + (new PandaError("x", 500)).status;
}
`,
  );
  await run("npx", [
    "tsc",
    "--noEmit",
    "--strict",
    "--exactOptionalPropertyTypes",
    "--noUncheckedIndexedAccess",
    "--module",
    "nodenext",
    "--target",
    "es2022",
    "--lib",
    "es2022,dom",
    "check.ts",
  ], consumer);

  // The installed JavaScript under plain Node, against a stub controller.
  await writeFile(
    join(consumer, "run.mjs"),
    `import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PandaClient } from "@lidofinance/panda-client";
const seen = [];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => body += chunk);
  request.on("end", () => {
    seen.push([request.url, body]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { now: 24, slot: 2 } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const client = new PandaClient("http://127.0.0.1:" + server.address().port);
assert.deepEqual(await client.advanceSlots(2), { now: 24, slot: 2 });
assert.deepEqual(seen, [["/control/advanceSlots", "[2]"]]);
server.closeAllConnections();
server.close();
console.log("installed client ok");
`,
  );
  console.log(await run("node", ["run.mjs"], consumer));
} finally {
  await Deno.remove(work, { recursive: true });
}
