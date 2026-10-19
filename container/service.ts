import { StateStore } from "../src/storage.ts";
import { ensureImage, saveImage } from "../src/client_images.ts";
import { Controller } from "../src/controller.ts";
import {
  allowedHosts,
  type Config,
  configuration,
  entryNetwork,
  type NetworkOptions,
} from "../src/config.ts";
import { elImage, readEl } from "../src/el_client.ts";
import { Network, snapshotCapable } from "../src/network.ts";
import { Infrastructure } from "../src/docker.ts";
import { waitFor } from "../src/http.ts";
import { type Bake, type BakedImage, maintainedProfile, readBake } from "../src/profiles.ts";
import { releaseMetadata } from "../src/release.ts";
import { type Relay, tcpRelay } from "./relay.ts";

type Release = ReturnType<typeof releaseMetadata>;

/** The packaged release and its bake; the image serves nothing else. */
export async function packagedBake(): Promise<{ release: Release; bake: Bake }> {
  const release = JSON.parse(await Deno.readTextFile("release.json"));
  const bake = await readBake(maintainedProfile(release.profile), release.bake);
  const expected = releaseMetadata(bake, release.image, release.sourceCommit, release.lighthouse);
  if (JSON.stringify(expected) !== JSON.stringify(release)) {
    throw new Error("Packaged release metadata does not match the bake");
  }
  return { release, bake };
}

/** The container's own Docker daemon. */
export class PrivateDaemon {
  exited = false;
  readonly exit: Promise<Deno.CommandStatus>;
  private readonly process: Deno.ChildProcess;
  constructor() {
    // Explicit dockerd arguments bypass the upstream entrypoint's default TCP listener.
    this.process = new Deno.Command("dockerd-entrypoint.sh", {
      args: [
        "dockerd",
        "--host=unix:///var/run/docker.sock",
        "--config-file=/opt/chronix/container/daemon.json",
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    this.exit = this.process.status.then((status) => {
      this.exited = true;
      return status;
    });
  }
  async ready(infra: Infrastructure, signal: AbortSignal): Promise<void> {
    await waitFor("private Docker daemon", async () => {
      if (this.exited || signal.aborted) throw new Error("Docker startup interrupted");
      return await infra.docker.ping().then(() => true).catch(() => undefined);
    });
  }
  /** SIGTERM, then SIGKILL after 30 s. */
  async stop(): Promise<void> {
    if (!this.exited) this.process.kill("SIGTERM");
    const timeout = setTimeout(() => {
      if (!this.exited) this.process.kill("SIGKILL");
    }, 30_000);
    await this.exit;
    clearTimeout(timeout);
  }
}

/**
 * Lighthouse and genesis come before the controller, with the registry digests of the release.
 * The network's EL is resolved by the controller from its configuration.
 */
export async function loadImages(
  infra: Infrastructure,
  release: Release,
  signal: AbortSignal,
): Promise<void> {
  for (const role of ["cl", "genesis"] as const) {
    if (signal.aborted) throw new Error("Image loading interrupted");
    await ensureImage(infra, release.clients[role]);
  }
}

/** The images `chronix clients save` archives: the release's Lighthouse and genesis, the EL. */
export function clientImages(
  release: Release,
  el: string,
): Record<"el" | "cl" | "genesis", BakedImage> {
  return {
    el: elImage(readEl(el), release.platform),
    cl: release.clients.cl,
    genesis: release.clients.genesis,
  };
}

/** The EL `clients save` archives: its argument, else the EL the service would select. */
export function savedEl(
  bake: Pick<Bake, "profile" | "tag">,
  argument: string | undefined,
  network: NetworkOptions,
  el?: string,
): string {
  return argument ?? configuration(serviceSelection(bake, "clients", network, el)).el;
}

/** `chronix clients save [<el>]`: registry images into the mounted archive directory. */
export async function saveClients(el?: string): Promise<string[]> {
  const { release, bake } = await packagedBake();
  const network = entryNetwork(Deno.env.get("CHRONIX_NETWORK"), Deno.env.get("CHRONIX_GENESIS"));
  const images = Object.values(
    clientImages(release, savedEl(bake, el, network, Deno.env.get("CHRONIX_EL"))),
  );
  const infra = new Infrastructure("clients");
  const daemon = new PrivateDaemon();
  try {
    await daemon.ready(infra, new AbortController().signal);
    const paths: string[] = [];
    for (const image of images) paths.push(await saveImage(infra, image));
    return paths;
  } finally {
    await daemon.stop();
  }
}

/**
 * The network the packaged service asks for. `CHRONIX_EL` is an explicit request, as in the CLI: a
 * retained network or a snapshot seed on another EL is refused, never silently resumed.
 */
export function serviceSelection(
  bake: Pick<Bake, "profile" | "tag">,
  id: string,
  network: NetworkOptions,
  el?: string,
): Partial<Config> {
  if (el !== undefined && network.el !== undefined) {
    throw new Error("Select el in CHRONIX_NETWORK or with CHRONIX_EL, not both");
  }
  const selection = {
    id,
    profile: bake.profile,
    bake: bake.tag,
    ...(el === undefined ? {} : { el }),
    ...network,
  };
  configuration(selection);
  return selection;
}

/** Serve the packaged network until a signal, a client failure or a daemon exit. */
export async function runService(): Promise<void> {
  const { release, bake } = await packagedBake();
  const id = Deno.env.get("CHRONIX_ID") ?? "service";
  // Invalid network options fail before the private Docker daemon starts.
  const network = entryNetwork(Deno.env.get("CHRONIX_NETWORK"), Deno.env.get("CHRONIX_GENESIS"));
  const selection = serviceSelection(bake, id, network, Deno.env.get("CHRONIX_EL"));
  const hosts = allowedHosts(Deno.env.get("CHRONIX_ALLOWED_HOSTS"));
  Deno.env.set("CHRONIX_DATA_DIR", Deno.env.get("CHRONIX_DATA_DIR") ?? "/data");
  const infra = new Infrastructure(id);
  const abort = new AbortController();
  const stop = () => abort.abort();
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  const daemon = new PrivateDaemon();
  let controller: Controller | undefined;
  const relays: Relay[] = [];
  try {
    await daemon.ready(infra, abort.signal);
    await loadImages(infra, release, abort.signal);
    await Deno.mkdir("/run/chronix", { recursive: true });
    await Deno.writeTextFile("/run/chronix/id", id, { mode: 0o600 });
    if (!snapshotCapable(configuration(selection), bake) && await new StateStore(id).active()) {
      // Without snapshot support the service contract remains a fresh genesis, as before.
      await new Network(configuration(selection)).stop();
    }
    const seed = Deno.env.get("CHRONIX_SNAPSHOT");
    controller = await Controller.launch(
      selection,
      seed ? { source: seed, sha256: Deno.env.get("CHRONIX_SNAPSHOT_SHA256") } : undefined,
    );
    controller.allowHosts(hosts);
    const upstream = controller.serve(0);
    relays.push(tcpRelay(() => upstream, 8545));
    const beacon = controller.serveClient("beacon");
    const validator = controller.serveClient("vc");
    relays.push(tcpRelay(() => beacon, 5052));
    relays.push(tcpRelay(() => validator, 5062));
    console.log(JSON.stringify({
      event: "ready",
      id,
      url: "http://127.0.0.1:8545",
      beacon: "http://127.0.0.1:5052",
      validator: "http://127.0.0.1:5062",
      ...release,
    }));
    if (!abort.signal.aborted) {
      await Promise.race([
        new Promise<void>((resolve) =>
          abort.signal.addEventListener("abort", () => resolve(), { once: true })
        ),
        daemon.exit.then((status) => {
          throw new Error(`Private Docker exited: ${status.code}`);
        }),
        controller.server!.finished,
        ...relays.map((relay) => relay.finished),
      ]);
    }
  } finally {
    stop();
    await Promise.allSettled(relays.map((relay) => relay.close()));
    try {
      await controller?.closePreserving();
    } finally {
      await daemon.stop();
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
    }
  }
}
