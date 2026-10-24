// Explicit group mapping over Settings. Pages and samples contain names and reasons, never links.
import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PlaylistMode, PlaylistOmissionReason } from "@mrstreamer/contracts/playlist";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { formatNumber, type PlainKey, t } from "@mrstreamer/core/i18n";
import { Sheet } from "../../components/Sheet.tsx";
import { Button } from "../../components/ui/button.tsx";
import { SearchField } from "../../components/ui/search-field.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { queries, subscriptionName } from "../../lib/queries.ts";
import { useDebounced } from "../../lib/use-debounced.ts";
import { cn } from "../../lib/utils.ts";
import { Row } from "./Rows.tsx";

const PAGE = 50;
const MODES = [
  { mode: "live", label: "Live TV" },
  { mode: "movie", label: "Movies" },
  { mode: "series", label: "Series" },
  { mode: "skip", label: "Skip" },
] as const satisfies readonly { mode: PlaylistMode; label: PlainKey }[];

/** Why an entry stays out of the lists. */
const OMISSIONS = {
  unmapped: "Group needs mapping",
  "conflicting-groups": "Groups have different mappings",
  "unsupported-address": "Unsupported stream address",
  "missing-name": "No title name",
  "invalid-episode": "No unambiguous episode number",
  skip: "Skipped by mapping",
} as const satisfies Record<PlaylistOmissionReason, PlainKey>;

export function PlaylistMap({
  subscription,
  onClose,
}: {
  subscription: SubscriptionSummary;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [text, setText] = useState("");
  const query = useDebounced(text.trim(), 120);
  const [paging, setPaging] = useState({ query: "", offset: 0 });
  const offset = paging.query === query ? paging.offset : 0;
  const groups = useQuery(queries.playlistGroups(subscription.id, query, offset, PAGE));
  const [selected, setSelected] = useState<string | null>(null);
  const picked =
    groups.data?.groups.find((each) => each.group === selected) ?? groups.data?.groups[0];
  const save = useMutation({
    mutationFn: ({ group, mode }: { group: string; mode: PlaylistMode }) =>
      call("playlist.map", { subscriptionId: subscription.id, group, mode }),
    onSuccess: async (fresh) => {
      client.setQueryData(queries.subscriptions().queryKey, (all) =>
        all?.map((each) => (each.id === fresh.id ? fresh : each)),
      );
      await client.invalidateQueries({ queryKey: ["playlist", subscription.id] });
    },
  });
  const failed = save.error ?? groups.error;
  return (
    <Sheet onClose={onClose} overSettings>
      <div className="flex h-full min-h-96 flex-col bg-black px-8 pt-7 pb-6 text-white">
        <Dialog.Title className="text-2xl font-semibold">{t("Map playlist groups")}</Dialog.Title>
        <p className="mt-2 text-sm">
          {subscriptionName(subscription)} · {t("Picks apply immediately")}
        </p>
        {failed && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {describeError(appError(failed))}
          </p>
        )}
        <div className="mt-6 grid min-h-0 flex-1 grid-cols-[minmax(12rem,1fr)_2fr] gap-8">
          <div className="flex min-h-0 flex-col">
            <SearchField
              aria-label={t("Search playlist groups")}
              placeholder={t("Search groups")}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="flex-none"
            />
            <div className="mt-3 flex-1 overflow-y-auto" aria-label={t("Playlist groups")}>
              {groups.data?.groups.map((group) => (
                <button
                  key={group.group}
                  onClick={() => setSelected(group.group)}
                  aria-pressed={picked?.group === group.group}
                  className={cn(
                    "flex w-full items-center justify-between gap-4 rounded-lg px-2.5 py-3 text-left text-sm",
                    picked?.group === group.group ? "bg-white/10" : "hover:bg-white/5",
                  )}
                >
                  <span className="min-w-0 truncate">{group.name}</span>
                  <span className="shrink-0">
                    {formatNumber(group.entries)} ·{" "}
                    {t(MODES.find((each) => each.mode === group.mode)?.label ?? "Unmapped")}
                  </span>
                </button>
              ))}
              {groups.isPending && <p className="py-3 text-sm">{t("Reading playlist…")}</p>}
              {groups.data?.total === 0 && <p className="py-3 text-sm">{t("No groups found.")}</p>}
            </div>
            <Pages
              offset={offset}
              total={groups.data?.total ?? 0}
              onChange={(next) => setPaging({ query, offset: next })}
            />
          </div>
          {picked && (
            <div className="min-h-0 overflow-y-auto">
              <h2 className="text-xl font-semibold">{picked.name}</h2>
              <fieldset className="mt-4 flex flex-wrap gap-2" disabled={save.isPending}>
                <legend className="sr-only">{t("Import this group as")}</legend>
                {MODES.map(({ mode, label }) => (
                  <Button
                    key={mode}
                    disabled={save.isPending}
                    aria-pressed={picked.mode === mode}
                    variant={picked.mode === mode ? "primary" : "ghost"}
                    onClick={() => save.mutate({ group: picked.group, mode })}
                  >
                    {t(label)}
                  </Button>
                ))}
              </fieldset>
              <p className="mt-4 text-sm">
                {t(
                  "New groups wait for mapping. Entries in groups with different mappings stay out.",
                )}
              </p>
              <h3 className="mt-7 text-sm font-semibold">{t("Sample entries")}</h3>
              <ul className="mt-2">
                {picked.samples.map((sample, index) => (
                  <li key={index} className="border-b border-white/10 py-3 text-sm">
                    <p className="break-words">{sample.name}</p>
                    {sample.reason && <p className="mt-1">{t(OMISSIONS[sample.reason])}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** Status and full omissions are confined to the expanded Settings row. */
export function PlaylistRows({
  subscription,
  onMap,
}: {
  subscription: SubscriptionSummary;
  onMap: () => void;
}) {
  const groups = useQuery({
    ...queries.playlistGroups(subscription.id, "", 0, 1),
    enabled: !subscription.needsSecret,
  });
  const [show, setShow] = useState(false);
  const [offset, setOffset] = useState(0);
  const omissions = useQuery({
    ...queries.playlistOmissions(subscription.id, offset, PAGE),
    enabled: show && !subscription.needsSecret,
  });
  const total = omissions.data?.total;
  useEffect(() => {
    if (total !== undefined)
      setOffset((current) => Math.min(current, Math.max(0, Math.floor((total - 1) / PAGE) * PAGE)));
  }, [total]);
  const status = groups.data?.status;
  return (
    <>
      <Row label={t("Groups")}>
        <span>{status ? formatNumber(status.groups) : "…"}</span>
        <Button variant="ghost" size="sm" disabled={subscription.needsSecret} onClick={onMap}>
          {t("Map")}
        </Button>
      </Row>
      <Row label={t("Movies")}>{status ? formatNumber(status.movies) : "…"}</Row>
      <Row label={t("Series")}>{status ? formatNumber(status.series) : "…"}</Row>
      <Row label={t("Left out")}>
        <span>{status ? formatNumber(status.omitted) : "…"}</span>
        {!!status?.omitted && (
          <Button variant="ghost" size="sm" onClick={() => setShow((now) => !now)}>
            {show ? t("Hide") : t("Show")}
          </Button>
        )}
      </Row>
      {groups.error && (
        <p role="alert" className="text-sm text-destructive">
          {describeError(appError(groups.error))}
        </p>
      )}
      {show && (
        <div className="mt-2 max-h-80 overflow-y-auto" aria-label={t("Left-out playlist entries")}>
          {omissions.error && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(appError(omissions.error))}
            </p>
          )}
          <ul>
            {omissions.data?.entries.map((entry, index) => (
              <li key={index} className="border-b border-white/10 py-2 text-sm">
                <p className="break-words">{entry.name}</p>
                <p>
                  {entry.groups.map((group) => group || t("Ungrouped")).join(" · ")} ·{" "}
                  {t(OMISSIONS[entry.reason])}
                </p>
              </li>
            ))}
          </ul>
          <Pages offset={offset} total={omissions.data?.total ?? 0} onChange={setOffset} />
        </div>
      )}
    </>
  );
}

function Pages({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="mt-3 flex items-center gap-3 text-sm">
      <Button
        variant="ghost"
        size="sm"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - PAGE))}
      >
        {t("Previous")}
      </Button>
      <span>
        {total
          ? t("{first}–{last} of {total}", {
              first: offset + 1,
              last: Math.min(offset + PAGE, total),
              total,
            })
          : t("{count} entries", { count: 0 })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={offset + PAGE >= total}
        onClick={() => onChange(offset + PAGE)}
      >
        {t("Next")}
      </Button>
    </div>
  );
}
