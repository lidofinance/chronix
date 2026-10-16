import { integer, type Timeline } from "./time.ts";

/** The longest delay a timer holds; a longer one fires at once. */
const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * Interval mining, like Hardhat's `evm_setIntervalMining`: one slot every `ms` of real time, with
 * or without transactions, so the network moves like a live chain. Slots go through the timeline
 * queue, so they never interleave with other time commands. A slot delayed by such a command is
 * produced late; the slots it missed are dropped rather than produced in a burst.
 */
export class IntervalMining {
  /** Milliseconds between slots; 0 is off. */
  ms = 0;
  error?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  /** Each change starts a generation; a slot or change of an older one does nothing more. */
  private generation = 0;
  private stopped = false;
  /** `afterSlot` runs after each produced slot, like the hook after a time command. */
  constructor(readonly time: Timeline, private readonly afterSlot: () => void) {}

  /** Change the interval. The latest change wins; it resolves once a slot in flight has finished. */
  async set(ms: number): Promise<void> {
    integer(ms, "interval milliseconds");
    if (ms > MAX_INTERVAL_MS) {
      throw new Error(`interval milliseconds must be at most ${MAX_INTERVAL_MS}`);
    }
    const generation = this.cancel();
    await this.active;
    if (generation !== this.generation || this.stopped || ms === 0) return;
    this.ms = ms;
    this.error = undefined;
    this.arm(generation, performance.now() + ms);
  }

  /** Turn it off for good at once; the promise settles when a slot in flight has finished. */
  stop(): Promise<void> {
    this.stopped = true;
    this.cancel();
    return this.active ?? Promise.resolve();
  }

  /** No slot starts from here on; returns the new generation. */
  private cancel(): number {
    this.ms = 0;
    clearTimeout(this.timer);
    return ++this.generation;
  }

  private arm(generation: number, due: number): void {
    this.timer = setTimeout(() => {
      if (generation === this.generation) this.active = this.slot(generation, due);
    }, Math.max(0, due - performance.now()));
  }

  private async slot(generation: number, due: number): Promise<void> {
    try {
      await this.time.stepSlot();
      this.afterSlot();
    } catch (error) {
      // Turned off or stopping meanwhile: the refusal is expected.
      if (generation !== this.generation) return;
      // A deliberately stopped client refuses time; its slots are skipped, not an error.
      if (!this.time.blocked?.()) {
        this.cancel();
        this.error = String(error);
        console.error(JSON.stringify({ event: "interval-mining-error", error: this.error }));
        return;
      }
    }
    if (generation !== this.generation) return;
    const next = due + this.ms;
    this.arm(generation, next > performance.now() ? next : performance.now() + this.ms);
  }
}
