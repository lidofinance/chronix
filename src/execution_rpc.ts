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

/**
 * The first refused method of a JSON-RPC call or batch, or a description of an ambiguous body.
 * Geth decodes only the first JSON value and matches field names case-insensitively, so a body
 * that JavaScript reads differently is refused whenever it could name a debug method. Other
 * malformed JSON is left to Geth, which answers it without any state change.
 */
export function forbiddenExecutionMethod(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return /debug|\\u/i.test(body) ? "ambiguous JSON-RPC body naming a debug method" : undefined;
  }
  for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!call || typeof call !== "object") continue;
    for (const key of Object.keys(call)) {
      if (key !== "method" && key.toLowerCase() === "method") {
        return `ambiguous JSON-RPC method field "${key}"`;
      }
    }
    const method = (call as { method?: unknown }).method;
    if (typeof method === "string" && method.startsWith("debug_") && !readOnlyDebug.has(method)) {
      return method;
    }
  }
}
