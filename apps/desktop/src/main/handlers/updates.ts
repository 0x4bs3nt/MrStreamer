import { Failed } from "@mrstreamer/core/failure";
import { t } from "@mrstreamer/core/i18n";
import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Updates } from "../services/updates.ts";

export function updateHandlers({
  updates,
  storeReview,
}: {
  readonly updates: Pick<
    Updates["Service"],
    "status" | "setChannel" | "check" | "download" | "cancel" | "restart" | "dismiss" | "openStore"
  >;
  readonly storeReview: (() => Promise<void>) | null;
}): HandlersFor<"updates"> {
  return {
    "updates.status": () => updates.status,
    "updates.setChannel": ({ channel }) => updates.setChannel(channel),
    "updates.check": () => updates.check,
    "updates.download": () => updates.download,
    "updates.cancel": () => Effect.as(updates.cancel, null),
    "updates.restart": () => Effect.as(updates.restart, null),
    "updates.dismiss": ({ version }) => updates.dismiss(version),
    "updates.openStore": () => Effect.as(updates.openStore, null),
    "updates.rateStore": () =>
      storeReview
        ? Effect.as(
            Effect.tryPromise({
              try: storeReview,
              catch: () =>
                new Failed({
                  error: {
                    kind: "unexpected",
                    detail: t("The Microsoft Store could not be opened."),
                  },
                }),
            }),
            null,
          )
        : Effect.succeed(null),
  };
}
