# Protocol lifecycle tests

The same real EL/Lighthouse scenarios run for every maintained hardfork in `src/profiles.ts`:
currently only **Gloas**. Pectra stays registered as history and is never selected. Each `Deno.test`
owns a fresh network. Its named `t.step` stages share that network, stop on the first failed stage
and always dispose their own resources.

Start with these two readable suites:

| Suite                                    | Named stages                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [protocol_test.ts](protocol_test.ts)     | 32 ETH deposit → CL activation → compounding credentials → consolidation request/source exit → balance transfer |
| [withdrawal_test.ts](withdrawal_test.ts) | Real finality → exit eligibility → signed voluntary exit → EL withdrawal → committee rotation/final sweep       |

Consolidation explicitly increases churn capacity for the small 64-validator fixture. Eligibility
and withdrawal delays remain unchanged. The exit suite uses ordinary churn settings. Fast skips
execute real empty-slot transitions and incur inactivity penalties, so balance assertions account
for those penalties.

## Run

Use an existing compatible bake; these commands never compile Lighthouse:

```sh
# Both lifecycle suites, sequentially, for all maintained hardforks.
CHRONIX_BAKE=ci-main-merge deno task test:protocol

# Only one hardfork, using its selected local bake.
CHRONIX_PROFILE=gloas CHRONIX_BAKE=ci-main-merge deno task test:protocol

# Only deposit/consolidation or exit/withdrawal, across maintained hardforks.
CHRONIX_BAKE=ci-main-merge deno task e2e:protocol
CHRONIX_BAKE=ci-main-merge deno task e2e:withdrawal
```

Without `CHRONIX_BAKE`, each profile uses its `default` tag. `CHRONIX_EL` selects the EL catalog
entry (default `reth-main-f4676ea`). "All hardforks" means the maintained profiles using that
selected bake, not every historical Chronix image tag. Set `CHRONIX_PROFILE` to select one profile;
a historical profile is refused. A newly maintained hardfork joins the direct lifecycle matrix
automatically.

`test:profile <hardfork> --bake <tag>` and image publication CI run these same test files for their
selected hardfork, alongside the other profile checks. The scenario runner uses `deno test` for
`*_test.ts` suites and `deno run` for the existing standalone scenarios. CI displays each lifecycle
stage and fails on a failed nested step.

Successful scenario evidence is written to `reports/profiles/<hardfork>/<bake>/<el>/protocol.json`
and `withdrawal.json`, with the EL name and image ID. A targeted lifecycle run does not certify the
full profile suite. Full verification also binds all reports to the bake key, the EL, the run ID and
the current suite fingerprint.
