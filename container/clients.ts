import { stderr, stdout } from "node:process";
import { runSnapshotCommand } from "../src/snapshot_cli.ts";
import { Network } from "../src/network.ts";
import { Infrastructure } from "../src/docker.ts";
import { saveClients } from "./service.ts";

const usage =
  "Usage: chronix logs <el|cl|vc> [--tail <N|all>] [--follow] | chronix validator-token | chronix clients save [<el>]";
export function clientCommand(args: string[]):
  | { command: "validator-token" }
  | { command: "clients-save"; el?: string }
  | { command: "logs"; role: "el" | "bn" | "vc"; tail: number | "all"; follow: boolean } {
  if (args.length === 1 && args[0] === "validator-token") return { command: "validator-token" };
  if (args[0] === "clients") {
    if (args[1] !== "save" || args.length > 3) throw new Error(usage);
    return args[2] === undefined
      ? { command: "clients-save" }
      : { command: "clients-save", el: args[2] };
  }
  const [command, client, ...options] = args;
  if (command !== "logs" || !["el", "cl", "vc"].includes(client)) throw new Error(usage);
  let tail: number | "all" = 300;
  let follow = false;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === "--follow" || options[i] === "-f") follow = true;
    else if (options[i] === "--tail") {
      const value = options[++i];
      if (value === "all") tail = value;
      else if (/^\d+$/.test(value ?? "") && Number.isSafeInteger(Number(value))) {
        tail = Number(value);
      } else throw new Error(usage);
    } else throw new Error(usage);
  }
  return { command, role: client === "cl" ? "bn" : client as "el" | "vc", tail, follow };
}

if (import.meta.main) {
  try {
    if (Deno.args[0] === "snapshot") {
      console.log(
        JSON.stringify(await runSnapshotCommand("http://127.0.0.1:8545", Deno.args.slice(1))),
      );
    } else {
      const command = clientCommand(Deno.args);
      // Saving archives runs in its own container, before and without a service.
      if (command.command === "clients-save") {
        console.log(
          JSON.stringify({ event: "clients-saved", archives: await saveClients(command.el) }),
        );
      } else {
        const id = (await Deno.readTextFile("/run/chronix/id")).trim();
        const infra = new Infrastructure(id);
        if (command.command === "validator-token") {
          const token = await Deno.readTextFile(
            `${(await Network.manifest(id)).directory}/validator-keys/keys/api-token.txt`,
          );
          console.log(token.trim());
        } else {
          await infra.clientLogs(command.role, command, stdout, stderr);
        }
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
