import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { depositValidator, send } from "./deposit_fixture.ts";
import { report } from "./report.ts";
import { step, testProfiles } from "./test_steps.ts";
import { validator, type ValidatorRecord } from "./validators.ts";

const DEPOSITED_VALIDATOR = 64;
const CONSOLIDATION_SOURCE = 0;
const CONSOLIDATION_TARGET = 1;
const CONSOLIDATION_CONTRACT = "0x0000BBdDc7CE488642fb579F8B00f3a590007251";
const SLOTS_PER_EPOCH = 32;
const ELIGIBILITY_EPOCHS = 256;
const GWEI_PER_ETH = 1_000_000_000n;

async function requestConsolidation(net: Devnet, source: number, target: number) {
  const from = await validator(net, source);
  const to = await validator(net, target);
  const fee = BigInt(
    await net.rpc<string>("eth_call", [
      { to: CONSOLIDATION_CONTRACT, data: "0x" },
      "latest",
    ]),
  );
  await net.setAutomine(true);
  try {
    await send(
      net,
      CONSOLIDATION_CONTRACT,
      from.validator.pubkey + to.validator.pubkey.slice(2),
      fee,
    );
  } finally {
    await net.setAutomine(false);
  }
}

for (const profile of testProfiles(Deno.env.get("CHRONIX_PROFILE"))) {
  Deno.test({
    name: `${profile}: deposit, activation and completed consolidation`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async (t) => {
      const started = performance.now();
      // 64 validators have no consolidation capacity under mainnet churn. Override capacity
      // explicitly for this fixture; activation, eligibility and withdrawal delays stay real.
      await using net = await Devnet.start({
        id: `protocol-${crypto.randomUUID().slice(0, 8)}`,
        profile,
        churnLimitQuotient: 4,
        consolidationChurnLimitQuotient: 4,
      });
      if (profile === "gloas") {
        const spec = await net.beacon<{ data: Record<string, string> }>("/eth/v1/config/spec");
        assert.equal(spec.data.CONSOLIDATION_CHURN_LIMIT_QUOTIENT, "4");
      }
      let depositedPubkey = "";
      let activated!: ValidatorRecord;
      let source!: ValidatorRecord;

      await step(t, "deposit 32 ETH through EL and import the validator key into VC", async () => {
        await net.setAutomine(true);
        try {
          depositedPubkey = await depositValidator(net, DEPOSITED_VALIDATOR);
        } finally {
          await net.setAutomine(false);
        }
      });

      await step(t, "CL activates that deposited validator with the expected pubkey", async () => {
        await net.advanceUntil(async () => {
          try {
            return (await validator(net, DEPOSITED_VALIDATOR)).status === "active_ongoing";
          } catch (error) {
            if (String(error).includes("404")) return false;
            throw error;
          }
        }, { maxSlots: 512, timeoutMs: 600_000 });
        activated = await validator(net, DEPOSITED_VALIDATOR);
        assert.equal(activated.validator.pubkey, depositedPubkey);
        assert.equal(activated.status, "active_ongoing");
      });

      await step(
        t,
        "self-consolidation switches target credentials from 0x01 to 0x02",
        async () => {
          const before = await validator(net, CONSOLIDATION_TARGET);
          assert(before.validator.withdrawal_credentials.startsWith("0x01"));
          await requestConsolidation(net, CONSOLIDATION_TARGET, CONSOLIDATION_TARGET);
          await net.advanceUntil(
            async () =>
              (await validator(net, CONSOLIDATION_TARGET)).validator.withdrawal_credentials
                .startsWith("0x02"),
            { maxSlots: 4, timeoutMs: 180_000 },
          );
        },
      );

      await step(
        t,
        "an eligible consolidation request schedules the source validator exit",
        async () => {
          const eligibilitySlot = ELIGIBILITY_EPOCHS * SLOTS_PER_EPOCH;
          await net.skipSlots(Math.max(0, eligibilitySlot - (await net.status()).slot));
          await requestConsolidation(net, CONSOLIDATION_SOURCE, CONSOLIDATION_TARGET);
          await net.advanceUntil(
            async () => (await validator(net, CONSOLIDATION_SOURCE)).status === "active_exiting",
            { maxSlots: 4, timeoutMs: 180_000 },
          );
          source = await validator(net, CONSOLIDATION_SOURCE);
          assert.equal(source.status, "active_exiting");
        },
      );

      await step(
        t,
        "consolidation empties the source and increases the target balance",
        async () => {
          const targetBalanceBefore = BigInt((await validator(net, CONSOLIDATION_TARGET)).balance);
          const withdrawableSlot = Number(source.validator.withdrawable_epoch) * SLOTS_PER_EPOCH;
          await net.skipSlots(withdrawableSlot - (await net.status()).slot - 1);
          await net.advanceUntil(
            async () => (await validator(net, CONSOLIDATION_SOURCE)).balance === "0",
            { maxSlots: 64, timeoutMs: 180_000 },
          );
          const sourceAfter = await validator(net, CONSOLIDATION_SOURCE);
          const targetAfter = await validator(net, CONSOLIDATION_TARGET);
          assert.equal(sourceAfter.balance, "0");
          // Fast skips incur inactivity penalties; preserve the existing material-transfer check.
          assert(BigInt(targetAfter.balance) > targetBalanceBefore + 16n * GWEI_PER_ETH);
        },
      );

      await report(net, "protocol", {
        event: "protocol-passed",
        passed: true,
        elapsedMs: performance.now() - started,
        activated,
        source: await validator(net, CONSOLIDATION_SOURCE),
        target: await validator(net, CONSOLIDATION_TARGET),
        status: await net.status(),
        churnLimitQuotient: 4,
        consolidationChurnLimitQuotient: profile === "gloas" ? 4 : undefined,
      });
    },
  });
}
