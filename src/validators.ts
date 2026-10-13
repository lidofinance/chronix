import { defaultTimeoutMs } from "./http.ts";
import type { Manifest } from "./network.ts";
import { keymanager, type ValidatorControl, validatorKey } from "./validator_control.ts";

const pubkeyPattern = /^0x[a-f0-9]{96}$/i;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;

export async function importValidator(manifest: Manifest, keystore: unknown, password: unknown) {
  if (typeof keystore !== "string" || typeof password !== "string") {
    throw new Error("importValidator expects an EIP-2335 JSON string and a password string");
  }
  const key = JSON.parse(keystore);
  if (key?.version !== 4 || !/^[a-f0-9]{96}$/i.test(key?.pubkey ?? "")) {
    throw new Error("Invalid EIP-2335 keystore version or pubkey");
  }
  const result = await keymanager<{ data: { status: string }[] }>(
    manifest,
    "/eth/v1/keystores",
    "POST",
    { keystores: [keystore], passwords: [password] },
  );
  if (result.data?.length !== 1 || result.data[0].status !== "imported") {
    throw new Error(`Validator import rejected: ${result.data?.[0]?.status ?? "invalid response"}`);
  }
  return null;
}

export async function exitValidator(manifest: Manifest, pubkey: unknown) {
  if (typeof pubkey !== "string" || !/^0x[a-f0-9]{96}$/i.test(pubkey)) {
    throw new Error("exitValidator expects a 48-byte hex pubkey");
  }
  const signed = await keymanager<{ data: { message: unknown; signature: string } }>(
    manifest,
    `/eth/v1/validator/${pubkey}/voluntary_exit`,
    "POST",
  );
  if (!signed.data?.message || typeof signed.data.signature !== "string") {
    throw new Error("Keymanager returned an invalid signed exit");
  }
  const response = await fetch(`${manifest.beacon}/eth/v1/beacon/pool/voluntary_exits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed.data),
    signal: AbortSignal.timeout(defaultTimeoutMs()),
  });
  if (!response.ok) throw new Error(`Exit rejected: ${await response.text()}`);
  await response.body?.cancel();
  return null;
}

/** Enable or disable managed keys; a disabled validator neither requests nor signs anything. */
export async function setValidatorsOnline(
  manifest: Manifest,
  control: ValidatorControl,
  selector: unknown,
  online: unknown,
  slot?: number,
) {
  if (typeof online !== "boolean") throw new Error("setValidatorsOnline expects a boolean");
  if (!Array.isArray(selector) || !selector.length) {
    throw new Error("Select validators by a non-empty list of indices or public keys");
  }
  const validators = await control.validators(manifest);
  const pubkeys = selector.map((item) => {
    const found = validators.find((entry) =>
      typeof item === "number" ? entry.index === item : entry.pubkey === String(item).toLowerCase()
    );
    if (!found?.managed) throw new Error(`Validator ${item} is not managed by the VC`);
    return found.pubkey;
  });
  try {
    for (const pubkey of pubkeys) {
      await keymanager(manifest, `/lighthouse/validators/${pubkey}`, "PATCH", { enabled: online });
    }
  } finally {
    control.invalidate(pubkeys, slot);
  }
  return null;
}

/** Remove a key from the VC and hand it back with its slashing protection interchange. */
export async function removeValidator(
  manifest: Manifest,
  control: ValidatorControl,
  pubkey: unknown,
  slot?: number,
) {
  if (typeof pubkey !== "string" || !pubkeyPattern.test(pubkey)) {
    throw new Error("removeValidator expects a 48-byte hex pubkey");
  }
  const key = pubkey.toLowerCase();
  // Read before deletion; Lighthouse removes the keystore with its definition.
  const material = await validatorKey(manifest, key);
  const keystore = material?.keystore;
  const password = material?.password;
  try {
    const result = await keymanager<{ data: { status: string }[]; slashing_protection: string }>(
      manifest,
      "/eth/v1/keystores",
      "DELETE",
      { pubkeys: [key] },
    );
    if (result?.data?.length !== 1 || result.data[0].status !== "deleted") {
      throw new Error(`Validator removal rejected: ${result?.data?.[0]?.status ?? "invalid"}`);
    }
    return { pubkey: key, keystore, password, slashingProtection: result.slashing_protection };
  } finally {
    control.invalidate([key], slot);
  }
}

/** Per-validator proposer settings through the standard keymanager API. */
export async function configureValidator(manifest: Manifest, pubkey: unknown, options: unknown) {
  if (typeof pubkey !== "string" || !pubkeyPattern.test(pubkey)) {
    throw new Error("configureValidator expects a 48-byte hex pubkey");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("configureValidator expects an options object");
  }
  const { feeRecipient, gasLimit, graffiti, ...unknown } = options as Record<string, unknown>;
  if (Object.keys(unknown).length) {
    throw new Error(`Unknown validator settings: ${Object.keys(unknown).join(", ")}`);
  }
  if (
    feeRecipient !== undefined &&
    (typeof feeRecipient !== "string" || !addressPattern.test(feeRecipient))
  ) {
    throw new Error("Invalid fee recipient");
  }
  if (gasLimit !== undefined && (!Number.isSafeInteger(gasLimit) || (gasLimit as number) < 5000)) {
    throw new Error("Invalid gas limit");
  }
  if (
    graffiti !== undefined &&
    (typeof graffiti !== "string" || new TextEncoder().encode(graffiti).length > 32)
  ) throw new Error("Graffiti must be at most 32 bytes");
  const key = pubkey.toLowerCase();
  if (feeRecipient !== undefined) {
    await keymanager(manifest, `/eth/v1/validator/${key}/feerecipient`, "POST", {
      ethaddress: feeRecipient,
    });
  }
  if (gasLimit !== undefined) {
    await keymanager(manifest, `/eth/v1/validator/${key}/gas_limit`, "POST", {
      gas_limit: String(gasLimit),
    });
  }
  if (graffiti !== undefined) {
    await keymanager(manifest, `/eth/v1/validator/${key}/graffiti`, "POST", { graffiti });
  }
  return null;
}
