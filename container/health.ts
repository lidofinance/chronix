import { json, rpc } from "../src/http.ts";

const url = "http://127.0.0.1:8545";
const [status, block, beacon] = await Promise.all([
  json<{ result: { automineError?: string } }>(`${url}/control`, {
    method: "POST",
    body: JSON.stringify({ method: "status" }),
    signal: AbortSignal.timeout(8000),
  }),
  rpc<{ hash: string }>(url, "eth_getBlockByNumber", ["latest", false]),
  json<{ data: unknown }>(`${url}/eth/v1/beacon/headers/head`, {
    signal: AbortSignal.timeout(8000),
  }),
]);
if (!block?.hash || !beacon?.data || status.result.automineError) {
  throw new Error("Chronix service is unhealthy");
}
