// Updates, in Settings > Updates: the version and where its update stands, with the one action
// it needs, then the channel, and the offered release's notes. The top bar's notice and these
// rows share the updates service's state, so an action in either shows in both. A copy the
// Microsoft Store installed gets one row instead, which opens the Store.
import type { CheckFailure, UpdateStatus } from "@mrstreamer/contracts/updates";
import type { Channel } from "@mrstreamer/contracts/version";
import { formatDate, formatPercent, t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { SaveFeedback } from "../settings/SaveFeedback.tsx";
import { Row, Section, Select } from "../settings/Rows.tsx";
import { noteItems } from "./notes.ts";
import { useUpdates } from "./use-updates.ts";

const RELEASES_URL = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases";

const time = (at: number) => formatDate(at, "time");

/** Why a check found nothing, in a few words. */
function describeCheckFailure(failure: CheckFailure): string {
  switch (failure.kind) {
    case "offline":
      return t("You seem to be offline.");
    case "busy":
      return failure.until
        ? t("GitHub is limiting requests until {time}.", { time: time(failure.until) })
        : t("GitHub is limiting requests for now.");
    case "http":
      return t("The update server answered HTTP {status}.", { status: String(failure.status) });
    case "invalid":
      return t("The update server sent something unexpected.");
  }
}

export function UpdatesSection() {
  const { status, statusRead, setChannel, channelChange, openStore } = useUpdates();
  if (!status)
    return (
      <Section title={t("Updates")}>
        <p>{statusRead.isPending ? t("Loading…") : t("Settings could not be read.")}</p>
        <SaveFeedback
          pending={false}
          error={statusRead.error}
          retry={() => void statusRead.refetch()}
        />
      </Section>
    );
  const channels: readonly { value: Channel; label: string }[] = [
    { value: "stable", label: t("Stable") },
    { value: "nightly", label: t("Nightly") },
  ];
  // The Microsoft Store updates a copy it installed, and carries one release line.
  if (status.distribution === "store") {
    return (
      <Section title={t("Updates")}>
        <Row id="update-check" label={status.version} note={t("updated by the Microsoft Store")}>
          <Button size="sm" onClick={openStore}>
            {t("Open Store")}
          </Button>
        </Row>
      </Section>
    );
  }
  return (
    <Section title={t("Updates")}>
      <State status={status} />
      <Row
        id="update-channel"
        label={t("Channel")}
        note={status.channel === "nightly" ? t("newest builds") : t("tested releases")}
      >
        <Select
          label={t("Channel")}
          busy={channelChange.isPending}
          value={status.channel}
          options={channels}
          onChange={setChannel}
        />
      </Row>
      <SaveFeedback
        pending={channelChange.isPending}
        error={channelChange.error}
        retry={() => setChannel(channelChange.variables!)}
      />
      <Notes status={status} />
    </Section>
  );
}

/** The version, where its update stands, and the one action that needs. */
function State({ status }: { status: UpdateStatus }) {
  const { check, download, cancel, restart, actionState } = useUpdates();
  const { update, version, checked, nextCheckAt, offer } = status;
  let note: string;
  switch (update.kind) {
    case "idle":
      note = nextCheckAt
        ? t("checks at {time}", { time: time(nextCheckAt) })
        : t("not checked yet");
      break;
    case "checking":
      note = t("checking…");
      break;
    case "current":
      note = checked
        ? t("up to date, checked {time}", { time: time(checked.at) })
        : t("up to date");
      break;
    case "available":
      note = t("{version} is available", { version: update.version });
      break;
    case "downloading":
      note = t("downloading {version}, {percent}", {
        version: update.version,
        percent: formatPercent(update.percent / 100),
      });
      break;
    case "ready":
      note = t("{version} is ready; playback stops for a moment while it restarts", {
        version: update.version,
      });
      break;
    case "failed":
      note =
        update.step === "check"
          ? t("couldn't check")
          : update.step === "download"
            ? t("the download of {version} stopped", { version: update.version })
            : t("{version} couldn't be installed", { version: update.version });
      break;
  }
  const failure =
    update.kind === "failed"
      ? update.step === "check"
        ? describeCheckFailure(update.failure)
        : update.detail
      : null;
  // An automatic check that failed keeps the last result on screen, and says so quietly.
  const quietFailure =
    checked?.failure && update.kind !== "failed" && update.kind !== "checking"
      ? [
          t("The last check failed at {time}: {reason}", {
            time: time(checked.at),
            reason: describeCheckFailure(checked.failure),
          }),
          ...(nextCheckAt ? [t("Trying again at {time}.", { time: time(nextCheckAt) })] : []),
        ].join(" ")
      : null;
  const busy = update.kind === "downloading" || update.kind === "ready";
  const offered = update.kind === "available" || update.kind === "failed" || busy;
  return (
    <>
      <Row id="update-check" label={version} note={note}>
        {offered && (
          <Button
            variant="ghost"
            size="sm"
            render={<a href={offer?.page ?? RELEASES_URL} target="_blank" rel="noreferrer" />}
          >
            GitHub ›
          </Button>
        )}
        {update.kind === "available" && (
          <Button variant="primary" size="sm" onClick={download}>
            {t("Download")}
          </Button>
        )}
        {update.kind === "downloading" && (
          <Button size="sm" onClick={cancel}>
            {t("Cancel")}
          </Button>
        )}
        {update.kind === "ready" && (
          <Button variant="primary" size="sm" onClick={restart}>
            {t("Restart to update")}
          </Button>
        )}
        {update.kind === "failed" && update.step !== "check" && (
          <Button variant="primary" size="sm" onClick={download}>
            {t("Try again")}
          </Button>
        )}
        {/* Checking stays at hand beside an offer: a newer release may be out since. */}
        {!busy && (
          <Button
            variant={update.kind === "available" ? "ghost" : "secondary"}
            size="sm"
            disabled={update.kind === "checking"}
            onClick={check}
          >
            {update.kind === "checking" ? t("Checking…") : t("Check now")}
          </Button>
        )}
      </Row>
      {update.kind === "downloading" && (
        <div className="h-0.5 overflow-hidden bg-white/12">
          <div className="h-full bg-white" style={{ width: `${update.percent}%` }} />
        </div>
      )}
      <SaveFeedback
        pending={false}
        error={actionState.error}
        retry={() => actionState.mutate(actionState.variables!)}
      />
      {failure && <p className="mt-2 text-sm text-destructive">{failure}</p>}
      {quietFailure && (
        <p className="mt-2 text-[0.8125rem] text-muted-foreground">{quietFailure}</p>
      )}
    </>
  );
}

/** What's new in the offered release, each change linked to its pull request. */
function Notes({ status }: { status: UpdateStatus }) {
  const { offer } = status;
  const items = noteItems(offer?.notes ?? null);
  if (!offer || items.length === 0) return null;
  return (
    <div className="mt-5">
      <h3 className="text-[0.9375rem] font-medium">
        {t("What's new in {version}", { version: offer.version })}
      </h3>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[0.9375rem] text-foreground/85">
        {items.map((item) => (
          <li key={item.text}>
            {item.text}
            {item.url && (
              <>
                {" "}
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground underline-offset-4 hover:text-white hover:underline"
                >
                  {item.label}
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
