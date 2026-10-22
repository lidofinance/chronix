import { abortable, defaultTimeoutMs, delay, detached } from "./http.ts";
export const SLOT_MS = 12_000;
export const SLOTS_PER_EPOCH = 32;
export const PHASES = [0, 4_000, 6_000, 8_000, 9_000, 11_500] as const;
/** Real-time interval of the client check while a command runs. */
const CLIENT_CHECK_MS = 1_000;
/** How long a failure that faulted the timeline keeps checking for a lost client as its cause. */
const LOSS_GRACE_MS = 2_000;
import type { WarpMode, WarpOptions } from "../client/types.d.ts";
export type { WarpMode, WarpOptions };
export function warpMode(options: unknown = {}): WarpMode {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Warp options must be an object");
  }
  const mode = (options as WarpOptions).mode;
  if (mode === undefined) return "honest";
  if (mode !== "honest" && mode !== "fast") throw new Error("Warp mode must be honest or fast");
  return mode;
}
export interface TimeBackend {
  move(nowMs: number, phase?: number): Promise<void>;
  skip?(nowMs: number): Promise<void>;
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  idle(): Promise<unknown> {
    return this.tail;
  }
}
export function integer(value: number, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}
export function milliseconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(seconds * 1000)) {
    throw new Error("Time must be non-negative seconds, with at most millisecond precision");
  }
  return seconds * 1000;
}
/** Single writer for protocol time. Ambiguous partial progress faults until reset. */
export class Timeline {
  readonly queue = new Serial();
  private fault?: unknown;
  private stopped = false;
  /** A reason refusing time mutations (e.g. a stopped client); a refusal never faults. */
  blocked?: () => string | undefined;
  /**
   * A client that exited on its own or is gone. Only a snapshot restore or down and up recovers
   * it, so finding one faults the timeline; a check that fails (Docker unreachable) only refuses.
   * It is checked before each command and every second while one runs.
   */
  lost?: () => Promise<string | undefined>;
  constructor(
    readonly genesisMs: number,
    public nowMs: number,
    readonly backend: TimeBackend,
    /** Phase offsets, or the offsets of each slot when forks change them. */
    readonly phases: readonly number[] | ((slot: number) => readonly number[]) = PHASES,
  ) {}
  get slot(): number {
    return Math.floor((this.nowMs - this.genesisMs) / SLOT_MS);
  }
  get timestamp(): number {
    return this.nowMs / 1000;
  }
  assertHealthy(): void {
    if (this.stopped) throw new Error("Controller is stopping");
    if (this.fault) throw new Error(`Advancement faulted; reset required: ${this.fault}`);
  }
  get faulted(): boolean {
    return this.fault !== undefined;
  }
  stop(): void {
    this.stopped = true;
  }
  /** Fault on a lost client; an earlier fault stays the recorded cause. */
  async checkClients(): Promise<void> {
    const lost = await this.lost?.();
    if (!lost) return;
    const error = new Error(lost);
    if (this.fault === undefined) this.fault = error;
    throw error;
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return await this.queue.run(async () => {
      this.assertHealthy();
      // A lost client comes first: starting a stopped one cannot recover the network.
      await this.checkClients();
      const reason = this.blocked?.();
      if (reason) throw new Error(reason);
      return await this.watched(fn);
    });
  }
  /**
   * Run a command while its clients are checked every second. A loss aborts the command's waits
   * and requests and becomes its error; the queue moves on only after the command has settled, so
   * no part of it continues afterwards. A check that fails (Docker unreachable) is ignored.
   */
  private async watched<T>(fn: () => Promise<T>): Promise<T> {
    const lost = this.lost;
    if (!lost) return await fn();
    const abort = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let check: Promise<void> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        check = (async () => {
          try {
            const loss = await lost();
            if (loss) abort.abort(new Error(loss));
          } catch {
            // An unanswered check says nothing about the clients.
          }
          if (!settled && !abort.signal.aborted) schedule();
        })();
      }, CLIENT_CHECK_MS);
    };
    // A check in flight ends within its own Docker deadline.
    const stop = async () => {
      settled = true;
      clearTimeout(timer);
      await check;
    };
    // Outside the command, so the watcher's own checks never observe its abort.
    detached(schedule);
    try {
      return await abortable(abort.signal, fn);
    } catch (error) {
      await stop();
      throw await this.cause(error, abort.signal);
    } finally {
      await stop();
    }
  }
  /**
   * A failed command reports a lost client as its cause and records it as the fault in place of
   * what the same failure recorded; an earlier fault stays the recorded cause. A killed client's
   * requests fail at once, while Docker can still list it as running for a moment, so a failure
   * that faulted the timeline checks again for a short while, unless the controller is stopping.
   */
  private async cause(error: unknown, signal: AbortSignal): Promise<unknown> {
    let loss: unknown = signal.aborted ? signal.reason : undefined;
    const grace = this.fault === error && !this.stopped;
    const until = performance.now() + (grace ? LOSS_GRACE_MS : 0);
    while (loss === undefined) {
      let lost: string | undefined;
      try {
        lost = await this.lost?.();
      } catch {
        break; // Docker unreachable: the command's own error stays.
      }
      if (lost) loss = new Error(lost);
      else if (performance.now() < until) await delay(250);
      else break;
    }
    if (loss === undefined) return error;
    if (this.fault === undefined || this.fault === error) this.fault = loss;
    return loss;
  }
  /** Serialize with time mutations without the client guard, e.g. to restart a client. */
  async serialized<T>(fn: () => Promise<T>): Promise<T> {
    return await this.queue.run(() => {
      this.assertHealthy();
      return fn();
    });
  }
  private async to(target: number): Promise<void> {
    integer(target, "target milliseconds");
    if (target < this.nowMs) throw new Error("Protocol time can only move forward");
    try {
      while (this.nowMs < target) {
        this.assertHealthy();
        const start = this.genesisMs + this.slot * SLOT_MS;
        const phases = typeof this.phases === "function" ? this.phases(this.slot) : this.phases;
        const next = phases.map((phase) => ({ at: start + phase, phase }))
          .find((entry) => entry.at > this.nowMs) ?? { at: start + SLOT_MS, phase: 0 };
        const at = Math.min(target, next.at);
        await this.backend.move(at, at === next.at ? next.phase : undefined);
        this.nowMs = at;
      }
    } catch (error) {
      this.fault = error;
      throw error;
    }
  }
  advanceTo(timestamp: number, options?: WarpOptions): Promise<void> {
    const target = milliseconds(timestamp);
    const mode = warpMode(options);
    return this.exclusive(() => this.warpTo(target, mode));
  }
  advanceTime(seconds: number, options?: WarpOptions): Promise<void> {
    const duration = milliseconds(seconds);
    const mode = warpMode(options);
    return this.exclusive(() => this.warpTo(this.nowMs + duration, mode));
  }
  private async warpTo(target: number, mode: WarpMode): Promise<void> {
    integer(target, "target milliseconds");
    if (target < this.nowMs) throw new Error("Protocol time can only move forward");
    const targetSlot = Math.floor((target - this.genesisMs) / SLOT_MS);
    if (mode === "fast" && targetSlot - this.slot > SLOTS_PER_EPOCH) {
      if (!this.backend.skip) throw new Error("This backend does not support fast slot skipping");
      // Preserve the established skip algorithm: complete current duties, restart the VC with
      // its slashing DB at the end of the gap, then produce the destination slot normally.
      await this.to(Math.max(this.nowMs, this.genesisMs + this.slot * SLOT_MS + 11_500));
      const beforeDestination = this.genesisMs + (targetSlot - 1) * SLOT_MS + 11_500;
      try {
        await this.backend.skip(beforeDestination);
        this.nowMs = beforeDestination;
      } catch (error) {
        this.fault = error;
        throw error;
      }
    }
    await this.to(target);
  }
  stepSlot(): Promise<void> {
    return this.advanceSlots(1);
  }
  advanceSlots(count: number): Promise<void> {
    integer(count, "slot count");
    return this.exclusive(() =>
      count === 0
        ? Promise.resolve()
        : this.to(this.genesisMs + (this.slot + count) * SLOT_MS + 11_500)
    );
  }
  advanceEpochs(count: number): Promise<void> {
    integer(count, "epoch count");
    return this.advanceSlots(count * SLOTS_PER_EPOCH);
  }
  advanceUntil(
    condition: () => Promise<boolean>,
    options: { maxSlots: number; timeoutMs?: number },
  ): Promise<number> {
    integer(options.maxSlots, "maxSlots");
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs();
    integer(timeoutMs, "timeoutMs", 1);
    return this.exclusive(async () => {
      const deadline = performance.now() + timeoutMs;
      for (let n = 0;; n++) {
        if (await condition()) return n;
        if (n === options.maxSlots || performance.now() >= deadline) {
          throw new Error("advanceUntil limit reached");
        }
        await this.to(this.genesisMs + (this.slot + 1) * SLOT_MS + 11_500);
      }
    });
  }
  skipSlots(count: number): Promise<void> {
    integer(count, "slot count");
    return this.exclusive(async () => {
      if (!count) return;
      if (!this.backend.skip) throw new Error("This backend does not support slot skipping");
      // Finish current duties before restarting the VC at the end of the skipped range.
      await this.to(Math.max(this.nowMs, this.genesisMs + this.slot * SLOT_MS + 11_500));
      const target = this.nowMs + count * SLOT_MS;
      try {
        await this.backend.skip(target);
        this.nowMs = target;
      } catch (error) {
        this.fault = error;
        throw error;
      }
    });
  }
}
