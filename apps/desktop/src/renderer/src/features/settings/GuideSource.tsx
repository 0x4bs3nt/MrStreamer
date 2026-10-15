// A subscription's programme guide in Settings > Subscriptions, in its details: where its
// channels' programmes come from, its own guide's and each XMLTV source's of Settings > Guides
// that supplies any, by the name Settings > Guides gives it (`guideNames`), and how many have none; a refresh of its own guide, and a way to the
// sources. Under it, the channels mapped by hand.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import type { GuideSourceStatus, GuideStatus } from "@mrstreamer/contracts/guide";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { pastTime } from "../../lib/format.ts";
import { guideName } from "../../lib/guide-names.ts";
import { call } from "../../lib/ipc.ts";
import { keepGuideStatus, queries, subscriptionName } from "../../lib/queries.ts";
import { Row } from "./Rows.tsx";

/**
 * The Guide row of a subscription's details, and under it the channels mapped by hand. The row
 * says how many channels each guide supplies, its own first, and refreshes its own guide; Guides
 * opens the sources. A download of its own guide that failed says why under it, since when, and
 * from when the listings it keeps are.
 */
export function GuideRows({
  subscription,
  guide,
  onMap,
}: {
  subscription: SubscriptionSummary;
  guide: GuideStatus | undefined;
  onMap: () => void;
}) {
  const client = useQueryClient();
  const sources = useQuery(queries.guideSources()).data ?? [];
  const name = subscriptionName(subscription);
  const refresh = useMutation({
    mutationFn: () => call("guide.refresh", { subscriptionId: subscription.id }),
    onSuccess: (status) => keepGuideStatus(client, status),
  });
  const now = Date.now();
  const failed = guide?.processing.state === "failed" ? guide.processing : null;
  const failure = refresh.error ? appError(refresh.error) : (failed?.reason ?? null);
  return (
    <>
      <Row label={t("Guide")} note={guide ? supplied(guide, sources) : t("not loaded yet")} wrap>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("Refresh guide of {name}", { name })}
          disabled={refresh.isPending || guide?.processing.state === "downloading"}
          onClick={() => refresh.mutate()}
        >
          <RotateCw />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => useUi.setState({ settings: "guides" })}>
          {t("Guides")}
        </Button>
      </Row>
      <div aria-live="polite">
        {failure && (
          <p className="mt-2 mb-1 text-sm text-destructive">
            {[
              describeError(failure),
              failed && t("Since {time}.", { time: pastTime(failed.since, now) }),
              failed?.kept != null &&
                t("Listings are from {time}.", { time: pastTime(failed.kept, now) }),
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
        )}
      </div>
      {guide && guide.listed > 0 && (
        <Row
          label={t("Mapped channels")}
          note={[
            t("{count} by hand", { count: guide.mapped }),
            guide.unresolved > 0 && t("{count} unresolved", { count: guide.unresolved }),
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <Button size="sm" aria-label={t("Map channels of {name}", { name })} onClick={onMap}>
            {t("Map")}
          </Button>
        </Row>
      )}
    </>
  );
}

/** "25 own · 9 United Kingdom · 3 without": where its channels' programmes come from. */
function supplied(guide: GuideStatus, sources: readonly GuideSourceStatus[]): string {
  if (guide.availability === "unknown" && guide.supplied.length === 0) return t("not loaded yet");
  const without = Math.max(0, guide.listed - guide.channels);
  return [
    guide.availability === "none" && t("none in this playlist"),
    ...guide.supplied.map(({ source, channels }) =>
      source
        ? t("{count} {host}", { count: channels, host: guideName(source, sources) })
        : t("{count} own", { count: channels }),
    ),
    guide.listed > 0 && t("{count} without", { count: without }),
  ]
    .filter(Boolean)
    .join(" · ");
}
