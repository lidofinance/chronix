import { PandaClient } from "../client/mod.js";
import { type Config } from "./config.ts";
import { Controller } from "./controller.ts";
import { defaultTimeoutMs, waitFor } from "./http.ts";
import type { SnapshotImportOptions } from "./snapshot_archive.ts";
export { PandaClient, PandaError, SnapshotOperationError } from "../client/mod.js";
export type * from "../client/types.d.ts";

/** The Panda client plus local controller ownership: start, restore from a snapshot and close. */
export class Devnet extends PandaClient {
  #controller?: Controller;
  constructor(url: string) {
    super(url, { timeoutMs: defaultTimeoutMs() });
  }
  static async start(config: Partial<Config> = {}): Promise<Devnet> {
    return Devnet.#own(await Controller.start(config));
  }
  static async fromSnapshot(
    source: string,
    config: Partial<Config> = {},
    options: SnapshotImportOptions = {},
  ): Promise<Devnet> {
    return Devnet.#own(await Controller.fromSnapshot(source, config, options));
  }
  static async #own(controller: Controller): Promise<Devnet> {
    try {
      const api = new Devnet(controller.serve(0));
      api.#controller = controller;
      return api;
    } catch (error) {
      await controller.close();
      throw error;
    }
  }
  waitForService<T>(
    description: string,
    probe: () => Promise<T | undefined>,
    timeoutMs = defaultTimeoutMs(),
  ): Promise<T> {
    return waitFor(description, probe, timeoutMs);
  }
  async close(): Promise<void> {
    await this.#controller?.close();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
