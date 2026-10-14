import assert from "node:assert/strict";
import { dirname, join, normalize } from "node:path";
import { imageSources } from "../src/release.ts";

/** Every local module reachable from the container entry points, as the image must contain them. */
async function localImports(entries: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const visit = async (path: string) => {
    path = normalize(path);
    if (seen.has(path)) return;
    seen.add(path);
    if (!/\.(ts|js)$/.test(path)) return;
    const source = await Deno.readTextFile(path);
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      await visit(join(dirname(path), match[1]));
    }
  };
  for (const entry of entries) await visit(entry);
  return seen;
}

Deno.test("the CI image contains every module its entry points import", async () => {
  const files = await localImports([
    "container/main.ts",
    "container/health.ts",
    "container/clients.ts",
  ]);
  const missing = [...files].filter((file) =>
    !/^bakes\/[^/]+\/recipe\.json$/.test(file) && // copied per profile by package_image.ts
    !imageSources.some((source) => file === source || file.startsWith(`${source}/`))
  );
  assert.deepEqual(missing, []);
  assert.ok(files.has("client/mod.js"), "the controller uses the client's error types");
  const dockerfile = await Deno.readTextFile("container/Dockerfile");
  const copies = [...dockerfile.matchAll(/^COPY (?!--from)(.+)$/gm)].map((match) => {
    const words = match[1].trim().split(/\s+/);
    return { sources: words.slice(0, -1), target: words.at(-1) };
  });
  for (const source of imageSources) {
    // Directories keep their path; files land in the working directory.
    const copied = copies.some(({ sources, target }) =>
      sources.length === 1 && sources[0] === `${source}/` && target === `${source}/` ||
      sources.includes(source) && target === "./"
    );
    assert.ok(copied, `Dockerfile must copy ${source} to the same path`);
  }
});
