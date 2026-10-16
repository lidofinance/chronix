import { argumentsFor } from "../src/arguments.ts";
import { testClock } from "../src/baker.ts";
import { maintainedProfile } from "../src/profiles.ts";
const { flags, positional } = argumentsFor(Deno.args, ["bake"]);
if (positional.length > 1) throw new Error("Usage: deno task test:clock <hardfork> [--bake <tag>]");
await testClock(
  maintainedProfile(positional[0] ?? Deno.env.get("CHRONIX_PROFILE") ?? "gloas"),
  flags.bake ?? Deno.env.get("CHRONIX_BAKE") ?? "default",
);
