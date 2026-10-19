import { defaultEl } from "../src/config.ts";
import { bakeTags, profiles, readBake } from "../src/profiles.ts";
import { verificationStatus } from "../src/verification.ts";
for (const profile of Object.keys(profiles) as (keyof typeof profiles)[]) {
  for (const tag of await bakeTags(profile)) {
    const bake = await readBake(profile, tag);
    // Verification of the EL a release ships.
    const { verified, verifiedAt } = await verificationStatus(bake, defaultEl);
    console.log(
      JSON.stringify({
        profile,
        tag: bake.tag,
        key: bake.key,
        platform: bake.images.cl.platform,
        cl: bake.source.cl,
        el: defaultEl,
        verifiedAt,
        verified,
      }),
    );
  }
}
