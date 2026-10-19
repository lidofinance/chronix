import { argumentsFor } from "../src/arguments.ts";
import { bake } from "../src/baker.ts";
import { maintainedProfile } from "../src/profiles.ts";
const { flags, positional } = argumentsFor(Deno.args, [
  "tag",
  "import-cl",
  "reuse-cl",
  "cl-ref",
  "patch",
  "genesis-image",
  "baseline-image",
  "rust-image",
], ["replace"]);
if (positional.length > 1) throw new Error("Usage: deno task bake <hardfork> [--tag <name>]");
const result = await bake(maintainedProfile(positional[0] ?? "gloas"), {
  tag: flags.tag,
  replace: flags.replace === "true",
  importCl: flags["import-cl"],
  reuseCl: flags["reuse-cl"],
  clRef: flags["cl-ref"],
  patch: flags.patch,
  genesisImage: flags["genesis-image"],
  baselineImage: flags["baseline-image"],
  rustImage: flags["rust-image"],
});
console.log(
  JSON.stringify({
    event: "bake-complete",
    profile: result.profile,
    tag: result.tag,
    key: result.key,
    images: result.images,
  }),
);
