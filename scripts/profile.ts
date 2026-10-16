import { Devnet } from "../src/api.ts";
import { diskUsage, sampleResources } from "../src/profile.ts";
const id = Deno.env.get("CHRONIX_ID") ?? "local";
const endpoint = JSON.parse(await Deno.readTextFile(`.chronix/${id}/controller.json`));
const devnet = new Devnet(endpoint.url);
await devnet.setAutomine(false);
const paused = await sampleResources(id, 5000, devnet.url);
const start = performance.now();
const [_, load] = await Promise.all([
  devnet.advanceSlots(32),
  sampleResources(id, 5000, devnet.url),
]);
const elapsedMs = performance.now() - start;
const measurement = {
  recordedAt: new Date().toISOString(),
  id,
  paused,
  load,
  slots: 32,
  elapsedMs,
  slotsPerSecond: 32000 / elapsedMs,
  disk: await diskUsage(id),
};
await Deno.mkdir("reports", { recursive: true });
await Deno.writeTextFile(`reports/profile-${id}.json`, JSON.stringify(measurement, null, 2));
console.log(JSON.stringify(measurement));
