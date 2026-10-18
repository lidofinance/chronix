// @ts-check
// Plain JavaScript checked against ./types.d.ts; do not add `@ts-self-types`, which would stop
// `deno check` from checking this implementation.
/**
 * @import {
 *   CommandName,
 *   Commands,
 *   ChronixClientApi as Api,
 *   ChronixClientOptions,
 *   SnapshotOperationRecord,
 *   SnapshotRef,
 * } from "./types.d.ts"
 */

export class ChronixError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.name = "ChronixError";
    this.status = status;
  }
}

export class SnapshotOperationError extends ChronixError {
  /** @param {SnapshotOperationRecord} operation @param {number} [status] */
  constructor(operation, status = 500) {
    super(
      operation.error ?? `Snapshot operation is ${operation.state} at ${operation.stage}`,
      status,
    );
    this.name = "SnapshotOperationError";
    this.operation = operation;
  }
}

/** @param {SnapshotRef | string} snapshot */
const snapshotId = (snapshot) => typeof snapshot === "string" ? snapshot : snapshot.id;

/** @implements {Api} */
export class ChronixClient {
  #timeoutMs;
  #send;
  /** @param {string} url @param {ChronixClientOptions} [options] */
  constructor(url, options = {}) {
    this.url = url;
    this.#timeoutMs = options.timeoutMs ?? 3_600_000;
    this.#send = options.fetch;
  }

  /** @param {string} path @param {RequestInit} [init] */
  async #fetch(path, init = {}) {
    const response = await (this.#send ?? fetch)(`${this.url}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (response.ok) return response;
    const text = await response.text();
    /** @type {{ error?: unknown, operation?: SnapshotOperationRecord } | undefined} */
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // Not a controller error document, such as a refused origin.
    }
    if (body?.operation) throw new SnapshotOperationError(body.operation, response.status);
    const message = typeof body?.error === "string"
      ? body.error
      : `HTTP ${response.status} ${path}: ${text}`;
    throw new ChronixError(message, response.status);
  }

  /**
   * @template {CommandName} M
   * @param {M} method
   * @param {Commands[M]["params"]} params
   * @returns {Promise<Commands[M]["result"]>}
   */
  async command(method, params) {
    const response = await this.#fetch(`/control/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return (await response.json()).result;
  }

  /** @type {Api["lifecycle"]} */
  lifecycle() {
    return this.command("lifecycle", []);
  }
  /** @type {Api["listSnapshots"]} */
  listSnapshots() {
    return this.command("snapshotList", []);
  }
  /** @type {Api["snapshotOperation"]} */
  snapshotOperation(id) {
    return this.command("snapshotOperation", [id]);
  }
  /** @type {Api["createSnapshot"]} */
  createSnapshot(operationId = crypto.randomUUID()) {
    return this.command("snapshotCreate", [operationId]);
  }
  /** @type {Api["restoreSnapshot"]} */
  restoreSnapshot(snapshot, operationId = crypto.randomUUID()) {
    return this.command("snapshotRestore", [snapshotId(snapshot), operationId]);
  }
  /** @type {Api["removeSnapshot"]} */
  removeSnapshot(snapshot, operationId = crypto.randomUUID()) {
    return this.command("snapshotRemove", [snapshotId(snapshot), operationId]);
  }
  /** @type {Api["exportSnapshot"]} */
  async exportSnapshot(snapshot, path, { maxBytes = 8 * 1024 ** 3 } = {}) {
    const { open, link, unlink } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const response = await this.#fetch(`/snapshots/${snapshotId(snapshot)}/archive`);
    const body = response.body;
    if (!body) throw new Error("Snapshot export returned no archive");
    const expected = response.headers.get("x-chronix-sha256");
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const hash = createHash("sha256");
    let bytes = 0;
    let read = false;
    try {
      if (expected === null) throw new Error("Snapshot export returned no SHA-256");
      if (!/^[a-f0-9]{64}$/.test(expected)) {
        throw new Error("Snapshot SHA-256 header must contain 64 lowercase hex digits");
      }
      const file = await open(temporary, "wx", 0o600);
      try {
        read = true;
        for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (body)) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw new Error("Snapshot exceeds byte limit");
          hash.update(chunk);
          for (let offset = 0; offset < chunk.length;) {
            offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
          }
        }
        await file.sync();
      } finally {
        await file.close();
      }
      const sha256 = hash.digest("hex");
      if (expected !== sha256) throw new Error("Snapshot SHA-256 mismatch");
      // A hard link publishes atomically and fails when the destination already exists.
      await link(temporary, path);
      // Best effort: the file is already published; some platforms cannot sync a directory.
      await open(dirname(path), "r").then((directory) =>
        directory.sync().finally(() => directory.close())
      ).catch(() => {});
      return { path, sha256, bytes };
    } finally {
      if (!read) await body.cancel().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  /** @type {Api["stop"]} */
  stop() {
    return this.command("stop", []);
  }
  /** @type {Api["resume"]} */
  resume() {
    return this.command("resume", []);
  }
  /** @type {Api["shutdown"]} */
  shutdown() {
    return this.command("shutdown", []);
  }
  /** @type {Api["status"]} */
  status() {
    return this.command("status", []);
  }
  /** @type {Api["resources"]} */
  resources() {
    return this.command("resources", []);
  }
  /** @type {Api["stepSlot"]} */
  stepSlot() {
    return this.command("stepSlot", []);
  }
  /** @type {Api["advanceSlots"]} */
  advanceSlots(count) {
    return this.command("advanceSlots", [count]);
  }
  /** @type {Api["advanceEpochs"]} */
  advanceEpochs(count) {
    return this.command("advanceEpochs", [count]);
  }
  /** @type {Api["advanceTime"]} */
  advanceTime(seconds, options) {
    return this.command("advanceTime", options === undefined ? [seconds] : [seconds, options]);
  }
  /** @type {Api["advanceTo"]} */
  advanceTo(timestamp, options) {
    const seconds = timestamp instanceof Date ? timestamp.getTime() / 1000 : timestamp;
    return this.command("advanceTo", options === undefined ? [seconds] : [seconds, options]);
  }
  /** @type {Api["skipSlots"]} */
  skipSlots(count) {
    return this.command("skipSlots", [count]);
  }
  /** @type {Api["setAutomine"]} */
  setAutomine(enabled) {
    return this.command("setAutomine", [enabled]);
  }
  /** @type {Api["setIntervalMining"]} */
  setIntervalMining(intervalMs) {
    return this.command("setIntervalMining", [intervalMs]);
  }
  /** @type {Api["clients"]} */
  clients() {
    return this.command("clients", []);
  }
  /** @type {Api["stopClient"]} */
  stopClient(role, options = {}) {
    return this.command("stopClient", [role, options]);
  }
  /** @type {Api["startClient"]} */
  startClient(role) {
    return this.command("startClient", [role]);
  }
  /** @type {Api["restartClient"]} */
  restartClient(role, options = {}) {
    return this.command("restartClient", [role, options]);
  }
  /** @type {Api["validators"]} */
  validators() {
    return this.command("validators", []);
  }
  /** @type {Api["setValidatorsOnline"]} */
  setValidatorsOnline(selector, online) {
    return this.command("setValidatorsOnline", [selector, online]);
  }
  /** @type {Api["importValidator"]} */
  importValidator(keystore, password) {
    return this.command("importValidator", [keystore, password]);
  }
  /** @type {Api["removeValidator"]} */
  removeValidator(pubkey) {
    return this.command("removeValidator", [pubkey]);
  }
  /** @type {Api["configureValidator"]} */
  configureValidator(pubkey, settings) {
    return this.command("configureValidator", [pubkey, settings]);
  }
  /** @type {Api["exitValidator"]} */
  exitValidator(pubkey) {
    return this.command("exitValidator", [pubkey]);
  }
  /** @type {Api["missProposal"]} */
  missProposal(slot) {
    return this.command("missProposal", [slot]);
  }
  /** @type {Api["withholdPayload"]} */
  withholdPayload(slot) {
    return this.command("withholdPayload", [slot]);
  }

  /** @type {Api["rpc"]} */
  async rpc(method, params = []) {
    const response = await this.#fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
    return body.result;
  }
  /** @type {Api["beacon"]} */
  async beacon(path) {
    return await (await this.#fetch(path)).json();
  }
  /** @type {Api["advanceUntil"]} */
  async advanceUntil(predicate, options) {
    if (!Number.isSafeInteger(options.maxSlots) || options.maxSlots < 0) {
      throw new Error("maxSlots must be a non-negative integer");
    }
    const deadline = performance.now() + (options.timeoutMs ?? this.#timeoutMs);
    for (let count = 0;; count++) {
      if (await predicate()) return count;
      if (count === options.maxSlots || performance.now() >= deadline) {
        throw new Error("advanceUntil limit reached");
      }
      await this.stepSlot();
    }
  }
}
