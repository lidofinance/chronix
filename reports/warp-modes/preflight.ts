import { Infrastructure, LABEL } from "../../src/docker.ts";
import { readBake } from "../../src/profiles.ts";
import { ensureImage } from "../../src/client_images.ts";
import { configuration } from "../../src/config.ts";
import { elImage, readEl } from "../../src/el_client.ts";
const infra = new Infrastructure("warp-modes-preflight");
const running = await infra.docker.listContainers();
console.log(
  JSON.stringify({
    runningPanda: running.filter((c) => c.Labels[LABEL]).map((c) => ({
      id: c.Labels[LABEL],
      names: c.Names,
    })),
  }),
);
for (const [profile, tag] of [["gloas", "direct-sync"], ["pectra", "panda"]] as const) {
  const bake = await readBake(profile, tag);
  const el = elImage(readEl(configuration().el), bake.images.cl.platform);
  for (const image of [bake.images.cl, el, bake.images.genesis]) {
    await ensureImage(infra, image);
  }
  console.log(JSON.stringify({ profile, tag, key: bake.key, imagesReady: true }));
}
