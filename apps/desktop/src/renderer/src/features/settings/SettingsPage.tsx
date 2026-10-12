import { useEffect, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { type PlainKey, t } from "@mrstreamer/core/i18n";
import { isTyping } from "../../app/platform.ts";
import { useUi, type SettingsTab } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { cn } from "../../lib/utils.ts";
import { call } from "../../lib/ipc.ts";
import { Message } from "../../lib/message.tsx";
import tmdbLogo from "../../assets/tmdb.svg";
import { CustomizeHome } from "../home/CustomizeHome.tsx";
import { GeneralSection } from "./GeneralSection.tsx";
import { DiagnosticsExport } from "./DiagnosticsExport.tsx";
import { Licences } from "./Licences.tsx";
import { SubscriptionSection } from "./SubscriptionSection.tsx";
import { useUpdates } from "../updates/use-updates.ts";

const TABS = [
  { value: "general", label: "General" },
  { value: "home", label: "Home" },
  { value: "subscriptions", label: "Subscriptions" },
  { value: "about", label: "About" },
] as const satisfies readonly { value: SettingsTab; label: PlainKey }[];

const REPOSITORY_URL = "https://github.com/Mr-Streamer-OSS/MrStreamer";
const PRIVACY_URL = "https://mrstreamer.app/privacy";

/**
 * Settings, a page over the current view, so a channel keeps playing underneath. Opens with ⌘,
 * or Ctrl , on the tab its opener asks for. Back in the top bar, or Escape, returns to the view;
 * a dialog over the page closes first.
 */
export function SettingsPage() {
  const tab = useUi((state) => state.settings);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A dialog or popup over the page closes itself first.
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      const current = useUi.getState().settings;
      // Text fields keep Escape; a row checkbox has no edit to undo.
      const editing =
        isTyping(event) &&
        !(event.target instanceof HTMLInputElement && event.target.type === "checkbox");
      if (!current || (editing && current !== "licences")) return;
      // The licences go back to About, the rest to the view underneath.
      useUi.setState({ settings: current === "licences" ? "about" : null });
      // Handled: the view underneath must not take the same Escape.
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!tab) return null;
  const shownTab = tab === "licences" ? "about" : tab;
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black">
      <WindowBar className="bg-black" />
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 flex-none border-r border-border px-4 pt-4">
          <h1 className="mb-4 truncate px-3 text-2xl font-semibold tracking-tight">
            {t("Settings")}
          </h1>
          {TABS.map((entry) => (
            <button
              key={entry.value}
              aria-current={entry.value === shownTab ? "page" : undefined}
              onClick={() => useUi.setState({ settings: entry.value })}
              className={cn(
                "mb-0.5 block w-full truncate rounded-lg px-3 py-2 text-left text-[0.9375rem] transition-colors",
                entry.value === shownTab
                  ? "bg-white/10 text-white"
                  : "text-muted-foreground hover:bg-white/5 hover:text-white",
              )}
            >
              {t(entry.label)}
            </button>
          ))}
        </nav>
        {tab === "licences" ? (
          <Licences />
        ) : (
          <main className="min-w-0 flex-1 overflow-y-auto px-10 pt-6 pb-10">
            <div className="max-w-[40rem]">
              {tab === "general" && <GeneralSection />}
              {tab === "home" && <CustomizeHome />}
              {tab === "subscriptions" && <SubscriptionSection />}
              {tab === "about" && <About />}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}

/**
 * The installed version, where the project lives, the commit the build comes from, its licences,
 * the privacy policy, local diagnostics and how to report a bug or rate a Store copy.
 */
function About() {
  const { status } = useUpdates();
  const rating = useMutation({ mutationFn: () => call("updates.rateStore") });
  const rows: [string, ReactNode][] = [
    [
      t("Version"),
      status
        ? [
            status.version,
            status.channel === "nightly" ? t("Nightly") : t("Stable"),
            ...(status.distribution === "store" ? ["Microsoft Store"] : []),
          ].join(" · ")
        : "",
    ],
    [t("Website"), <Link href="https://mrstreamer.app">mrstreamer.app</Link>],
    [
      t("Source"),
      <>
        <Link href={REPOSITORY_URL}>GitHub</Link>
        {__BUILD_COMMIT__ && (
          <>
            {" · "}
            <Link href={`${REPOSITORY_URL}/tree/${__BUILD_COMMIT__}`}>
              {__BUILD_COMMIT__.slice(0, 7)}
            </Link>
          </>
        )}
        {" · GPL-3.0"}
      </>,
    ],
    [
      t("Licences"),
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => useUi.setState({ settings: "licences" })}
        className="underline underline-offset-4"
      >
        {t("Open-source licences")}
      </button>,
    ],
    [t("Privacy"), <Link href={PRIVACY_URL}>mrstreamer.app/privacy</Link>],
  ];
  return (
    <section>
      <Rows rows={rows} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          render={
            <a href={`${REPOSITORY_URL}/issues/new/choose`} target="_blank" rel="noreferrer" />
          }
        >
          {t("Report a bug")}
        </Button>
        <DiagnosticsExport />
        {status?.distribution === "store" && (
          <Button variant="secondary" disabled={rating.isPending} onClick={() => rating.mutate()}>
            {t("Rate in the Microsoft Store")}
          </Button>
        )}
      </div>
      {rating.isError && (
        <p role="alert" className="mt-2 text-sm">
          {t("The Microsoft Store could not be opened.")}
        </p>
      )}
      {/* TMDB's terms ask for its logo and this notice; JustWatch supplies the streaming data. */}
      <div className="mt-12 text-[0.8125rem] text-muted-foreground">
        <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" aria-label="TMDB">
          <img src={tmdbLogo} alt="TMDB" className="mb-3 h-3.5" />
        </a>
        <p>
          {t(
            "This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.",
          )}{" "}
          <Message
            text="Where titles stream comes from {justWatch}."
            values={{ justWatch: <Link href="https://www.justwatch.com">JustWatch</Link> }}
          />
        </p>
      </div>
    </section>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
      {children}
    </a>
  );
}

function Rows({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="mb-8 space-y-3.5 text-[0.9375rem]">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-4">
          <dt className="w-28 flex-none truncate text-muted-foreground">{label}</dt>
          <dd className="m-0 min-w-0 truncate">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
