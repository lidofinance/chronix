import { type Config } from "./config.ts";
import { Controller } from "./controller.ts";
import { defaultTimeoutMs, json, rpc, waitFor } from "./http.ts";
import type { WarpOptions } from "./time.ts";
export type { WarpMode, WarpOptions } from "./time.ts";

import type {
  SnapshotOperationRecord,
  SnapshotRef,
  SnapshotRestoreResult,
} from "./snapshot_types.ts";
import { SnapshotOperationError } from "./snapshot_types.ts";
import { saveSnapshotStream, type SnapshotImportOptions } from "./snapshot_archive.ts";
export type { SnapshotRef, SnapshotRestoreResult } from "./snapshot_types.ts";
import type { ClientRole, ClientState } from "./network.ts";
export type { ClientRole, ClientState } from "./network.ts";
export type { Genesis, GenesisAccount, ValidatorGroup } from "./genesis.ts";
import type { ManagedValidator } from "./validator_control.ts";
export type { ManagedValidator } from "./validator_control.ts";

export class Devnet {
  private controller?: Controller;
  constructor(readonly url: string) {}
  static async start(config: Partial<Config> = {}): Promise<Devnet> {
    const controller = await Controller.start(config);
    try {
      const api = new Devnet(controller.serve(0));
      api.controller = controller;
      return api;
    } catch (error) {
      await controller.close();
      throw error;
    }
  }
  private async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(`${this.url}/control`, {
      method: "POST",
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(defaultTimeoutMs()),
    });
    const body = await response.json();
    if (!response.ok) {
      if (body.operation) throw new SnapshotOperationError(body.operation);
      throw new Error(body.error ?? `Control HTTP ${response.status}`);
    }
    return body.result;
  }
  static async fromSnapshot(
    source: string,
    config: Partial<Config> = {},
    options: SnapshotImportOptions = {},
  ): Promise<Devnet> {
    const controller = await Controller.fromSnapshot(source, config, options);
    try {
      const api = new Devnet(controller.serve(0));
      api.controller = controller;
      return api;
    } catch (error) {
      await controller.close();
      throw error;
    }
  }
  lifecycle(): Promise<ReturnType<Controller["lifecycle"]>> {
    return this.call("lifecycle");
  }
  createSnapshot(operationId: string = crypto.randomUUID()): Promise<SnapshotRef> {
    return this.call("snapshotCreate", [operationId]);
  }
  listSnapshots(): Promise<SnapshotRef[]> {
    return this.call("snapshotList");
  }
  restoreSnapshot(
    snapshot: SnapshotRef | string,
    operationId: string = crypto.randomUUID(),
  ): Promise<SnapshotRestoreResult> {
    return this.call("snapshotRestore", [
      typeof snapshot === "string" ? snapshot : snapshot.id,
      operationId,
    ]);
  }
  removeSnapshot(
    snapshot: SnapshotRef | string,
    operationId: string = crypto.randomUUID(),
  ): Promise<SnapshotRef> {
    return this.call("snapshotRemove", [
      typeof snapshot === "string" ? snapshot : snapshot.id,
      operationId,
    ]);
  }
  snapshotOperation(id: string): Promise<SnapshotOperationRecord | undefined> {
    return this.call("snapshotOperation", [id]);
  }
  async exportSnapshot(snapshot: SnapshotRef | string, path: string) {
    const id = typeof snapshot === "string" ? snapshot : snapshot.id;
    const response = await fetch(`${this.url}/snapshots/${id}/archive`, {
      signal: AbortSignal.timeout(defaultTimeoutMs()),
    });
    if (!response.ok || !response.body) throw new Error(`Snapshot export HTTP ${response.status}`);
    return await saveSnapshotStream(response.body, path, {
      sha256: response.headers.get("x-panda-sha256") ?? undefined,
    });
  }
  stop(): Promise<ReturnType<Controller["lifecycle"]>> {
    return this.call("stop");
  }
  resume(): Promise<ReturnType<Controller["lifecycle"]>> {
    return this.call("resume");
  }
  status(): Promise<
    {
      id: string;
      profile: import("./profiles.ts").ProfileName;
      bake: string;
      bakeKey: string;
      sessionId: string;
      now: number;
      slot: number;
      automine: boolean;
      automineError?: string;
      el: { hash: string; number: string; timestamp: string };
      finality: { data: { finalized: { epoch: string; root: string } } };
    }
  > {
    return this.call("status");
  }
  stepSlot(): Promise<void> {
    return this.call("stepSlot");
  }
  advanceSlots(count: number): Promise<void> {
    return this.call("advanceSlots", [count]);
  }
  advanceEpochs(count: number): Promise<void> {
    return this.call("advanceEpochs", [count]);
  }
  advanceTime(seconds: number, options?: WarpOptions): Promise<void> {
    return this.call("advanceTime", options === undefined ? [seconds] : [seconds, options]);
  }
  advanceTo(timestamp: number | Date, options?: WarpOptions): Promise<void> {
    const seconds = timestamp instanceof Date ? timestamp.getTime() / 1000 : timestamp;
    return this.call("advanceTo", options === undefined ? [seconds] : [seconds, options]);
  }
  skipSlots(count: number): Promise<void> {
    return this.call("skipSlots", [count]);
  }
  setAutomine(enabled: boolean): Promise<void> {
    return this.call("setAutomine", [enabled]);
  }
  /** Container state of the managed EL, beacon node and validator client. */
  clients(): Promise<Record<ClientRole, ClientState>> {
    return this.call("clients");
  }
  /** Stop or (with `kill`) crash a client. Time mutations are refused until it is started. */
  stopClient(role: ClientRole, options: { kill?: boolean } = {}): Promise<unknown> {
    return this.call("stopClient", [role, options]);
  }
  /** Start a stopped client from its own data at the current protocol time. */
  startClient(role: ClientRole): Promise<unknown> {
    return this.call("startClient", [role]);
  }
  restartClient(role: ClientRole, options: { kill?: boolean } = {}): Promise<unknown> {
    return this.call("restartClient", [role, options]);
  }
  /** Every registry validator, whether its key is in the VC (`managed`) and enabled (`online`). */
  validators(): Promise<ManagedValidator[]> {
    return this.call("validators");
  }
  /** Offline validators keep their keys and history but stop every duty until set online. */
  setValidatorsOnline(selector: (number | string)[], online: boolean): Promise<null> {
    return this.call("setValidatorsOnline", [selector, online]);
  }
  /** Remove a key from the VC; returns it with its slashing protection interchange JSON. */
  removeValidator(pubkey: string): Promise<{
    pubkey: string;
    keystore?: string;
    password?: string;
    slashingProtection: string;
  }> {
    return this.call("removeValidator", [pubkey]);
  }
  configureValidator(
    pubkey: string,
    settings: { feeRecipient?: string; gasLimit?: number; graffiti?: string },
  ): Promise<null> {
    return this.call("configureValidator", [pubkey, settings]);
  }
  /** The block of a future slot is not produced; every other duty continues. */
  missProposal(slot: number): Promise<null> {
    return this.call("missProposal", [slot]);
  }
  /** Gloas: the block of a future slot is published, its execution payload envelope is not. */
  withholdPayload(slot: number): Promise<null> {
    return this.call("withholdPayload", [slot]);
  }
  importValidator(keystore: string, password: string): Promise<void> {
    return this.call("importValidator", [keystore, password]);
  }
  exitValidator(pubkey: string): Promise<void> {
    return this.call("exitValidator", [pubkey]);
  }
  rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return rpc(this.url, method, params);
  }
  async beacon<T = unknown>(path: string): Promise<T> {
    return await json(`${this.url}${path}`);
  }
  async advanceUntil(
    predicate: () => Promise<boolean>,
    options: { maxSlots: number; timeoutMs?: number },
  ): Promise<number> {
    if (!Number.isSafeInteger(options.maxSlots) || options.maxSlots < 0) {
      throw new Error("maxSlots must be a non-negative integer");
    }
    const deadline = performance.now() + (options.timeoutMs ?? defaultTimeoutMs());
    for (let count = 0;; count++) {
      if (await predicate()) return count;
      if (count === options.maxSlots || performance.now() >= deadline) {
        throw new Error("advanceUntil limit reached");
      }
      await this.stepSlot();
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
    await this.controller?.close();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
