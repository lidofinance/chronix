import assert from "node:assert/strict";
import { concat, toQuantity, Wallet, zeroPadValue } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { report } from "./report.ts";
import { step, testProfiles } from "./test_steps.ts";
import { exitValidator, validator, type ValidatorRecord } from "./validators.ts";

const EXITING_VALIDATOR = 0;
const SLOTS_PER_EPOCH = 32;
const ELIGIBILITY_EPOCHS = 256;
const WITHDRAWAL_DELAY_EPOCHS = 256;
const SYNC_COMMITTEE_PERIOD_EPOCHS = 256;
const GWEI_PER_ETH = 1_000_000_000n;
const FAR_FUTURE_EPOCH = "18446744073709551615";
// EIP-7002 system contract; genesis validators withdraw to the development account.
const WITHDRAWAL_REQUESTS = "0x00000961Ef480Eb55e80D19ad83579A64c007002";
const REQUEST_EXITING_VALIDATOR = 1;
const WITHHELD_REQUEST_VALIDATOR = 2;
type Withdrawal = { validatorIndex: string; amount: string; address: string };

for (const profile of testProfiles(Deno.env.get("CHRONIX_PROFILE"))) {
  Deno.test({
    name: `${profile}: signed voluntary exit and complete EL withdrawal`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async (t) => {
      const started = performance.now();
      await using net = await Devnet.start({
        id: `withdrawal-${crypto.randomUUID().slice(0, 8)}`,
        profile,
      });
      let exiting!: ValidatorRecord;
      let afterFirstWithdrawal!: ValidatorRecord;
      let withdrawal: Withdrawal | undefined;
      const requests: Record<string, unknown> = {};
      const wallet = new Wallet(privateKey);
      /** A full-exit request from the withdrawal address, paying the contract's current fee. */
      const requestExit = async (index: number) => {
        const { pubkey } = (await validator(net, index)).validator;
        const fee = BigInt(
          await net.rpc<string>("eth_call", [{ to: WITHDRAWAL_REQUESTS, data: "0x" }, "latest"]),
        );
        const data = concat([pubkey, zeroPadValue("0x00", 8)]);
        // Amsterdam prices new storage high, and the request queue writes fresh slots.
        const gasLimit = BigInt(
          await net.rpc<string>("eth_estimateGas", [{
            from: account,
            to: WITHDRAWAL_REQUESTS,
            value: toQuantity(fee),
            data,
          }]),
        );
        const hash = await net.rpc<string>("eth_sendRawTransaction", [
          await wallet.signTransaction({
            type: 2,
            chainId: 1337,
            nonce: Number(await net.rpc<string>("eth_getTransactionCount", [account, "pending"])),
            to: WITHDRAWAL_REQUESTS,
            value: fee,
            data,
            gasLimit,
            maxFeePerGas: 10_000_000_000n,
            maxPriorityFeePerGas: 1_000_000_000n,
          }),
        ]);
        return { hash, fee };
      };
      const receiptOf = (hash: string) =>
        net.rpc<{ status: string; gasUsed: string } | null>("eth_getTransactionReceipt", [hash]);
      const succeeded = async (hash: string) => (await receiptOf(hash))?.status === "0x1";

      await step(t, "establish real CL finality before testing the exit lifecycle", async () => {
        await net.advanceUntil(
          async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 2n,
          { maxSlots: 160, timeoutMs: 300_000 },
        );
      });

      await step(
        t,
        "reach exit eligibility without producing blocks during the skipped range",
        async () => {
          const before = await net.status();
          await net.skipSlots(ELIGIBILITY_EPOCHS * SLOTS_PER_EPOCH - before.slot);
          assert.equal((await net.status()).el.hash, before.el.hash, "skip produced a block");
          await net.stepSlot();
        },
      );

      await step(
        t,
        "CL accepts a signed voluntary exit and preserves the 256-epoch withdrawal delay",
        async () => {
          await exitValidator(net, EXITING_VALIDATOR);
          await net.stepSlot();
          exiting = await validator(net, EXITING_VALIDATOR);
          assert.equal(exiting.status, "active_exiting");
          assert(
            Number(exiting.validator.withdrawable_epoch) >=
              Number(exiting.validator.exit_epoch) + WITHDRAWAL_DELAY_EPOCHS,
          );
        },
      );

      // Gloas applies execution requests in the child block of their payload; withholding a
      // payload exists only there.
      if (profile === "gloas") {
        await step(
          t,
          "an EIP-7002 exit request takes effect in the child block of its payload",
          async () => {
            const { hash, fee } = await requestExit(REQUEST_EXITING_VALIDATOR);
            await net.stepSlot();
            assert(await succeeded(hash), "the exit request transaction failed");
            assert.equal(
              (await validator(net, REQUEST_EXITING_VALIDATOR)).validator.exit_epoch,
              FAR_FUTURE_EPOCH,
              "the request took effect in the block of its own payload",
            );
            await net.stepSlot();
            const record = await validator(net, REQUEST_EXITING_VALIDATOR);
            assert.equal(record.status, "active_exiting", "the child block did not start the exit");
            requests.direct = {
              hash,
              fee: String(fee),
              gasUsed: BigInt((await receiptOf(hash))!.gasUsed).toString(),
              exitEpoch: record.validator.exit_epoch,
            };
          },
        );

        await step(
          t,
          "an EIP-7002 exit request sent before a withheld payload takes effect after the next payload",
          async () => {
            const withheld = (await net.status()).slot + 1;
            await net.withholdPayload(withheld);
            const { hash } = await requestExit(WITHHELD_REQUEST_VALIDATOR);
            await net.stepSlot();
            assert.equal(await succeeded(hash), false, "a withheld payload reached the EL");
            await net.stepSlot();
            assert(await succeeded(hash), "the request did not land in the next payload");
            assert.equal(
              (await validator(net, WITHHELD_REQUEST_VALIDATOR)).validator.exit_epoch,
              FAR_FUTURE_EPOCH,
              "the request took effect before the child of its payload",
            );
            await net.stepSlot();
            const record = await validator(net, WITHHELD_REQUEST_VALIDATOR);
            assert.equal(record.status, "active_exiting", "the request did not start the exit");
            requests.withheld = { slot: withheld, hash, exitEpoch: record.validator.exit_epoch };
          },
        );
      }

      await step(
        t,
        "EL includes the validator withdrawal after the real protocol delay",
        async () => {
          const withdrawableSlot = Number(exiting.validator.withdrawable_epoch) * SLOTS_PER_EPOCH;
          await net.skipSlots(withdrawableSlot - (await net.status()).slot - 1);
          await net.advanceUntil(async () => {
            const block = await net.rpc<{ withdrawals: Withdrawal[] }>(
              "eth_getBlockByNumber",
              ["latest", false],
            );
            withdrawal = block.withdrawals.find((item) =>
              BigInt(item.validatorIndex) === BigInt(EXITING_VALIDATOR) &&
              BigInt(item.amount) > 16n * GWEI_PER_ETH
            );
            return withdrawal !== undefined;
          }, { maxSlots: 16, timeoutMs: 180_000 });
          assert(withdrawal, "Missing actual EL withdrawal");
          afterFirstWithdrawal = await validator(net, EXITING_VALIDATOR);
          assert(BigInt(afterFirstWithdrawal.balance) < GWEI_PER_ETH);
        },
      );

      await step(
        t,
        "the final sweep leaves zero balance and withdrawal_done after committee rotation",
        async () => {
          // An exited sync committee member can still receive rewards until the committee rotates.
          // Lighthouse updates effective_balance per epoch before reporting withdrawal_done.
          const withdrawableEpoch = Number(exiting.validator.withdrawable_epoch);
          const nextPeriodEpoch =
            (Math.floor(withdrawableEpoch / SYNC_COMMITTEE_PERIOD_EPOCHS) + 1) *
            SYNC_COMMITTEE_PERIOD_EPOCHS;
          await net.skipSlots(nextPeriodEpoch * SLOTS_PER_EPOCH - (await net.status()).slot - 1);
          await net.advanceUntil(async () => {
            const record = await validator(net, EXITING_VALIDATOR);
            return record.balance === "0" && record.status === "withdrawal_done";
          }, { maxSlots: 64, timeoutMs: 180_000 });
          const exited = await validator(net, EXITING_VALIDATOR);
          assert.equal(exited.status, "withdrawal_done");
          assert.equal(exited.balance, "0");
        },
      );

      await report(net, "withdrawal", {
        event: "withdrawal-passed",
        passed: true,
        elapsedMs: performance.now() - started,
        exiting,
        afterFirstWithdrawal,
        exited: await validator(net, EXITING_VALIDATOR),
        withdrawal,
        requests,
        status: await net.status(),
      });
    },
  });
}
