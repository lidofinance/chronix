import type { Recipe } from "./profiles.ts";

/** Duty timing of one slot under the fork active at that slot. */
export interface SlotTiming {
  gloas: boolean;
  phases: readonly number[];
  attestationMs: number;
  aggregateMs: number;
}

/** Pre-Gloas due times from the beacon node's spec (basis points of the slot, rounded up). */
export function preGloasTiming(
  spec: Record<string, unknown>,
  slotMs = 12_000,
): { attestationMs: number; aggregateMs: number } {
  const due = (key: string) => {
    const bps = Number(spec[key]);
    if (!Number.isSafeInteger(bps) || bps <= 0 || bps >= 10_000) throw new Error(`Invalid ${key}`);
    return Math.ceil(slotMs * bps / 10_000);
  };
  return { attestationMs: due("ATTESTATION_DUE_BPS"), aggregateMs: due("AGGREGATE_DUE_BPS") };
}

/**
 * Gloas may activate after genesis. Earlier (Fulu) slots carry their payload inside the block,
 * have no payload timeliness committee and use the beacon node's own attestation due times.
 */
export class ForkSchedule {
  constructor(
    readonly gloasEpoch: number,
    readonly recipe: Pick<
      Recipe,
      "phases" | "attestationMs" | "aggregateMs" | "slotsPerEpoch" | "tailMs"
    >,
    readonly before?: { attestationMs: number; aggregateMs: number },
  ) {
    if (gloasEpoch > 0 && !before) throw new Error("A later Gloas fork needs pre-Gloas due times");
  }
  get forkSlot(): number {
    return this.gloasEpoch * (this.recipe.slotsPerEpoch ?? 32);
  }
  timing(slot: number): SlotTiming {
    if (slot >= this.forkSlot || !this.before) {
      return {
        gloas: true,
        phases: this.recipe.phases,
        attestationMs: this.recipe.attestationMs,
        aggregateMs: this.recipe.aggregateMs,
      };
    }
    const { attestationMs, aggregateMs } = this.before;
    // The beacon node advances state at 3/4 slot and prepares fork choice at the tail.
    const phases = [
      ...new Set([0, attestationMs, aggregateMs, 9_000, this.recipe.tailMs ?? 11_500]),
    ]
      .sort((a, b) => a - b);
    return { gloas: false, phases, attestationMs, aggregateMs };
  }
}
