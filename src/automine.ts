import { type ExecutionBlock } from "./consensus.ts";
import { rpc } from "./http.ts";
import { type Timeline } from "./time.ts";

export interface PoolTransaction {
  hash: string;
  from: string;
  nonce: string;
  gas: string;
  value: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}
/** Whether the EL's payload builder includes `tx` next; `minimumTip` is the builder's floor. */
export function executable(
  tx: PoolTransaction,
  nonce: bigint,
  balance: bigint,
  baseFee: bigint,
  gasLimit: bigint,
  minimumTip: bigint,
): boolean {
  const fee = BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? "0x0");
  const cap = tx.maxPriorityFeePerGas === undefined
    ? fee - baseFee
    : BigInt(tx.maxPriorityFeePerGas);
  // The effective tip: the tip cap, limited by what the fee cap leaves above the base fee.
  const tip = cap < fee - baseFee ? cap : fee - baseFee;
  return BigInt(tx.nonce) === nonce && fee >= baseFee && tip >= minimumTip &&
    BigInt(tx.gas) <= gasLimit && balance >= BigInt(tx.value) + BigInt(tx.gas) * fee;
}
export class Automine {
  enabled = false;
  error?: string;
  private running = false;
  private requested = 0;
  private handled = 0;
  private stopped = false;
  private active?: Promise<void>;
  private readonly endpoint: () => string;
  /** The EL endpoint is read on every use: a restarted EL gets a new port. */
  constructor(
    el: string | (() => string),
    readonly time: Timeline,
    readonly minimumTip: bigint,
  ) {
    this.endpoint = typeof el === "string" ? () => el : el;
  }
  get el(): string {
    return this.endpoint();
  }
  async head(): Promise<string> {
    return (await rpc<{ hash: string }>(this.el, "eth_getBlockByNumber", ["latest", false])).hash;
  }
  async set(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (enabled) this.notify();
    else await this.active;
  }
  notify(): void {
    if (!this.enabled || this.stopped) return;
    this.requested++;
    this.start();
  }
  private start(): void {
    if (this.running || !this.enabled || this.stopped) return;
    this.running = true;
    this.active = this.drain().catch((error) => {
      this.handled = this.requested;
      this.error = String(error);
      console.error(JSON.stringify({ event: "automine-error", error: this.error }));
    }).finally(() => {
      this.running = false;
      if (this.requested > this.handled) this.start();
    });
  }
  async candidates(): Promise<string[]> {
    const pool = await rpc<{ pending: Record<string, Record<string, PoolTransaction>> }>(
      this.el,
      "txpool_content",
    );
    const head = await rpc<ExecutionBlock & { gasUsed: string }>(this.el, "eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    const gasLimit = BigInt(head.gasLimit);
    const target = gasLimit / 2n;
    const fee = BigInt(head.baseFeePerGas);
    const used = BigInt(head.gasUsed);
    const delta = fee * (used > target ? used - target : target - used) / target / 8n;
    const nextFee = used > target ? fee + (delta > 0n ? delta : 1n) : fee - delta;
    const result: string[] = [];
    for (const [sender, entries] of Object.entries(pool.pending)) {
      const [nonce, balance] = await Promise.all([
        rpc<string>(this.el, "eth_getTransactionCount", [sender, "latest"]),
        rpc<string>(this.el, "eth_getBalance", [sender, "latest"]),
      ]);
      const first = Object.values(entries).find((tx) => BigInt(tx.nonce) === BigInt(nonce));
      if (
        first &&
        executable(first, BigInt(nonce), BigInt(balance), nextFee, gasLimit, this.minimumTip)
      ) {
        result.push(first.hash);
      }
    }
    return result.sort();
  }
  private async drain(): Promise<void> {
    // Bounded even if an EL advertises a transaction which its payload builder cannot include.
    let empty = 0;
    for (let blocks = 0; blocks < 256 && this.enabled && !this.stopped; blocks++) {
      const generation = this.requested;
      this.handled = generation;
      const before = await this.candidates();
      if (!before.length) {
        if (generation !== this.requested) {
          blocks--;
          continue;
        }
        return;
      }
      if (!this.enabled || this.stopped) return;
      const head = await this.head();
      try {
        await this.time.stepSlot();
      } catch (error) {
        // A refused slot (a client stopped through the API, an unanswered Docker query) is not an
        // automine error: the pool waits for the next request. A faulted timeline is one.
        if (this.time.faulted) throw error;
        console.error(JSON.stringify({ event: "automine-refused", error: String(error) }));
        return;
      }
      const after = await this.candidates();
      // A slot without an execution block (missed proposal, silent proposer, withheld payload)
      // proves nothing about the pool; only a produced block that skipped the work ends a drain.
      const produced = await this.head() !== head;
      // Silent proposers can leave slots empty, but one transaction never drives a whole stall.
      empty = produced ? 0 : empty + 1;
      if (empty >= 32) throw new Error("Automine: no execution block for 32 slots");
      if (produced && before.join() === after.join() && generation === this.requested) return;
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.enabled = false;
    await this.active;
  }
}
