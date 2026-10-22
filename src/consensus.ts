import { defaultTimeoutMs, HttpError, json, rpc, waitFor } from "./http.ts";
import { type Manifest, Network } from "./network.ts";
import { type TimeBackend, Timeline } from "./time.ts";
import type { EngineGate } from "./engine.ts";
import { needsPtcReadiness } from "./ptc_readiness.ts";
import { SyncAggregator } from "./sync_aggregator.ts";
import { ForkSchedule, preGloasTiming } from "./forks.ts";
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
  private view?: { slot: number; version: number; value?: SlotView };
  control?: ValidatorControl;
  aggregator?: Pick<SyncAggregator, "publish" | "selectedAttestationAggregator">;
  /** Gloas from genesis unless `connect` learns a later fork from the network. */
  schedule: ForkSchedule;
  constructor(
    readonly manifest: Manifest,
    readonly engine?: EngineGate,
    readonly network?: Network,
  ) {
    this.schedule = new ForkSchedule(0, manifest.bake.recipe);
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
    const version = this.control.version;
    if (this.view?.slot !== slot || this.view.version !== version) {
      this.view = { slot, version, value: await this.control.view(this.manifest, slot) };
    }
    return this.view.value;
  }
  /**
   * Committees of a slot without a view. Phase 0 then awaited this slot's block, so the head state
   * is at this slot; any other head state can lack its committees.
   */
  private async headCommittees(slot: number): Promise<SlotView["committees"]> {
    const m = this.manifest;
    const head = await json<{ data: { header: { message: { slot: string } } } }>(
      `${m.beacon}/eth/v1/beacon/headers/head`,
    );
    const headSlot = Number(head.data.header.message.slot);
    if (headSlot !== slot) {
      throw new Error(`Head block at slot ${headSlot} cannot give the committees of slot ${slot}`);
    }
    const committees = await json<{ data: { index: string; validators: string[] }[] }>(
      `${m.beacon}/eth/v1/beacon/states/head/committees?slot=${slot}`,
    );
    return committees.data.map((committee) => ({
      index: Number(committee.index),
      validators: committee.validators.map(Number),
    }));
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
  }
  /** A Gloas head whose payload envelope the beacon node does not have. */
  private async envelopeMissing(root: string): Promise<boolean> {
    const block = await json<{ data: { message: { body: Record<string, unknown> } } }>(
      `${this.manifest.beacon}/eth/v2/beacon/blocks/${root}`,
    );
    if (!block.data.message.body.signed_execution_payload_bid) return false;
    try {
      await json(`${this.manifest.beacon}/eth/v1/beacon/execution_payload_envelopes/${root}`);
      return false;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return true;
      throw error;
    }
  }
  async move(at: number, phase?: number): Promise<void> {
    const m = this.manifest;
    const profile = m.bake.recipe;
    const slot = Math.floor((at / 1000 - m.config.genesisTime) / 12);
    const timing = this.schedule.timing(slot);
    const gloas = m.config.profile === "gloas" && timing.gloas;
    if (needsPtcReadiness(m) && timing.gloas) {
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
    // Votes that may appear: enabled keys and keys whose VC cache may still be stale.
    const allowed = (index: number) => online(index) || !!view?.uncertain.has(index);
    if (phase === 0) {
      this.confirmedHead = undefined;
      const missed = view !== undefined && (
        this.control!.has("missProposal", slot) ||
        (view.proposer !== undefined && !online(view.proposer))
      );
      // A recently changed proposer may or may not act: a VC asking for the block before it has
      // learned the key's index again refuses its own block. That slot stays empty instead of
      // stalling protocol time.
      const proposer = view?.proposer;
      const optional = !missed && proposer !== undefined && view!.uncertain.has(proposer);
      const block = missed ? null : await waitFor(`Beacon block at slot ${slot}`, async () => {
        const head = await json<{ data: { root: string; header: { message: { slot: string } } } }>(
          `${m.beacon}/eth/v1/beacon/headers/head`,
        );
        if (Number(head.data.header.message.slot) === slot) return head.data;
        return optional &&
            this.control!.proposalSettled(slot, view!.pubkeys.get(proposer!) ?? "")
          ? null
          : undefined;
      });
      this.proposed = { slot, present: block !== null };
      if (block === null) {
        // An enabled proposer asks for its block; its refusal proves the VC finished trying.
        if (missed && view.proposer !== undefined && online(view.proposer)) {
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
        // The chain itself shows a withheld head: a Gloas block without its envelope.
        if (await this.envelopeMissing(head.data.root)) await this.withheld(headSlot);
        else {await waitFor(`execution agreement at slot ${headSlot}`, () =>
            this.consistency(headSlot));}
        this.confirmedHead = { slot, root: head.data.root };
        return;
      }
      const head = block;
      if (this.control?.has("withholdPayload", slot)) {
        await waitFor(
          `withheld payload envelope at slot ${slot}`,
          () => Promise.resolve(this.control!.refused(slot, "envelope") || undefined),
        );
        await this.withheld(slot);
      } else await waitFor(`execution agreement at slot ${slot}`, () => this.consistency(slot));
      this.confirmedHead = { slot, root: head.root };
    } else if (phase === timing.attestationMs || phase === timing.aggregateMs) {
      const committees = view?.committees ?? await this.headCommittees(slot);
      // A committee needs attestations exactly when it has a member that must act.
      const signing = committees.filter((c) => c.validators.some(required));
      // Above 31 members only selected members aggregate; ask exactly as the VC does. Every
      // committee holds all its members, so its length is the one the VC's selection uses.
      const aggregating: typeof signing = [];
      for (const committee of signing) {
        const members = committee.validators;
        if (
          phase !== timing.aggregateMs || members.length < 32 || !this.aggregator ||
          await this.aggregator.selectedAttestationAggregator(
            slot,
            members,
            required,
            view?.pubkeys ?? await this.control!.pubkeys(m, Math.floor(slot / 32)),
          )
        ) aggregating.push(committee);
      }
      // The Gloas bake's VC marks all attestations at once, also before the fork.
      const names = phase === timing.attestationMs && m.config.profile === "gloas"
        ? signing.length ? ["attestations"] : []
        : aggregating.filter((c) => c.validators.length > 0)
          .map((c) =>
            `${phase === timing.attestationMs ? "attestations" : "aggregates"}_${c.index}`
          );
      // This topology owns all genesis keys and the complete sync committee.
      if (phase === timing.attestationMs) {
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
      if (phase === timing.attestationMs && profile.directSync) {
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
          if (view.syncSeats.some(allowed)) {
            await this.aggregator!.publish(
              slot,
              head.data.root,
              view.syncSeats,
              allowed,
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
      if (gloas) {
        // Without a block at this slot the VC has nothing to attest to and sets no mark.
        const present = this.proposed?.slot !== slot || this.proposed.present;
        // In the fork epoch the VC may not know its PTC duties (see PtcReadiness).
        const forkEpoch = this.schedule.gloasEpoch > 0 &&
          Math.floor(slot / 32) === this.schedule.gloasEpoch;
        if (present && !forkEpoch && (!view || view.ptc.some(required))) {
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
    if (offset < this.schedule.timing(slot).attestationMs) return;
    const view = await this.slotView(slot);
    const online = (index: number) => !view?.silent.has(index);
    // Duties that an enabled key with a settled VC cache must perform.
    const required = (index: number) => online(index) && !view?.uncertain.has(index);
    if (!view || view.syncSeats.every(required) || !view.syncSeats.some(online)) return;
    const head = await json<{ data: { root: string } }>(`${m.beacon}/eth/v1/beacon/headers/head`);
    // Coverage was enforced when the slot ran; republish only what the beacon node has again.
    await this.aggregator!.publish(
      slot,
      head.data.root,
      view.syncSeats,
      online,
      view.pubkeys,
      () => false,
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
    const gloasEpoch = manifest.config.genesis?.gloasForkEpoch ?? 0;
    if (gloasEpoch > 0) {
      const spec = await json<{ data: Record<string, unknown> }>(
        `${manifest.beacon}/eth/v1/config/spec`,
      );
      backend.schedule = new ForkSchedule(
        gloasEpoch,
        manifest.bake.recipe,
        preGloasTiming(spec.data, manifest.bake.recipe.slotMs),
      );
    }
    const bn = await backend.clock(manifest.bnClock);
    const vc = await backend.clock(manifest.vcClock);
    if (bn.nowMs !== vc.nowMs) throw new Error("BN/VC clock mismatch; reset required");
    await backend.resumeAggregation(bn.nowMs);
    return new Timeline(
      manifest.config.genesisTime * 1000,
      bn.nowMs,
      backend,
      gloasEpoch > 0 ? (slot) => backend.schedule.timing(slot).phases : manifest.bake.recipe.phases,
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
        state_root: string;
        body: {
          execution_payload?: { block_hash: string; timestamp: string };
          signed_execution_payload_bid?: { message: { block_hash: string } };
        };
      };
    };
  }>(`${m.beacon}/eth/v2/beacon/blocks/${id}`);
  if (block.execution_optimistic) throw new Error("Optimistic CL execution state");
  // Before Gloas (and in Pectra) the payload is part of the block itself.
  if (block.data.message.body.execution_payload) {
    if (block.data.message.slot !== "0") return block.data.message.body.execution_payload;
    // The genesis block carries an empty payload; the genesis state holds its execution header.
    const state = await json<{
      execution_optimistic: boolean;
      data: { latest_execution_payload_header: { block_hash: string; timestamp: string } };
    }>(`${m.beacon}/eth/v2/debug/beacon/states/${block.data.message.state_root}`);
    if (state.execution_optimistic) throw new Error("Optimistic CL execution state");
    return state.data.latest_execution_payload_header;
  }
  if (m.config.profile === "pectra") throw new Error("Missing Pectra payload");
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
  const block = await json<{
    execution_optimistic: boolean;
    data: {
      message: {
        body: {
          execution_payload?: { block_hash: string };
          signed_execution_payload_bid?: { message: { parent_block_hash: string } };
        };
      };
    };
  }>(`${m.beacon}/eth/v2/beacon/blocks/finalized`);
  if (block.execution_optimistic) throw new Error("Optimistic finalized checkpoint");
  const body = block.data.message.body;
  // A pre-Gloas checkpoint carries its payload; a Gloas checkpoint commits its execution parent.
  if (body.execution_payload) return body.execution_payload.block_hash;
  if (!body.signed_execution_payload_bid) throw new Error("Finalized block has no execution");
  return body.signed_execution_payload_bid.message.parent_block_hash;
}
