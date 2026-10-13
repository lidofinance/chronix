import { defaultTimeoutMs, HttpError, json, rpc, waitFor } from "./http.ts";
import { type Manifest, Network } from "./network.ts";
import { type TimeBackend, Timeline } from "./time.ts";
import type { EngineGate } from "./engine.ts";
import { needsPtcReadiness } from "./ptc_readiness.ts";
import { SyncAggregator } from "./sync_aggregator.ts";
import type { SlotView, ValidatorControl } from "./validator_control.ts";

export interface ClockState {
  nowMs: number;
  marks: Record<string, number>;
}
export interface ExecutionBlock {
  hash: string;
  number: string;
  timestamp: string;
  baseFeePerGas: string;
  gasLimit: string;
  transactions: string[];
  withdrawals?: { validatorIndex: string; amount: string; address: string }[];
}
export class Consensus implements TimeBackend {
  private recovering = false;
  private confirmedHead?: { slot: number; root: string };
  private proposed?: { slot: number; present: boolean };
  private view?: { slot: number; value?: SlotView };
  private readonly withheldSlots = new Set<number>();
  control?: ValidatorControl;
  aggregator?: Pick<SyncAggregator, "publish">;
  constructor(
    readonly manifest: Manifest,
    readonly engine?: EngineGate,
    readonly network?: Network,
  ) {
    this.control = network?.validatorControl;
    if (this.control) this.aggregator = new SyncAggregator(() => this.manifest);
  }
  async clock(endpoint: string, at?: number): Promise<ClockState> {
    return await json<ClockState>(
      at === undefined ? endpoint : `${endpoint}/advance/${at}`,
      at === undefined ? {} : { method: "POST" },
    );
  }
  async mark(
    endpoint: string,
    names: string[],
    slot: number,
    timeoutMs = defaultTimeoutMs(),
  ): Promise<void> {
    if (this.manifest.bake.recipe.clockWait && !this.recovering) {
      if (!names.length) return;
      // Published clients cap each native wait at 30 seconds. Bound the complete retry sequence
      // in real time as well; transport failures and invalid marks must never become retries.
      const budget = AbortSignal.timeout(timeoutMs);
      let lastTimeout: HttpError | undefined;
      for (let remaining = timeoutMs; remaining > 0; remaining -= 30_000) {
        try {
          const state = await json<ClockState>(
            `${endpoint}/wait/${slot}/${Math.min(remaining, 30_000)}/${names.join(",")}`,
            { method: "POST", signal: budget },
          );
          if (!names.every((name) => state.marks[name] === slot)) {
            throw new Error(`Incomplete native barrier at slot ${slot}: ${names.join(", ")}`);
          }
          return;
        } catch (error) {
          if (budget.aborted) {
            throw new Error(
              `Timed out native barrier at slot ${slot}: ${names.join(", ")} (${timeoutMs} ms)` +
                (lastTimeout ? `; last response: ${lastTimeout.message}` : ""),
              { cause: error },
            );
          }
          if (
            !(error instanceof HttpError) || error.status !== 408 || remaining <= 30_000
          ) throw error;
          lastTimeout = error;
        }
      }
      return;
    }
    await waitFor(`slot ${slot}: ${names.join(", ")}`, async () => {
      const state = await this.clock(endpoint);
      return names.every((name) => state.marks[name] === slot) ? true : undefined;
    }, timeoutMs);
  }
  /** The slot's duties when validators are silent or faults are scheduled; otherwise undefined. */
  private async slotView(slot: number): Promise<SlotView | undefined> {
    if (!this.control) return undefined;
    if (this.view?.slot !== slot) {
      this.view = { slot, value: await this.control.view(this.manifest, slot) };
    }
    return this.view.value;
  }
  async executionHead(): Promise<string> {
    return (await rpc<ExecutionBlock>(this.manifest.el, "eth_getBlockByNumber", ["latest", false]))
      .hash;
  }
  /** A head whose envelope was withheld keeps EL at its bid's execution parent. */
  private async withheld(slot: number): Promise<void> {
    const block = await json<{
      execution_optimistic: boolean;
      data: {
        message: {
          slot: string;
          body: { signed_execution_payload_bid: { message: { parent_block_hash: string } } };
        };
      };
    }>(`${this.manifest.beacon}/eth/v2/beacon/blocks/head`);
    if (Number(block.data.message.slot) !== slot) throw new Error("Head changed at withheld slot");
    const parent = block.data.message.body.signed_execution_payload_bid.message.parent_block_hash;
    if (await this.executionHead() !== parent) {
      throw new Error(`Withheld payload at slot ${slot} reached the execution layer`);
    }
    this.withheldSlots.add(slot);
  }
  async move(at: number, phase?: number): Promise<void> {
    const m = this.manifest;
    const profile = m.bake.recipe;
    const slot = Math.floor((at / 1000 - m.config.genesisTime) / 12);
    if (needsPtcReadiness(m)) {
      if (phase === 0) await this.mark(m.vcClock, ["ptc_wait"], slot);
      if (phase === 9_000) {
        if (!this.network?.ptcReadiness) throw new Error("Missing validator PTC bootstrap runtime");
        await this.network.ptcReadiness.beforePtcDeadline(slot);
      }
    }
    if (this.engine) this.engine.nowMs = at;
    await this.clock(m.bnClock, at);
    if (phase === 0) await this.mark(m.bnClock, ["slot"], slot);
    await this.clock(m.vcClock, at);
    const view = phase === undefined ? undefined : await this.slotView(slot);
    const online = (index: number) => !view?.silent.has(index);
    // Duties that an enabled key with a settled VC cache must perform.
    const required = (index: number) => online(index) && !view?.uncertain.has(index);
    if (phase === 0) {
      this.confirmedHead = undefined;
      const missed = view !== undefined && (
        this.control!.has("missProposal", slot) ||
        (view.proposer !== undefined && !online(view.proposer))
      );
      this.proposed = { slot, present: !missed };
      if (missed) {
        // An enabled proposer asks for its block; its refusal proves the VC finished trying.
        if (view.proposer !== undefined && online(view.proposer)) {
          await waitFor(
            `refused proposal at slot ${slot}`,
            () => Promise.resolve(this.control!.refused(slot, "block") || undefined),
          );
        }
        const head = await json<{ data: { root: string; header: { message: { slot: string } } } }>(
          `${m.beacon}/eth/v1/beacon/headers/head`,
        );
        const headSlot = Number(head.data.header.message.slot);
        if (headSlot >= slot) throw new Error(`Unexpected block at missed slot ${slot}`);
        if (this.withheldSlots.has(headSlot)) await this.withheld(headSlot);
        else {await waitFor(`execution agreement at slot ${headSlot}`, () =>
            this.consistency(headSlot));}
        this.confirmedHead = { slot, root: head.data.root };
        return;
      }
      const head = await waitFor(`Beacon block at slot ${slot}`, async () => {
        const head = await json<{ data: { root: string; header: { message: { slot: string } } } }>(
          `${m.beacon}/eth/v1/beacon/headers/head`,
        );
        return Number(head.data.header.message.slot) === slot ? head.data : undefined;
      });
      if (this.control?.has("withholdPayload", slot)) {
        await waitFor(
          `withheld payload envelope at slot ${slot}`,
          () => Promise.resolve(this.control!.refused(slot, "envelope") || undefined),
        );
        await this.withheld(slot);
      } else await waitFor(`execution agreement at slot ${slot}`, () => this.consistency(slot));
      this.confirmedHead = { slot, root: head.root };
    } else if (phase === profile.attestationMs || phase === profile.aggregateMs) {
      const committees = await json<{ data: { index: string; validators: string[] }[] }>(
        // After a missed first slot the head state is still in the previous epoch.
        `${m.beacon}/eth/v1/beacon/states/head/committees?epoch=${
          Math.floor(slot / 32)
        }&slot=${slot}`,
      );
      // With at most 256 validators a committee has at most 8 members, so every member is an
      // aggregator: a committee needs aggregates exactly when it has an enabled member.
      const signing = committees.data.filter((c) => c.validators.some((v) => required(Number(v))));
      const names = phase === profile.attestationMs && m.config.profile === "gloas"
        ? signing.length ? ["attestations"] : []
        : signing.filter((c) => c.validators.length > 0)
          .map((c) =>
            `${phase === profile.attestationMs ? "attestations" : "aggregates"}_${c.index}`
          );
      // This topology owns all genesis keys and the complete sync committee.
      if (phase === profile.attestationMs) {
        if (!view || view.syncSeats.some(required)) names.push("sync_messages");
      } else if (!profile.directSync) {
        await this.mark(m.vcClock, ["sync_expected_slot"], slot);
        const state = await this.clock(m.vcClock);
        if (state.marks.sync_expected_slot !== slot) throw new Error("Missing sync duty manifest");
        names.push(
          ...[0, 1, 2, 3].filter((i) => state.marks.sync_expected_mask & (1 << i)).map((i) =>
            `sync_aggregate_${i}`
          ),
        );
      }
      await this.mark(m.vcClock, names, slot);
      if (phase === profile.attestationMs && profile.directSync) {
        const head = await json<{ data: { root: string; header: { message: { slot: string } } } }>(
          `${m.beacon}/eth/v1/beacon/headers/head`,
        );
        const present = this.proposed?.slot !== slot || this.proposed.present;
        if (
          (present && Number(head.data.header.message.slot) !== slot) ||
          !/^0x[0-9a-f]{64}$/.test(head.data.root)
        ) {
          throw new Error("Invalid head for sync contribution barrier");
        }
        if (this.confirmedHead?.slot !== slot || this.confirmedHead.root !== head.data.root) {
          throw new Error("Beacon head changed after execution agreement; reset required");
        }
        if (view && view.syncSeats.some((index) => !required(index))) {
          // Direct sync needs every seat. Silent or unsettled seats get the real aggregator duty.
          if (view.syncSeats.some(online)) {
            await this.aggregator!.publish(
              slot,
              head.data.root,
              view.syncSeats,
              online,
              view.pubkeys,
              required,
            );
          }
        } else {
          // Phase 0 already confirmed execution. This independent BN barrier proves full voting
          // coverage for this exact root; VC publication marks alone can also follow HTTP errors.
          await this.mark(m.bnClock, [`sync_contributions_${head.data.root}`], slot);
        }
      }
    } else if (phase === 9_000) {
      if (m.config.profile === "gloas") {
        // Without a block at this slot the VC has nothing to attest to and sets no mark.
        const present = this.proposed?.slot !== slot || this.proposed.present;
        if (present && (!view || view.ptc.some(required))) {
          await this.mark(m.vcClock, ["payload_attestations"], slot);
        }
      }
      await this.mark(m.bnClock, ["state_advance"], slot);
    } else if (phase === 11_500) {
      await this.mark(m.bnClock, ["fork_choice"], slot);
      this.recovering = false;
    }
  }
  /**
   * After a beacon node restart its operation pool is empty while the replayed votes are back in
   * its aggregation pool. When silent seats replaced direct sync, publish this slot's
   * contributions again (an already known contribution is accepted as done).
   */
  async resumeAggregation(nowMs: number): Promise<void> {
    if (!this.control) return;
    const m = this.manifest;
    const slot = Math.floor((nowMs / 1000 - m.config.genesisTime) / 12);
    const offset = nowMs - (m.config.genesisTime * 1000 + slot * 12_000);
    if (offset < m.bake.recipe.attestationMs) return;
    const view = await this.slotView(slot);
    const online = (index: number) => !view?.silent.has(index);
    // Duties that an enabled key with a settled VC cache must perform.
    const required = (index: number) => online(index) && !view?.uncertain.has(index);
    if (!view || view.syncSeats.every(required) || !view.syncSeats.some(online)) return;
    const head = await json<{ data: { root: string } }>(`${m.beacon}/eth/v1/beacon/headers/head`);
    await this.aggregator!.publish(
      slot,
      head.data.root,
      view.syncSeats,
      online,
      view.pubkeys,
      required,
    );
  }
  async consistency(slot: number): Promise<ExecutionBlock> {
    const m = this.manifest;
    const payload = await executionAt(m, "head");
    if (
      Number(payload.timestamp) !== m.config.genesisTime + slot * 12
    ) throw new Error("Invalid CL execution status/timestamp");
    return await waitFor("EL/CL head agreement", async () => {
      const el = await rpc<ExecutionBlock>(m.el, "eth_getBlockByNumber", ["latest", false]);
      return el.hash === payload.block_hash &&
          Number(BigInt(el.timestamp)) === Number(payload.timestamp)
        ? el
        : undefined;
    });
  }
  async skip(at: number): Promise<void> {
    if (needsPtcReadiness(this.manifest) && !this.network?.ptcReadiness) {
      throw new Error("Missing validator PTC bootstrap runtime");
    }
    this.recovering = !this.manifest.bake.recipe.preparedSkip;
    if (this.engine) this.engine.nowMs = at;
    await (this.network ?? new Network(this.manifest.config)).skipValidator(this.manifest, at);
  }
  static async connect(
    manifest: Manifest,
    engine?: EngineGate,
    network?: Network,
  ): Promise<Timeline> {
    if (manifest.config.mode !== "controlled") {
      throw new Error("Time control requires the Lighthouse fork");
    }
    if (needsPtcReadiness(manifest) && !network?.ptcReadiness) {
      throw new Error("Missing validator PTC bootstrap runtime");
    }
    const backend = new Consensus(manifest, engine, network);
    const bn = await backend.clock(manifest.bnClock);
    const vc = await backend.clock(manifest.vcClock);
    if (bn.nowMs !== vc.nowMs) throw new Error("BN/VC clock mismatch; reset required");
    await backend.resumeAggregation(bn.nowMs);
    return new Timeline(
      manifest.config.genesisTime * 1000,
      bn.nowMs,
      backend,
      manifest.bake.recipe.phases,
    );
  }
}

/** Read execution data through the selected hardfork's Beacon API representation. */
export async function executionAt(
  m: Manifest,
  id: string,
): Promise<{ block_hash: string; timestamp: string }> {
  const block = await json<{
    execution_optimistic: boolean;
    data: {
      message: {
        slot: string;
        body: {
          execution_payload?: { block_hash: string; timestamp: string };
          signed_execution_payload_bid?: { message: { block_hash: string } };
        };
      };
    };
  }>(`${m.beacon}/eth/v2/beacon/blocks/${id}`);
  if (block.execution_optimistic) throw new Error("Optimistic CL execution state");
  if (m.config.profile === "pectra") {
    if (!block.data.message.body.execution_payload) throw new Error("Missing Pectra payload");
    return block.data.message.body.execution_payload;
  }
  const envelope = await json<
    {
      data: {
        message: { payload: { slot_number: string; block_hash: string; timestamp: string } };
      };
    }
  >(
    `${m.beacon}/eth/v1/beacon/execution_payload_envelopes/${id}`,
  );
  const payload = envelope.data.message.payload;
  if (
    payload.slot_number !== block.data.message.slot ||
    payload.block_hash !== block.data.message.body.signed_execution_payload_bid?.message.block_hash
  ) {
    throw new Error("Gloas bid/envelope mismatch");
  }
  return payload;
}

/** Gloas checkpoints commit the execution parent, before the checkpoint block's envelope. */
export async function finalizedExecutionHash(m: Manifest): Promise<string> {
  if (m.config.profile === "pectra") return (await executionAt(m, "finalized")).block_hash;
  const block = await json<{
    execution_optimistic: boolean;
    data: {
      message: {
        body: { signed_execution_payload_bid: { message: { parent_block_hash: string } } };
      };
    };
  }>(`${m.beacon}/eth/v2/beacon/blocks/finalized`);
  if (block.execution_optimistic) throw new Error("Optimistic finalized checkpoint");
  return block.data.message.body.signed_execution_payload_bid.message.parent_block_hash;
}
