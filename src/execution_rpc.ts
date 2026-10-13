/** Geth debug methods that only read chain data; every other debug method can mutate the EL. */
const readOnlyDebug = new Set([
  "debug_traceTransaction",
  "debug_traceCall",
  "debug_traceBlock",
  "debug_traceBlockByNumber",
  "debug_traceBlockByHash",
  "debug_traceBadBlock",
  "debug_storageRangeAt",
  "debug_accountRange",
  "debug_dumpBlock",
  "debug_getBadBlocks",
  "debug_getRawBlock",
  "debug_getRawHeader",
  "debug_getRawReceipts",
  "debug_getRawTransaction",
  "debug_getModifiedAccountsByNumber",
  "debug_getModifiedAccountsByHash",
  "debug_intermediateRoots",
]);

/** The first refused method of a JSON-RPC call or batch; malformed JSON is left to Geth. */
export function forbiddenExecutionMethod(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
    const method = (call as { method?: unknown } | null)?.method;
    if (typeof method === "string" && method.startsWith("debug_") && !readOnlyDebug.has(method)) {
      return method;
    }
  }
}
