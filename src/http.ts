import { AsyncLocalStorage } from "node:async_hooks";

/** A runtime watchdog, not a performance target. Tests may supply a stricter budget. */
export function defaultTimeoutMs(): number {
  const value = Number(Deno.env.get("CHRONIX_TIMEOUT_MS") ?? 3_600_000);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error("CHRONIX_TIMEOUT_MS must be an integer from 1 to 2147483647");
  }
  return value;
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * The abort signal of the running command. Every `waitFor` and `json` that the command reaches
 * observes it, so an aborted command ends at its next wait or request.
 */
const commandSignal = new AsyncLocalStorage<AbortSignal>();
/** Run a command whose waits and requests end, with the signal's reason, once it aborts. */
export function abortable<T>(signal: AbortSignal, command: () => Promise<T>): Promise<T> {
  return commandSignal.run(signal, command);
}
/** Run outside any command, such as the client check that aborts one. */
export function detached<T>(work: () => T): T {
  return commandSignal.exit(work);
}
export async function deadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = defaultTimeoutMs(),
): Promise<T> {
  const signal = commandSignal.getStore();
  const end = performance.now() + timeoutMs;
  let last: unknown;
  let pause = 10;
  while (performance.now() < end) {
    signal?.throwIfAborted();
    let value: T | undefined;
    try {
      value = await deadline(probe(), Math.max(1, end - performance.now()), description);
    } catch (error) {
      last = error;
    }
    // An aborted command takes no further step, even after a probe that succeeded.
    signal?.throwIfAborted();
    if (value !== undefined) return value;
    await delay(Math.min(pause, Math.max(0, end - performance.now())));
    pause = Math.min(250, pause * 1.5);
  }
  throw new Error(`Timed out: ${description} (${timeoutMs} ms)${last ? ` (${last})` : ""}`);
}
export class HttpError extends Error {
  constructor(readonly status: number, url: string, body: string) {
    super(`${status} ${url}: ${body}`);
  }
}
export async function json<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const signal = init.signal ?? AbortSignal.timeout(defaultTimeoutMs());
  const command = commandSignal.getStore();
  const response = await fetch(url, {
    ...init,
    signal: command ? AbortSignal.any([signal, command]) : signal,
  });
  if (!response.ok) throw new HttpError(response.status, url, await response.text());
  return await response.json();
}
export async function rpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const response = await json<{ result: T; error?: { code: number; message: string } }>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (response.error) {
    throw new Error(`${method}: ${response.error.message} (${response.error.code})`);
  }
  return response.result;
}

/** Preserve decoded fetch bodies without advertising their former compressed size. */
export function forwardedHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  if (response.url && /^(gzip|deflate|br)$/i.test(headers.get("content-encoding") ?? "")) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  return headers;
}
