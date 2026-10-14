import {
  pinPublishedClients,
  readPublishedClients,
  restorePublishedClients,
} from "../src/client_release.ts";
import { Infrastructure } from "../src/docker.ts";
import { maintainedProfile } from "../src/profiles.ts";
import { registryAuth } from "../src/registry.ts";

const [command, value] = Deno.args;
if (Deno.args.length !== 2) {
  throw new Error("Usage: clients.ts pin <clients.json> | check|restore <profile>");
}
if (command === "pin") {
  console.log(await pinPublishedClients(JSON.parse(await Deno.readTextFile(value))));
} else if (command === "check") {
  const release = await readPublishedClients(maintainedProfile(value));
  console.log(`${value}: ${release.lighthouse.digest}`);
} else if (command === "restore") {
  const release = await readPublishedClients(maintainedProfile(value));
  const infra = new Infrastructure(`release-${value}`);
  await restorePublishedClients(
    release,
    (image) =>
      infra.registryImage(
        image,
        image.digest?.startsWith("ghcr.io/") && Deno.env.get("GHCR_TOKEN")
          ? registryAuth()
          : undefined,
      ),
  );
  const output = Deno.env.get("GITHUB_OUTPUT");
  if (output) await Deno.writeTextFile(output, `bake=${release.bake.tag}\n`, { append: true });
  console.log(
    JSON.stringify({
      event: "clients-restored",
      profile: value,
      bake: release.bake.tag,
      bakeKey: release.bake.key,
      lighthouse: release.lighthouse.digest,
    }),
  );
} else {
  throw new Error("Usage: clients.ts pin <clients.json> | check|restore <profile>");
}
