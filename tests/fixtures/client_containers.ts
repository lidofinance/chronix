import { LABEL, ROLE } from "../../src/docker.ts";
import type { Network } from "../../src/network.ts";

/** One client container as the fake Docker daemon reports it. */
export interface FakeClient {
  role: string;
  running: boolean;
  exitCode?: number;
  oomKilled?: boolean;
  /** The container's `io.chronix.id`; the network's own id by default. */
  id?: string;
  /** A container that a client restart replaced (`chronix-<id>-<role>-previous`). */
  previous?: boolean;
}

/** The managed EL, beacon node and validator client of a network, all running. */
export function runningClients(): FakeClient[] {
  return ["el", "bn", "vc"].map((role) => ({ role, running: true }));
}

/**
 * Replace the network's Docker reads with a daemon holding `clients`. Label filters and `all`
 * behave like Docker's; the array is read at each call, so a test can change a client later.
 * Every list filter and every inspected container is recorded.
 */
export function fakeClients(network: Network, clients: FakeClient[]) {
  const docker = network.infra.docker;
  const calls = { list: [] as string[][], inspect: [] as string[] };
  const listed = (client: FakeClient, index: number) => {
    const id = client.id ?? network.config.id;
    return {
      Id: `fake-${index}`,
      Names: [`/chronix-${id}-${client.role}${client.previous ? "-previous" : ""}`],
      Labels: { [LABEL]: id, [ROLE]: client.role } as Record<string, string>,
      State: client.running ? "running" : "exited",
      Status: client.running ? "Up 1 minute" : `Exited (${client.exitCode ?? 0}) 1 second ago`,
    };
  };
  docker.listContainers = ((options?: {
    all?: boolean;
    filters?: string | Record<string, string[]>;
  }) => {
    const filters = typeof options?.filters === "string"
      ? JSON.parse(options.filters) as Record<string, string[]>
      : options?.filters ?? {};
    const labels = filters.label ?? [];
    calls.list.push(labels);
    return Promise.resolve(
      clients.map(listed).filter((entry) =>
        (options?.all || entry.State === "running") &&
        labels.every((label) => {
          const [key, ...value] = label.split("=");
          return value.length ? entry.Labels[key] === value.join("=") : key in entry.Labels;
        })
      ),
    );
  }) as unknown as typeof docker.listContainers;
  docker.getContainer = ((reference: string) => ({
    id: reference,
    inspect: () => {
      calls.inspect.push(reference);
      const index = clients.findIndex((client, index) =>
        listed(client, index).Id === reference ||
        listed(client, index).Names[0] === `/${reference}`
      );
      if (index < 0) {
        return Promise.reject(Object.assign(new Error("no such container"), { statusCode: 404 }));
      }
      const client = clients[index];
      const entry = listed(client, index);
      return Promise.resolve({
        Id: entry.Id,
        Name: entry.Names[0],
        Image: `sha256:${"0".repeat(64)}`,
        Config: { Labels: entry.Labels, Env: [] },
        HostConfig: { NetworkMode: `chronix-${client.id ?? network.config.id}` },
        State: {
          Status: entry.State,
          Running: client.running,
          ExitCode: client.running ? 0 : client.exitCode ?? 0,
          OOMKilled: client.oomKilled === true,
          StartedAt: "2033-05-18T03:33:20Z",
        },
      });
    },
  })) as unknown as typeof docker.getContainer;
  return calls;
}
