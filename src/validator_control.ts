import { defaultTimeoutMs, HttpError, json } from "./http.ts";
import type { Manifest } from "./network.ts";

/**
 * Scenario control of validator behavior without client changes.
 *
 * A validator is silent when its key is disabled in, or absent from, the managed VC: the VC then
 * neither requests nor signs anything for it, exactly like an offline operator. Scheduled slot
 * faults are refused on the private VC relay by URL: a missed proposal never asks the beacon node
 * to build its block, and a withheld payload never fetches the self-built envelope to publish.
 * Barriers use the slot view to wait only for duties that an enabled key actually performs.
 */

export type ScheduledFault = "missProposal" | "withholdPayload";
export interface SlotView {
  /** Validator indices without an enabled key in the VC. */
  silent: Set<number>;
  /**
   * Validators whose keys changed recently. The VC caches some duties per epoch, so they may or
   * may not act until it refreshes; barriers never wait for them and accept their votes.
   */
  uncertain: Set<number>;
  proposer?: number;
  /** The 512 validator indices signing sync committee messages at this slot. */
  syncSeats: number[];
  /** Payload timeliness committee members at this slot. */
  ptc: number[];
  pubkeys: Map<number, string>;
}
import type { ManagedValidator } from "../client/types.d.ts";
export type { ManagedValidator };

// Any method: pre-Gloas VCs GET /eth/v3, Gloas VCs POST /eth/v4.
const blockRequest = /^\/eth\/v\d+\/validator\/blocks\/(\d+)$/;
const envelopeRequest =
  /^\/eth\/v1\/validator\/execution_payload_envelopes\/(\d+)\/0x[0-9a-fA-F]{64}$/;

export async function keymanager<T>(
  manifest: Manifest,
  route: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (new URL(manifest.vc).hostname !== "127.0.0.1") {
    throw new Error("Validator keymanager must be local");
  }
  const token = (await Deno.readTextFile(
    `${manifest.directory}/validator-keys/keys/api-token.txt`,
  )).trim();
  const url = `${manifest.vc}${route}`;
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(defaultTimeoutMs()),
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, url, text);
  // Keymanager writes answer 200/202 without a body.
  return (text ? JSON.parse(text) : null) as T;
}

export class ValidatorControl {
  private readonly scheduled = new Map<number, Set<ScheduledFault>>();
  private readonly refusals = new Map<number, Set<"block" | "envelope">>();
  /** Bumped on every key change; slot views computed before a change are stale. */
  version = 0;
  /** First Gloas slot: payload envelopes and payload timeliness duties exist from here on. */
  gloasForkSlot = 0;
  private cache = new Map<string, { version: number; value: unknown }>();

  private readonly changes = new Map<string, number>();
  /** Called after any change of the VC's keys or their enabled state, at protocol `slot`. */
  invalidate(pubkeys: string[] = [], slot?: number): void {
    this.version++;
    if (slot === undefined) return;
    for (const pubkey of pubkeys) this.changes.set(pubkey.toLowerCase(), Math.floor(slot / 32));
  }
  /** Keys changed since the previous epoch began; the VC duty cache may not reflect them yet. */
  recent(epoch: number): Set<string> {
    return new Set(
      [...this.changes].filter(([, changed]) => changed >= epoch - 1).map(([key]) => key),
    );
  }

  schedule(kind: ScheduledFault, slot: number, current: number): void {
    if (!Number.isSafeInteger(slot) || slot <= current) {
      throw new Error(`${kind} needs a future slot after ${current}`);
    }
    if (kind === "withholdPayload" && slot < this.gloasForkSlot) {
      throw new Error(`withholdPayload needs a Gloas slot (from ${this.gloasForkSlot})`);
    }
    const kinds = this.scheduled.get(slot) ?? new Set();
    kinds.add(kind);
    this.scheduled.set(slot, kinds);
  }
  /** Scheduled faults are session state; shutdown drops the ones that have not happened. */
  clearScheduled(): void {
    this.scheduled.clear();
  }
  has(kind: ScheduledFault, slot: number): boolean {
    return this.scheduled.get(slot)?.has(kind) ?? false;
  }
  /** Faults scheduled after `current`; such a branch is not snapshot-safe yet. */
  pending(current: number): { kind: ScheduledFault; slot: number }[] {
    return [...this.scheduled].filter(([slot]) => slot > current).sort(([a], [b]) => a - b)
      .flatMap(([slot, kinds]) => [...kinds].map((kind) => ({ kind, slot })));
  }

  /** Answer a refused VC request locally; anything else is forwarded unchanged. */
  relay(method: string, path: string): Response | undefined {
    const block = blockRequest.exec(path);
    const envelope = method === "GET" ? envelopeRequest.exec(path) : null;
    const slot = Number(block?.[1] ?? envelope?.[1]);
    const kind = block ? "block" : envelope ? "envelope" : undefined;
    if (!kind || !this.has(kind === "block" ? "missProposal" : "withholdPayload", slot)) return;
    const refused = this.refusals.get(slot) ?? new Set();
    refused.add(kind);
    this.refusals.set(slot, refused);
    return Response.json({
      code: 503,
      message: `Panda scenario: ${
        kind === "block" ? "proposal missed" : "payload withheld"
      } at slot ${slot}`,
    }, { status: 503 });
  }
  refused(slot: number, kind: "block" | "envelope"): boolean {
    return this.refusals.get(slot)?.has(kind) ?? false;
  }

  private async cached<T>(key: string, load: () => Promise<T>, versioned = false): Promise<T> {
    const entry = this.cache.get(key);
    if (entry && (!versioned || entry.version === this.version)) return entry.value as T;
    const value = await load();
    this.cache.set(key, { version: this.version, value });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  /** Every registry validator with the VC's view of its key. */
  async validators(manifest: Manifest): Promise<ManagedValidator[]> {
    const [keys, registry] = await Promise.all([
      keymanager<{ data: { enabled: boolean; voting_pubkey: string }[] }>(
        manifest,
        "/lighthouse/validators",
      ),
      json<{ data: { index: string; status: string; validator: { pubkey: string } }[] }>(
        `${manifest.beacon}/eth/v1/beacon/states/head/validators`,
      ),
    ]);
    const enabled = new Map(keys.data.map((key) => [key.voting_pubkey.toLowerCase(), key.enabled]));
    const result: ManagedValidator[] = registry.data.map((entry) => {
      const pubkey = entry.validator.pubkey.toLowerCase();
      return {
        index: Number(entry.index),
        pubkey,
        status: entry.status,
        managed: enabled.has(pubkey),
        online: enabled.get(pubkey) === true,
      };
    });
    // Imported keys whose deposits are not yet in the registry.
    const known = new Set(result.map((entry) => entry.pubkey));
    for (const [pubkey, isEnabled] of enabled) {
      if (!known.has(pubkey)) result.push({ pubkey, managed: true, online: isEnabled });
    }
    return result;
  }

  /** Registry public keys by validator index, refreshed per epoch. */
  async pubkeys(manifest: Manifest, epoch: number): Promise<Map<number, string>> {
    const validators = await this.cached(
      `validators:${epoch}`,
      () => this.validators(manifest),
      true,
    );
    return new Map(
      validators.filter((entry) => entry.index !== undefined)
        .map((entry) => [entry.index!, entry.pubkey]),
    );
  }
  /** Duties of one slot, or undefined when every validator signs and nothing is scheduled. */
  async view(manifest: Manifest, slot: number): Promise<SlotView | undefined> {
    const epoch = Math.floor(slot / 32);
    const validators = await this.cached(
      `validators:${epoch}`,
      () => this.validators(manifest),
      true,
    );
    const silent = new Set(
      validators.filter((entry) => entry.index !== undefined && !entry.online && active(entry))
        .map((entry) => entry.index!),
    );
    const recent = this.recent(epoch);
    // Changed in either direction: the VC may still act on stale duties or lack new ones.
    const uncertain = new Set(
      validators.filter((entry) => entry.index !== undefined && recent.has(entry.pubkey))
        .map((entry) => entry.index!),
    );
    if (!silent.size && !uncertain.size && !this.scheduled.has(slot)) return undefined;
    const beacon = manifest.beacon;
    const proposers = await this.cached(
      `proposers:${epoch}`,
      () =>
        json<{ data: { slot: string; validator_index: string }[] }>(
          `${beacon}/eth/v1/validator/duties/proposer/${epoch}`,
        ),
    );
    // Sync messages at a slot are signed by the committee of the following slot's epoch.
    const syncEpoch = Math.floor((slot + 1) / 32);
    const sync = await this.cached(
      `sync:${syncEpoch}`,
      () =>
        json<{ data: { validators: string[] } }>(
          `${beacon}/eth/v1/beacon/states/head/sync_committees?epoch=${syncEpoch}`,
        ),
    );
    const indices = validators.filter((entry) => entry.index !== undefined)
      .map((entry) => String(entry.index));
    // Before Gloas there is no PTC; in the fork epoch a pre-Gloas head cannot compute it, and the
    // VC cannot know it either, so it is never awaited there.
    const ptc = this.gloasForkSlot > 0 && epoch * 32 <= this.gloasForkSlot
      ? { data: [] }
      : await this.cached(
        `ptc:${epoch}:${indices.length}`,
        () =>
          json<{ data: { slot: string; validator_index: string }[] }>(
            `${beacon}/eth/v1/validator/duties/ptc/${epoch}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(indices),
            },
          ),
      );
    const proposer = proposers.data.find((duty) => Number(duty.slot) === slot)?.validator_index;
    return {
      silent,
      uncertain,
      proposer: proposer === undefined ? undefined : Number(proposer),
      syncSeats: sync.data.validators.map(Number),
      ptc: ptc.data.filter((duty) => Number(duty.slot) === slot)
        .map((duty) => Number(duty.validator_index)),
      pubkeys: new Map(
        validators.filter((entry) => entry.index !== undefined)
          .map((entry) => [entry.index!, entry.pubkey]),
      ),
    };
  }
}

function active(entry: ManagedValidator): boolean {
  return entry.status === undefined || entry.status.startsWith("active");
}

const yamlEscapes: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: "\u00a0",
  L: "\u2028",
  P: "\u2029",
};
/** A single-line YAML scalar as serde_yaml writes it (plain, single- or double-quoted). */
function yamlScalar(value: string): string {
  const text = value.trim();
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Error("Unsupported YAML scalar");
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (!text.startsWith('"')) return text;
  if (!text.endsWith('"') || text.length < 2) throw new Error("Unsupported YAML scalar");
  return text.slice(1, -1).replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g,
    (_, escape: string) => {
      if (/^[xuU]/.test(escape)) return String.fromCodePoint(parseInt(escape.slice(1), 16));
      const result = yamlEscapes[escape];
      if (result === undefined) throw new Error(`Unsupported YAML escape \\${escape}`);
      return result;
    },
  );
}

/**
 * A managed key and its password as the VC loads them: generated keys keep their password in the
 * secrets directory, keymanager imports keep it in the validator definitions.
 */
export async function validatorKey(
  manifest: Pick<Manifest, "directory">,
  pubkey: string,
): Promise<{ keystore: string; password: string } | undefined> {
  const keys = `${manifest.directory}/validator-keys`;
  const definitions = await Deno.readTextFile(`${keys}/keys/validator_definitions.yml`);
  const local = (path: string) => {
    if (!path.startsWith("/shared/validator-keys/") || path.split("/").includes("..")) {
      throw new Error("Validator path escapes generation");
    }
    return `${manifest.directory}/${path.slice("/shared/".length)}`;
  };
  for (const entry of definitions.split(/^- /m).slice(1)) {
    const fields = Object.fromEntries(
      [...entry.matchAll(/^\s*([a-z_]+):\s*(.*)$/gm)].map((match) => [match[1], match[2]]),
    );
    if (yamlScalar(fields.voting_public_key ?? "").toLowerCase() !== pubkey.toLowerCase()) continue;
    if (!fields.voting_keystore_path) return undefined;
    const keystore = await Deno.readTextFile(local(yamlScalar(fields.voting_keystore_path)));
    const password = fields.voting_keystore_password !== undefined
      ? yamlScalar(fields.voting_keystore_password)
      : fields.voting_keystore_password_path !== undefined
      // Lighthouse strips only trailing newlines from password files.
      ? (await Deno.readTextFile(local(yamlScalar(fields.voting_keystore_password_path))))
        .replace(/[\r\n]+$/, "")
      : undefined;
    return password === undefined ? undefined : { keystore, password };
  }
  return undefined;
}
