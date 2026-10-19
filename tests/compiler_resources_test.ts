import assert from "node:assert/strict";
import { dockerClient, Infrastructure, LABEL, ROLE } from "../src/docker.ts";

// Model Docker's CPU validation without starting a daemon or compiler.
for (const cpus of [1, 2, 8]) {
  Deno.test(`CL compiler containers fit a ${cpus}-CPU Docker daemon`, async () => {
    const docker = dockerClient();
    docker.info = (() => Promise.resolve({ NCPU: cpus })) as typeof docker.info;
    const created: Parameters<typeof docker.createContainer>[0][] = [];
    docker.createContainer = ((options) => {
      if ((options.HostConfig?.NanoCpus ?? 0) > cpus * 1e9) {
        return Promise.reject(new Error(`CPU limit exceeds the ${cpus}-CPU Docker daemon`));
      }
      created.push(options);
      return Promise.resolve(docker.getContainer(`compiler-${created.length}`));
    }) as typeof docker.createContainer;
    const infra = new Infrastructure("unit-compiler", docker);
    await infra.compilerContainer({
      Image: "unit-builder",
      Cmd: ["compiler"],
      Env: ["UNIT_BUILD=1"],
      HostConfig: { Binds: ["/fixture:/source"], Memory: 1024 },
    });
    assert.equal(created.length, 1);
    const options = created[0];
    assert.equal(options.HostConfig?.NanoCpus, Math.min(cpus, 4) * 1e9);
    assert.deepEqual(options.HostConfig?.Binds, ["/fixture:/source"]);
    assert.equal(options.HostConfig?.Memory, 1024);
    assert.equal(options.Image, "unit-builder");
    assert.deepEqual(options.Cmd, ["compiler"]);
    assert.deepEqual(options.Env, ["UNIT_BUILD=1"]);
    assert.equal(options.Labels?.[LABEL], infra.id);
    assert.equal(options.Labels?.[ROLE], "cl");
  });
}

Deno.test("invalid Docker CPU information fails before creating compiler containers", async () => {
  const docker = dockerClient();
  let created = 0;
  docker.createContainer = (() => {
    created++;
    return Promise.resolve(docker.getContainer("unexpected"));
  }) as typeof docker.createContainer;
  const infra = new Infrastructure("unit-compiler-info", docker);
  for (const cpus of [undefined, 0, -1, NaN, 1.5]) {
    docker.info = (() => Promise.resolve({ NCPU: cpus })) as typeof docker.info;
    await assert.rejects(infra.compilerContainer({ Image: "unit-builder" }), /CPU count/);
  }
  docker.info = (() => Promise.reject(new Error("Docker unavailable"))) as typeof docker.info;
  await assert.rejects(
    infra.compilerContainer({ Image: "unit-builder" }),
    /Docker unavailable/,
  );
  assert.equal(created, 0);
});
