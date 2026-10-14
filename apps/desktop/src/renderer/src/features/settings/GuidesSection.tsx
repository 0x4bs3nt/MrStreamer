// Settings > Guides: the XMLTV guides the viewer adds, which every subscription reads after its
// own guide, in this order. Each is a row of two lines, its host and what it is doing: being
// downloaded, read, ready with what it supplies, or failing, with why and since when, its last
// good download staying in use. Up and Down change the order, the cross removes one. The field
// under the list adds one at Add: it is saved at once and downloads in the background, its row
// telling each step as `guide.updated` brings it. A move or a removal that fails says why on its
// row, and leaves the list as it was. The keyboard stays on the arrow a move pressed, or the other
// one where the row reached an end, and a removal hands it to the row that took its place, else
// the one before, else the field.
//   An address can hold a key: the field starts empty again once it is added, and nothing here
// shows more of one than its host.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { GuideProcessing, GuideSourceStatus } from "@mrstreamer/contracts/guide";
import { formatBytes, formatPercent, t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { comingTime, hostOf, pastTime } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";

/** Where the keyboard goes once the list is read again after a row's change. */
type Refocus =
  | { readonly kind: "moved"; readonly id: string; readonly by: -1 | 1 }
  | { readonly kind: "removed"; readonly at: number };

/** `element` when it is a button that can be pressed. */
const pressable = (element: Element | null | undefined) =>
  element instanceof HTMLButtonElement && !element.disabled ? element : null;

export function GuidesSection() {
  const client = useQueryClient();
  const read = useQuery(queries.guideSources()).data;
  const sources = read ?? [];
  const section = useRef<HTMLElement>(null);
  const refocus = useRef<Refocus | null>(null);
  useEffect(() => {
    const wanted = refocus.current;
    const root = section.current;
    if (!wanted || !root) return;
    refocus.current = null;
    const rows = [...root.querySelectorAll("li")];
    if (wanted.kind === "moved") {
      const row = rows.find((each) => each.dataset["source"] === wanted.id);
      const target =
        pressable(row?.querySelector(`[data-move="${wanted.by}"]`)) ??
        pressable(row?.querySelector(`[data-move="${-wanted.by}"]`));
      target?.focus();
      return;
    }
    const near = rows[wanted.at] ?? rows[wanted.at - 1];
    (pressable(near?.querySelector("[data-remove]")) ?? root.querySelector("input"))?.focus();
  }, [read]);
  const [address, setAddress] = useState("");
  const changed = () => client.invalidateQueries({ queryKey: ["guide"] });
  const add = useMutation({
    mutationFn: (typed: string) => call("guide.addSource", { address: typed }),
    // The address it was sent with isn't kept past the field: it can hold a key.
    gcTime: 0,
    onSuccess: () => {
      setAddress("");
      void changed();
    },
  });
  const typed = address.trim();
  return (
    <section ref={section}>
      <h2 className="mb-1 text-[0.9375rem] font-semibold">{t("Guides")}</h2>
      <ul className="text-[0.9375rem]">
        {sources.map((source, at) => (
          <SourceRow
            key={source.id}
            source={source}
            first={at === 0}
            last={at === sources.length - 1}
            onChange={changed}
            onMoved={(by) => {
              refocus.current = { kind: "moved", id: source.id, by };
            }}
            onRemoved={() => {
              refocus.current = { kind: "removed", at };
            }}
          />
        ))}
      </ul>
      <form
        className="mt-5 flex items-center gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (typed && !add.isPending) add.mutate(typed);
        }}
      >
        <Input
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            add.reset();
          }}
          aria-label={t("Address of an XMLTV guide")}
          placeholder={t("Address of an XMLTV guide, .xml or .xml.gz")}
          autoComplete="off"
          className="h-9 flex-1 rounded-lg px-3 text-[0.9375rem]"
        />
        <Button type="submit" size="sm" disabled={!typed || add.isPending}>
          {t("Add")}
        </Button>
      </form>
      <div aria-live="polite">
        {add.error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {describeError(appError(add.error))}
          </p>
        ) : (
          /^http:\/\//i.test(typed) && (
            <p className="mt-2 text-sm text-muted-foreground">
              {t("Not encrypted. The address, and any key in it, travels as plain text.")}
            </p>
          )
        )}
      </div>
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground/80">
        {t(
          "A subscription's own guide comes first, then these, in order. The first with programmes for a channel supplies it. Processing continues in the background.",
        )}
      </p>
    </section>
  );
}

/** A source: its host, what it is doing, and what can be done with it. */
function SourceRow({
  source,
  first,
  last,
  onChange,
  onMoved,
  onRemoved,
}: {
  source: GuideSourceStatus;
  first: boolean;
  last: boolean;
  onChange: () => Promise<void>;
  /** Before the list is read again, once a move was kept. */
  onMoved: (by: -1 | 1) => void;
  /** Before the list is read again, once the source went. */
  onRemoved: () => void;
}) {
  const { id, processing } = source;
  const host = hostOf(source.origin);
  const refresh = useMutation({
    mutationFn: () => call("guide.refreshSource", { id }),
    onSettled: onChange,
  });
  const move = useMutation({
    mutationFn: (by: -1 | 1) => call("guide.moveSource", { id, by }),
    onSuccess: (_, by) => onMoved(by),
    onSettled: onChange,
  });
  const remove = useMutation({
    mutationFn: () => call("guide.removeSource", { id }),
    onSuccess: onRemoved,
    onSettled: onChange,
  });
  // Pressed again while it is under way, an action does nothing; it isn't disabled meanwhile,
  // which would leave the keyboard on a button that can't be pressed.
  const moving = (by: -1 | 1) => {
    if (move.isPending) return;
    remove.reset();
    move.mutate(by);
  };
  const removing = () => {
    if (remove.isPending) return;
    move.reset();
    remove.mutate();
  };
  const failure = move.error ?? remove.error;
  const busy = processing.state === "downloading" || processing.state === "reading";
  const failed = processing.state === "failed" || source.locked;
  return (
    <li data-source={id} className="flex min-h-15 items-center gap-6 border-b border-white/8 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate">{host}</div>
        <div
          className={cn(
            "mt-0.5 text-[0.8125rem]",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {stateOf(source, Date.now())}
        </div>
        {failure && (
          <p role="alert" className="mt-0.5 text-[0.8125rem] text-destructive">
            {describeError(appError(failure))}
          </p>
        )}
      </div>
      <div className="flex flex-none items-center gap-2">
        {processing.state === "downloading" &&
          processing.total !== null &&
          processing.total > 0 && (
            <>
              <span className="block h-[3px] w-24 overflow-hidden rounded-full bg-white/20">
                <span
                  className="block h-full bg-white"
                  style={{
                    width: `${Math.min(100, (processing.bytes / processing.total) * 100)}%`,
                  }}
                />
              </span>
              <span className="text-muted-foreground tabular-nums">
                {formatPercent(Math.min(1, processing.bytes / processing.total))}
              </span>
            </>
          )}
        {processing.state === "failed" && !source.locked ? (
          <Button
            size="sm"
            aria-label={t("Retry {name}", { name: host })}
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {t("Retry")}
          </Button>
        ) : (
          !busy &&
          !source.locked && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Refresh {name}", { name: host })}
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RotateCw />
            </Button>
          )
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("Move {name} up", { name: host })}
          data-move={-1}
          disabled={first}
          onClick={() => moving(-1)}
        >
          <ArrowUp />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("Move {name} down", { name: host })}
          data-move={1}
          disabled={last}
          onClick={() => moving(1)}
        >
          <ArrowDown />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("Remove {name}", { name: host })}
          data-remove
          onClick={removing}
        >
          <X />
        </Button>
      </div>
    </li>
  );
}

/**
 * What a source is doing, on its second line: "Ready · 412 channels · 1,204,000 programmes · until
 * Mon 23:00 · updated 14:02", "Downloading · 46 MB of 82 MB", "Reading · 640,000 programmes so far
 * · since 14:02", "Failed since 09:14 · The address didn't answer. · programmes from yesterday
 * 14:02 stay in use".
 */
function stateOf(source: GuideSourceStatus, now: number): string {
  const { processing } = source;
  const kept = keptOf(processing);
  if (source.locked) {
    return [
      t("Needs its address again: add it once more"),
      kept !== null && t("programmes from {time} stay in use", { time: pastTime(kept, now) }),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  switch (processing.state) {
    case "downloading":
      return processing.total === null
        ? t("Downloading · {size} so far", { size: formatBytes(processing.bytes) })
        : t("Downloading · {size} of {total}", {
            size: formatBytes(processing.bytes),
            total: formatBytes(processing.total),
          });
    case "reading":
      return t("Reading · {count} programmes so far · since {time}", {
        count: processing.programmes,
        time: pastTime(processing.since, now),
      });
    case "ready":
      return [
        t("Ready"),
        t("{count} channels", { count: processing.channels }),
        t("{count} programmes", { count: processing.programmes }),
        processing.until !== null && t("until {time}", { time: comingTime(processing.until, now) }),
        t("updated {time}", { time: pastTime(processing.fetchedAt, now) }),
      ]
        .filter(Boolean)
        .join(" · ");
    case "failed":
      return [
        t("Failed since {time}", { time: pastTime(processing.since, now) }),
        // Its host answered: it is no provider's.
        processing.reason.kind === "provider-error"
          ? t("{host} answered with an error (HTTP {status}).", {
              host: hostOf(source.origin),
              status: String(processing.reason.status),
            })
          : describeError(processing.reason),
        kept !== null && t("programmes from {time} stay in use", { time: pastTime(kept, now) }),
      ]
        .filter(Boolean)
        .join(" · ");
    case "empty":
      return t("Not downloaded yet");
  }
}

/** When the download in use arrived, where the state says. */
function keptOf(processing: GuideProcessing): number | null {
  return processing.state === "ready"
    ? processing.fetchedAt
    : processing.state === "failed"
      ? processing.kept
      : null;
}
