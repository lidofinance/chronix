import { json, rpc } from "../src/http.ts";

const url = "http://127.0.0.1:8545";
const [status, block, beacon] = await Promise.allSettled([
  json<{ result: { automineError?: string; clientError?: string } }>(`${url}/control`, {
    method: "POST",
    body: JSON.stringify({ method: "status" }),
    signal: AbortSignal.timeout(8000),
  }),
  rpc<{ hash: string }>(url, "eth_getBlockByNumber", ["latest", false]),
  json<{ data: unknown }>(`${url}/eth/v1/beacon/headers/head`, {
    signal: AbortSignal.timeout(8000),
  }),
]);
// Docker keeps the message in the container's health log. A lost EL or beacon node also fails
// its own read, but only the status (resolved or rejected) names the client.
if (status.status === "rejected") throw status.reason;
const { automineError, clientError } = status.value.result;
if (clientError) throw new Error(clientError);
if (block.status === "rejected") throw block.reason;
if (beacon.status === "rejected") throw beacon.reason;
if (!block.value?.hash || !beacon.value?.data || automineError) {
  throw new Error("Chronix service is unhealthy");
}
