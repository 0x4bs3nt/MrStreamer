// Settings > Subscriptions: every saved subscription as a row, in the order added, with how its
// account stands. Everything they list shows together in the app, so a row is inspected here,
// never chosen: opening one shows its account and what was loaded from it, each list with its own
// refresh, and changes nothing outside Settings. Add, Edit, the field that asks for a password or
// link the keychain lost, and Remove's question are forms in the list, one at a time. What a form
// sent to the main process can't be called back: until it is answered its Cancel, or Remove's
// Keep, is not offered, and the rest of the list stays in reach. Where a subscription's
// programmes come from shows in its details (./GuideSource.tsx), the XMLTV guides every
// subscription reads after its own being Settings > Guides' (./GuidesSection.tsx); its channels
// are mapped to its guides' by hand in a sheet over the list (./GuideMap.tsx).
//   A server shows, with a note when the login travels over plain http; a password never does,
// nor a playlist's link beyond its host.
import { Checkbox } from "@base-ui/react/checkbox";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, RotateCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { GuideStatus } from "@mrstreamer/contracts/guide";
import type { CatalogueStatus } from "@mrstreamer/contracts/library";
import type { TitleListsStatus } from "@mrstreamer/contracts/ondemand";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { formatDate, formatList, formatNumber, type PlainKey, t } from "@mrstreamer/core/i18n";
import { resetForAccount, useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { clockTime, hostOf } from "../../lib/format.ts";
import { useDownloads } from "../../lib/downloads.ts";
import { call } from "../../lib/ipc.ts";
import { queries, subscriptionName, useSubscriptions } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { player, usePlayer } from "../../player/player.ts";
import { titlePlayer, useTitlePlayer } from "../../player/title-player.ts";
import { Field, LoginForm } from "../connect/LoginForm.tsx";
import { PlaylistMap, PlaylistRows } from "./PlaylistMap.tsx";
import { GuideMap } from "./GuideMap.tsx";
import { GuideRows } from "./GuideSource.tsx";
import { Row, RowForm } from "./Rows.tsx";

const DAY_MS = 24 * 60 * 60 * 1000;
/** An account that ends within this many days says how many are left, in place of the date. */
const SOON_DAYS = 30;

/** A form under a subscription's row. */
type RowFormKind = "edit" | "secret" | "remove";

/** The one form open in the list: a row's, or the one that adds a subscription. */
type Form = { readonly kind: "add" } | { readonly kind: RowFormKind; readonly id: string };

export function SubscriptionSection() {
  const client = useQueryClient();
  const subscriptions = useSubscriptions();
  const active = useUi((state) => state.settings === "subscriptions");
  // The connections in use change all the time: ask when the tab opens. Offline, the last
  // answer stays.
  useEffect(() => {
    if (!active) return;
    for (const { id } of client.getQueryData(queries.subscriptions().queryKey) ?? []) {
      void call("subscription.recheck", { subscriptionId: id }).then(
        (fresh) => keep(client, fresh),
        () => {},
      );
    }
  }, [client, active]);

  /** The row whose details show; undefined until the viewer opened or closed one. */
  const [opened, setOpened] = useState<string | null | undefined>(undefined);
  const [form, setForm] = useState<Form | null>(null);
  /** The subscription whose channels are being mapped to its guide's, in a sheet over the list. */
  const [playlistMapping, setPlaylistMapping] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string | null>(null);
  /**
   * Closes the form open now, as it asks to when it is done. The main process can answer a form
   * the viewer left meanwhile: that closes no form opened since, with what was typed in it.
   */
  const closeForm = () => setForm((now) => (now === form ? null : now));
  // A single subscription shows its details at once, as the tab always did, also once the others
  // were removed, until the viewer closes them.
  const [only] = subscriptions;
  const expanded =
    only && subscriptions.length === 1 ? (opened === null ? null : only.id) : (opened ?? null);

  // Opened on one subscription, as from a message that it needs its password again.
  const target = useUi((state) => state.subscription);
  useEffect(() => {
    if (!target) return;
    useUi.setState({ subscription: null });
    if (target.show === "details") {
      setForm(null);
      setOpened(target.id);
    } else setForm({ kind: target.show, id: target.id });
  }, [target]);

  const playing = usePlaying();
  const channels = useQuery(queries.libraryStatus()).data;
  const guides = useQuery(queries.guideStatus()).data;
  const titles = useQuery(queries.onDemandStatus()).data;
  const mapped = subscriptions.find((each) => each.id === mapping);
  const mappedGuide = guides?.find((each) => each.subscriptionId === mapping);

  return (
    <section>
      <ul>
        {subscriptions.map((subscription) => {
          const { id } = subscription;
          const mine = form && form.kind !== "add" && form.id === id ? form.kind : null;
          return (
            <SubscriptionRow
              key={id}
              subscription={subscription}
              others={subscriptions.filter((each) => each !== subscription)}
              playing={playing?.subscriptionId === id ? playing.name : null}
              catalogue={channels?.find((each) => each.subscriptionId === id)}
              guide={guides?.find((each) => each.subscriptionId === id)}
              titles={titles?.lists.find((each) => each.subscriptionId === id)}
              expanded={expanded === id && mine === null}
              form={mine}
              onToggle={() => {
                setForm(null);
                setOpened(expanded === id && mine === null ? null : id);
              }}
              onForm={(kind) => (kind ? setForm({ kind, id }) : closeForm())}
              onAdd={() => setForm({ kind: "add" })}
              onMap={() => setMapping(id)}
              onPlaylistMap={() => setPlaylistMapping(id)}
            />
          );
        })}
      </ul>
      {subscriptions
        .filter((each) => each.id === playlistMapping && each.kind === "m3u")
        .map((subscription) => (
          <PlaylistMap
            key={subscription.id}
            subscription={subscription}
            onClose={() => setPlaylistMapping(null)}
          />
        ))}
      {/* Gone with its subscription. */}
      {mapped && mappedGuide && (
        <GuideMap subscription={mapped} guide={mappedGuide} onClose={() => setMapping(null)} />
      )}
      {form?.kind === "add" ? (
        <div className="mt-8">
          <h2 className="mb-6 text-2xl font-semibold tracking-tight">{t("Add subscription")}</h2>
          <LoginForm
            beside
            submit={{ idle: t("Add"), pending: t("Checking…") }}
            onAdded={async (added) => {
              keep(client, added);
              closeForm();
              // Its lists join the others' as they arrive; what plays goes on.
              await client.invalidateQueries();
            }}
            onCancel={() => setForm(null)}
          />
        </div>
      ) : (
        <>
          <Button className="mt-4" onClick={() => setForm({ kind: "add" })}>
            {t("Add subscription")}
          </Button>
          <p className="mt-6 text-xs leading-relaxed text-muted-foreground/80">
            {t(
              "Everything from these subscriptions shows together in Home, Live TV, Movies and Series. One stream plays at a time.",
            )}
          </p>
        </>
      )}
    </section>
  );
}

/** Puts a subscription's latest summary among the saved ones, in its place or after the last. */
function keep(client: ReturnType<typeof useQueryClient>, fresh: SubscriptionSummary): void {
  client.setQueryData(queries.subscriptions().queryKey, (saved) =>
    !saved
      ? saved
      : saved.some((each) => each.id === fresh.id)
        ? saved.map((each) => (each.id === fresh.id ? fresh : each))
        : [...saved, fresh],
  );
}

/** Each subscription's status as it was, with `fresh` in place of the one it is of. */
function replaced<S extends { readonly subscriptionId: string }>(
  all: readonly S[] | undefined,
  fresh: S,
): readonly S[] | undefined {
  return all?.map((each) => (each.subscriptionId === fresh.subscriptionId ? fresh : each));
}

/** What plays now, here or on a receiver, and from which subscription; null while nothing does. */
function usePlaying(): { readonly subscriptionId: string; readonly name: string } | null {
  const title = useTitlePlayer((state) => state.now);
  const channel = usePlayer((state) =>
    state.phase.kind === "idle" || state.phase.kind === "failed" ? null : state.channel,
  );
  // A copy plays from this computer, of no subscription.
  if (title?.kind === "provider")
    return { subscriptionId: title.title.subscriptionId, name: title.name };
  return channel && { subscriptionId: channel.subscriptionId, name: channel.title };
}

function SubscriptionRow({
  subscription,
  others,
  playing,
  catalogue,
  guide,
  titles,
  expanded,
  form,
  onToggle,
  onForm,
  onAdd,
  onMap,
  onPlaylistMap,
}: {
  subscription: SubscriptionSummary;
  /** The other saved subscriptions, which stay when this one goes. */
  others: readonly SubscriptionSummary[];
  /** What plays from it, by name; null when nothing does. */
  playing: string | null;
  catalogue: CatalogueStatus | undefined;
  guide: GuideStatus | undefined;
  titles: TitleListsStatus | undefined;
  expanded: boolean;
  /** This row's form, when it is the one open. */
  form: RowFormKind | null;
  onToggle: () => void;
  onForm: (form: RowFormKind | null) => void;
  /** Opens the form that adds a subscription. */
  onAdd: () => void;
  /** Opens the sheet that maps its channels to its guide's. */
  onMap: () => void;
  onPlaylistMap: () => void;
}) {
  const client = useQueryClient();
  const { id, kind, account, needsSecret } = subscription;
  const name = subscriptionName(subscription);
  const playlist = kind === "m3u";
  const rowId = useId();
  // The form that asks for its password or link has its Cancel here on the row, which waits
  // while a change to the subscription is on its way.
  const saving = useIsMutating({ mutationKey: updateKey(id) }) > 0;
  const retry = useMutation({
    mutationFn: () => call("library.refresh", { subscriptionId: id }),
    onSuccess: (status) =>
      client.setQueryData(queries.libraryStatus().queryKey, (all) => replaced(all, status)),
  });
  const failure = retry.error ? appError(retry.error) : (catalogue?.failure ?? null);
  // A lost password or link says so on the row, and is asked for where it is repaired.
  const failed = failure !== null && failure.kind !== "needs-secret" && !needsSecret;
  const note = [
    kind === "m3u" ? "M3U" : "Xtream",
    needsSecret
      ? playlist
        ? t("needs its link again")
        : t("needs its password again")
      : account.state !== "active" && account.state !== "unknown"
        ? stateName(account.state)
        : ending(account.expiresAt),
    playing && t("playing {name}", { name: playing }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <div
        className={cn(
          "flex min-h-13 items-center gap-6 py-2 text-[0.9375rem]",
          !expanded && "border-b border-white/8",
        )}
      >
        <button
          id={rowId}
          aria-expanded={expanded}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn("size-4 flex-none text-muted-foreground", expanded && "rotate-90")}
          />
          <span className="truncate">
            {name}
            <span className="text-muted-foreground"> · {note}</span>
          </span>
        </button>
        <div className="flex flex-none items-center gap-2">
          {form === "secret" ? (
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => onForm(null)}>
              {t("Cancel")}
            </Button>
          ) : (
            <>
              {failed && (
                <Button
                  size="sm"
                  aria-label={t("Retry {name}", { name })}
                  disabled={retry.isPending}
                  onClick={() => retry.mutate()}
                >
                  {retry.isPending ? t("Retrying…") : t("Retry")}
                </Button>
              )}
              {needsSecret && (
                <Button
                  size="sm"
                  aria-label={
                    playlist
                      ? t("Enter the link for {name}", { name })
                      : t("Enter the password for {name}", { name })
                  }
                  onClick={() => onForm("secret")}
                >
                  {playlist ? t("Enter link") : t("Enter password")}
                </Button>
              )}
              <Button
                variant={failed || needsSecret ? "ghost" : "secondary"}
                size="sm"
                aria-label={t("Edit {name}", { name })}
                onClick={() => onForm("edit")}
              >
                {t("Edit")}
              </Button>
            </>
          )}
        </div>
      </div>
      <div aria-live="polite">
        {failed && (
          <p className="mt-1 mb-2 text-sm text-destructive">
            {unanswered(subscription, failure, catalogue)}
          </p>
        )}
      </div>
      {form === "secret" && <Secret subscription={subscription} onDone={() => onForm(null)} />}
      {form === "edit" && (
        <Edit
          subscription={subscription}
          onDone={() => onForm(null)}
          onRemove={() => onForm("remove")}
          onAdd={onAdd}
        />
      )}
      {form === "remove" && (
        <Remove
          subscription={subscription}
          others={others}
          playing={playing}
          onKeep={() => onForm(null)}
        />
      )}
      {expanded && (
        <div
          role="region"
          aria-labelledby={rowId}
          className="mb-2 ml-5 border-b border-white/8 pt-1 pb-4"
        >
          <Details
            subscription={subscription}
            catalogue={catalogue}
            guide={guide}
            titles={titles}
            onMap={onMap}
            onPlaylistMap={onPlaylistMap}
          />
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onForm("remove")}
            className="mt-3 text-[0.9375rem] text-muted-foreground hover:text-white"
          >
            {t("Remove {name}", { name })}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Why a subscription's lists couldn't be fetched: for a provider that doesn't answer, since when,
 * and that what shows of it is from then.
 */
function unanswered(
  subscription: SubscriptionSummary,
  failure: AppError,
  catalogue: CatalogueStatus | undefined,
): string {
  if (failure.kind !== "unreachable" || !catalogue?.failedAt) return describeError(failure);
  const since = t("{host} hasn't answered since {time}.", {
    host: hostOf(subscription.server),
    time: clockTime(catalogue.failedAt, Date.now()),
  });
  return catalogue.fetchedAt === null ? since : `${since} ${t("Its lists are from then.")}`;
}

/**
 * A subscription's account as its provider says it stands, its login, and what was loaded from
 * it, each list refreshed on its own. A playlist has a guide of its own
 * only when its first line names one: without, the row says so, and its refresh reads that line
 * again.
 */
function Details({
  subscription,
  catalogue,
  guide,
  titles,
  onMap,
  onPlaylistMap,
}: {
  subscription: SubscriptionSummary;
  catalogue: CatalogueStatus | undefined;
  guide: GuideStatus | undefined;
  titles: TitleListsStatus | undefined;
  onMap: () => void;
  onPlaylistMap: () => void;
}) {
  const client = useQueryClient();
  const { id: subscriptionId, kind, account, server, needsSecret } = subscription;
  // New channels or new lists reach every view through `library.updated` and
  // `ondemand.updated`; the row shows what the refresh answered at once.
  const refreshChannels = useMutation({
    mutationFn: () => call("library.refresh", { subscriptionId }),
    onSuccess: (status) =>
      client.setQueryData(queries.libraryStatus().queryKey, (all) => replaced(all, status)),
  });
  const refreshTitles = useMutation({
    mutationFn: () => call("ondemand.refresh", { subscriptionId }),
    onSuccess: (status) => client.setQueryData(queries.onDemandStatus().queryKey, status),
  });
  return (
    <>
      <Row
        label={t("Status")}
        note={
          needsSecret
            ? kind === "m3u"
              ? t("needs your playlist link again")
              : t("needs your password again")
            : undefined
        }
      >
        {stateName(account.state)}
      </Row>
      <Row label={t("Expires")}>{expiry(account.expiresAt)}</Row>
      <Row label={t("Connections")}>{connections(account)}</Row>
      <Row
        label={t("Login")}
        note={kind === "xtream" && server.startsWith("http:") ? t("not encrypted") : undefined}
      >
        <span className="truncate">{loginOf(subscription)}</span>
      </Row>
      <List
        label={t("Channels")}
        refreshLabel={t("Refresh channels")}
        count={catalogue?.channelCount ?? 0}
        fetchedAt={catalogue?.fetchedAt ?? null}
        failure={
          refreshChannels.error ? appError(refreshChannels.error) : (catalogue?.failure ?? null)
        }
        refreshing={refreshChannels.isPending}
        onRefresh={() => refreshChannels.mutate()}
      />
      <GuideRows subscription={subscription} guide={guide} onMap={onMap} />
      {kind === "m3u" && <PlaylistRows subscription={subscription} onMap={onPlaylistMap} />}
      {kind === "xtream" && (
        <List
          label={t("Movies and series")}
          refreshLabel={t("Refresh movies and series")}
          count={titles ? titles.movies + titles.series : 0}
          fetchedAt={titles?.fetchedAt ?? null}
          failure={refreshTitles.error ? appError(refreshTitles.error) : (titles?.failure ?? null)}
          refreshing={refreshTitles.isPending}
          onRefresh={() => refreshTitles.mutate()}
        />
      )}
    </>
  );
}

/** "viewer01 @ panel.example", or a playlist's host alone. */
function loginOf({ username, server }: SubscriptionSummary): string {
  return username ? `${username} @ ${hostOf(server)}` : hostOf(server);
}

/** One list: how many, how long ago, why the last refresh failed, and Refresh. */
function List({
  label,
  refreshLabel,
  count,
  fetchedAt,
  failure,
  refreshing,
  onRefresh,
}: {
  label: string;
  refreshLabel: string;
  count: number;
  fetchedAt: number | null;
  failure: AppError | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <>
      <Row label={label} note={fetchedAt === null ? t("not loaded yet") : formatNumber(count)}>
        <span className="text-muted-foreground">
          {refreshing ? t("refreshing…") : fetchedAt !== null ? relativeTime(fetchedAt) : ""}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={refreshLabel}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RotateCw />
        </Button>
      </Row>
      {failure && <p className="mt-2 mb-1 text-sm text-destructive">{describeError(failure)}</p>}
    </>
  );
}

/** What a change to a subscription is saved under, by which its row tells one is on its way. */
const updateKey = (subscriptionId: string) => ["subscription.update", subscriptionId];

/**
 * Saves a change to a subscription, and keeps what the main process answers among the saved
 * ones. A new password or link is checked with the provider first.
 */
function useUpdate(subscriptionId: string, onDone: () => void) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: updateKey(subscriptionId),
    mutationFn: (change: { name?: string | null; secret?: string }) =>
      call("subscription.update", { subscriptionId, ...change }),
    onSuccess: async (fresh, change) => {
      keep(client, fresh);
      onDone();
      // Its lists are fetched under the new login; what shows of them is read again.
      if (change.secret !== undefined) await client.invalidateQueries();
    },
  });
}

/**
 * A subscription's name, and its password or link when it is to change. The login shows and
 * can't be edited: another server, username or playlist is another subscription.
 */
function Edit({
  subscription,
  onDone,
  onRemove,
  onAdd,
}: {
  subscription: SubscriptionSummary;
  onDone: () => void;
  onRemove: () => void;
  onAdd: () => void;
}) {
  const [name, setName] = useState(subscription.name ?? "");
  const [secret, setSecret] = useState("");
  const update = useUpdate(subscription.id, onDone);
  const playlist = subscription.kind === "m3u";
  return (
    <RowForm
      onSubmit={() => update.mutate({ name: name.trim() || null, ...(secret ? { secret } : {}) })}
    >
      <h2 className="mb-5 text-2xl font-semibold tracking-tight">
        {subscriptionName(subscription)}
      </h2>
      <div className="space-y-4">
        <Field label={t("Name")}>
          <Input
            compact
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={hostOf(subscription.server)}
            autoFocus
          />
        </Field>
        <div className="text-sm text-muted-foreground">
          {t("Login")}
          <div className="mt-2 truncate text-base text-foreground">{loginOf(subscription)}</div>
        </div>
        <Field label={playlist ? t("M3U link") : t("Password")} hint={t("leave empty to keep")}>
          <Input
            compact
            type={playlist ? "text" : "password"}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete={playlist ? "off" : "new-password"}
          />
        </Field>
      </div>
      <p className="mt-5 text-sm text-muted-foreground">
        {t("Another server, username or playlist?")}{" "}
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onAdd}
          className="text-foreground underline underline-offset-4"
        >
          {t("Add it as a new subscription.")}
        </button>
      </p>
      {update.error && (
        <p className="mt-4 text-sm text-destructive">{describeError(appError(update.error))}</p>
      )}
      <div className="mt-6 flex items-center gap-3">
        <Button type="submit" variant="primary" size="sm" disabled={update.isPending}>
          {update.isPending ? t("Saving…") : t("Save")}
        </Button>
        <Button variant="ghost" size="sm" disabled={update.isPending} onClick={onDone}>
          {t("Cancel")}
        </Button>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onRemove}>
          {t("Remove")}
        </Button>
      </div>
    </RowForm>
  );
}

/** Asks again for the password or link the keychain no longer gives back, where it is reported. */
function Secret({
  subscription,
  onDone,
}: {
  subscription: SubscriptionSummary;
  onDone: () => void;
}) {
  const [secret, setSecret] = useState("");
  const update = useUpdate(subscription.id, onDone);
  const playlist = subscription.kind === "m3u";
  return (
    <RowForm onSubmit={() => secret && update.mutate({ secret })}>
      <p className="mb-4 text-[0.9375rem]">
        {playlist
          ? t("Your keychain no longer gives Mr. Streamer the saved link from {host}.", {
              host: hostOf(subscription.server),
            })
          : t("Your keychain no longer gives Mr. Streamer the saved password.")}
      </p>
      <Field label={playlist ? t("M3U link") : t("Password")}>
        <Input
          compact
          type={playlist ? "text" : "password"}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={playlist ? "https://…" : undefined}
          autoComplete={playlist ? "off" : "current-password"}
          autoFocus
        />
      </Field>
      {update.error && (
        <p className="mt-4 text-sm text-destructive">{describeError(appError(update.error))}</p>
      )}
      <Button
        type="submit"
        variant="primary"
        size="sm"
        className="mt-5"
        disabled={update.isPending || !secret}
      >
        {update.isPending ? t("Checking…") : t("Save")}
      </Button>
    </RowForm>
  );
}

/**
 * Remove, confirmed in the list. It says what stops and what stays: a stream that plays from the
 * subscription ends, the others' content stays in every list, and removing the only one returns
 * to Connect. Favourites, the watchlist, history, progress and its channels in the viewer's lists
 * stay for when the account is added again, unless the viewer ticks the box to delete them too;
 * the lists themselves stay either way. Once Remove is pressed its stream has stopped and the
 * box's answer is sent, so the box and Keep wait for the removal to be answered. With it gone and
 * the others' lists read again, the player holds no channel of it, so the page underneath
 * previews the channel watched last among those that stay. A sheet left open under Settings for
 * a title it had saved closes too. Its unfinished downloads end with it, which the question says
 * when it has any; its downloaded copies stay.
 */
function Remove({
  subscription,
  others,
  playing,
  onKeep,
}: {
  subscription: SubscriptionSummary;
  others: readonly SubscriptionSummary[];
  playing: string | null;
  onKeep: () => void;
}) {
  const client = useQueryClient();
  const { id } = subscription;
  const [eraseViewing, setEraseViewing] = useState(false);
  const remove = useMutation({
    mutationFn: async () => {
      // What plays from it ends here first, with how far it got saved under its own account,
      // which the main process has answered before it is asked to remove the subscription.
      const now = titlePlayer.state().now;
      if (now?.kind === "provider" && now.title.subscriptionId === id) {
        titlePlayer.close();
        useUi.setState({ playingTitle: false });
        await titlePlayer.saved();
      }
      if (player.current()?.subscriptionId === id) {
        player.reset();
        useUi.setState({ watching: false, channelsOpen: false });
      }
      return call("subscription.remove", { subscriptionId: id, eraseViewing });
    },
    onSuccess: async () => {
      if (others.length === 0) {
        player.reset();
        resetForAccount();
        useUi.setState({ settings: null });
        return client.resetQueries();
      }
      // The others stay as they are: only what named this one goes.
      useUi.setState((state) => ({
        details: state.details?.subscriptionId === id ? null : state.details,
        savedEntry: state.savedEntry?.sources.includes(id) ? null : state.savedEntry,
      }));
      client.setQueryData(queries.subscriptions().queryKey, others);
      await client.resetQueries({ queryKey: ["library", "browse"] });
      onKeep();
      await client.invalidateQueries();
      // The page under Settings may have tried its channel again meanwhile, as the one watched
      // last by a record that still named it. The record read again names one that stays.
      if (player.current()?.subscriptionId === id) player.reset();
    },
    onError: () => {
      // A first read during logical removal can outlive the refusal. Invalidation reuses it
      // without cached data, so mark it stale again after settlement for the restored source.
      const underWay = client
        .getQueryCache()
        .findAll({ fetchStatus: "fetching" })
        .flatMap(({ queryKey, promise }) => (promise ? [{ queryKey, promise }] : []));
      void client.invalidateQueries();
      for (const { queryKey, promise } of underWay)
        void promise.then(
          () => client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false }),
          () => {},
        );
    },
  });
  const stays = others.map(subscriptionName);
  const unfinished =
    useDownloads().data?.items.filter(
      (item) =>
        item.subscription?.id === id &&
        item.status.kind !== "complete" &&
        item.status.kind !== "missing",
    ).length ?? 0;
  return (
    <div className="mb-2 ml-5 border-b border-white/8 pt-2 pb-6">
      <p className="mb-3 text-[0.9375rem]">
        {t("Remove {name}, and the lists loaded with it, from this device?", {
          name: subscriptionName(subscription),
        })}
      </p>
      {(playing || stays.length === 0) && (
        <p className="mb-3 text-sm text-foreground/85">
          {[
            playing && t("{name} is playing from it and stops.", { name: playing }),
            stays.length === 0
              ? t("It's your only subscription, so Mr. Streamer returns to Connect.")
              : playing && t("{names} stay.", { names: formatList(stays), count: stays.length }),
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
      {unfinished > 0 && (
        <p className="mb-3 text-sm text-foreground/85">
          {t("Its {count} unfinished downloads end. Downloaded copies stay.", {
            count: unfinished,
          })}
        </p>
      )}
      <label className="mb-4 flex w-fit items-center gap-3 text-[0.9375rem]">
        <Checkbox.Root
          checked={eraseViewing}
          onCheckedChange={setEraseViewing}
          disabled={remove.isPending}
          className="grid size-4 flex-none place-items-center rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-white data-checked:shadow-none"
        >
          <Checkbox.Indicator>
            <Check className="size-3 text-black" strokeWidth={3} />
          </Checkbox.Indicator>
        </Checkbox.Root>
        {t("Also delete favourites, watchlist, history, progress and channels in lists")}
      </label>
      <div className="flex gap-3">
        <Button
          variant="destructive"
          size="sm"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {t("Remove")}
        </Button>
        <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={onKeep}>
          {t("Keep")}
        </Button>
      </div>
      {remove.error && (
        <p className="mt-3 text-sm text-destructive">{describeError(appError(remove.error))}</p>
      )}
    </div>
  );
}

const STATE_NAMES = {
  active: "Active",
  expired: "Expired",
  banned: "Banned",
  disabled: "Disabled",
  unknown: "Unknown",
} as const satisfies Record<SubscriptionSummary["account"]["state"], PlainKey>;

function stateName(state: SubscriptionSummary["account"]["state"]): string {
  return t(STATE_NAMES[state]);
}

/** "12 Mar 2027". */
function day(iso: string): string {
  return formatDate(Date.parse(iso), "date");
}

function daysLeft(expiresAt: string): number {
  return Math.ceil((Date.parse(expiresAt) - Date.now()) / DAY_MS);
}

/** "12 Mar 2027 · 163 days", or how long ago it ended. */
function expiry(expiresAt: string | null): string {
  if (!expiresAt) return t("No end date");
  const days = daysLeft(expiresAt);
  return `${day(expiresAt)} · ${days > 0 ? t("{count} days", { count: days }) : t("ended")}`;
}

/** What a row says of when the account ends: "12 days left" once it is near, else the date. */
function ending(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const days = daysLeft(expiresAt);
  if (days <= 0) return t("ended");
  return days <= SOON_DAYS ? t("{count} days left", { count: days }) : day(expiresAt);
}

/** "1 of 2 in use", as the provider counts them, this app's own stream included. */
function connections(account: SubscriptionSummary["account"]): string {
  const { maxConnections: max, activeConnections: active } = account;
  if (max === null) return active === null ? t("Not reported") : t("{active} in use", { active });
  return t("{active} of {max} in use", { active: active ?? 0, max });
}

function relativeTime(epochMs: number): string {
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{minutes} min ago", { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("{hours} h ago", { hours });
  return formatDate(epochMs, "date");
}
