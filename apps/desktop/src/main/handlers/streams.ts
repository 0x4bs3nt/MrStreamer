import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { ArchiveWindow } from "@mrstreamer/contracts/playback";
import { streamsToPlay } from "@mrstreamer/core/catalogue/variants";
import { archiveVariants } from "@mrstreamer/core/catchup";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import * as Effect from "effect/Effect";
import type { Settings } from "../services/preferences.ts";

/**
 * The channel's streams to try, by id: the one asked for, the one picked for it in its
 * subscription before, or Automatic's. For `archive`, of those whose catch-up keeps it alone,
 * which fails with `catch-up` when none does. Fails when the channel has none of them.
 */
export const streamsOf = (
  settings: Pick<Settings["Service"], "get" | "ofSubscription">,
  channel: LiveChannel,
  variant: string | undefined,
  archive?: ArchiveWindow,
) =>
  Effect.gen(function* () {
    const preferences = {
      ...(yield* settings.get),
      ...(yield* settings.ofSubscription(channel.subscriptionId)),
    };
    const playable = archive
      ? {
          variants: yield* Effect.try({
            try: () => archiveVariants(channel, archive, Date.now()),
            catch: failedWith,
          }),
        }
      : channel;
    const variants = streamsToPlay(playable, preferences, variant).map(({ id }) => id);
    if (variants.length > 0) return variants;
    return yield* new Failed({
      error: { kind: "channel-not-found", channelId: variant ?? channel.id },
    });
  });
