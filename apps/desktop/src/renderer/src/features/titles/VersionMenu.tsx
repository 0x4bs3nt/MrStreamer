import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import { Fragment, useState, type ReactElement, type ReactNode } from "react";
import type { Title, TitleVersion } from "@mrstreamer/contracts/ondemand";
import { ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { languageName } from "@mrstreamer/core/ondemand/tracks";
import { versionOptions, type VersionOptionGroup } from "@mrstreamer/core/ondemand/version-options";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { useSubscriptionNames, useSubscriptions } from "../../lib/queries.ts";
import { usePickVersion } from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";

const AUTOMATIC = "automatic";

/** A current file's observed languages. Series summaries explicitly describe only read episodes. */
function observedLabel(version: TitleVersion, kind: Title["kind"]): string | null {
  if (!version.observed) return null;
  const name = (code: string | null) => languageName(code) ?? t("Unknown");
  const { audio, subtitles, files } = version.observed;
  const sound = audio.length
    ? t("{language} sound", { language: [...new Set(audio.map(name))].join(", ") })
    : t("No sound");
  const captions = subtitles.length
    ? t("{language} subtitles", { language: [...new Set(subtitles.map(name))].join(", ") })
    : t("No subtitles");
  return [kind === "series" && t("Read {count} files", { count: files }), sound, captions]
    .filter(Boolean)
    .join(" · ");
}

/** Quality first, every exact file reachable, with tracks claimed only after a local file read. */
export function VersionMenu({
  title,
  picked,
  automatic,
  onPick,
  trigger,
  children,
  remember = true,
}: {
  title: Title;
  picked: OwnedId | null;
  automatic?: OwnedId;
  onPick: (version: OwnedId | null) => void;
  trigger?: ReactElement<Record<string, unknown>>;
  children: ReactNode;
  /** Episode alternatives play immediately and do not change a series version preference. */
  remember?: boolean;
}) {
  const pick = usePickVersion();
  const names = useSubscriptionNames();
  const subscriptions = useSubscriptions();
  const groups = versionOptions(
    title.versions,
    title.originalLanguage,
    subscriptions.map(({ id }) => id),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const automaticGroup = groups.find((group) =>
    group.versions.some((version) => automatic !== undefined && sameOwned(version, automatic)),
  );
  const automaticFile = title.versions.find(
    (version) => automatic !== undefined && sameOwned(version, automatic),
  );
  const describe = (group: VersionOptionGroup, version: TitleVersion) =>
    [group.quality, observedLabel(version, title.kind) ?? group.label, names(group.subscriptionId)]
      .filter(Boolean)
      .join(" · ");
  const expand = (key: string, open: boolean) =>
    setExpanded((held) => {
      const next = new Set(held);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  const item = (group: VersionOptionGroup, version: TitleVersion, ordinal?: number) => {
    const observed = observedLabel(version, title.kind);
    const metadata = [
      version.name,
      ordinal !== undefined ? t("Version {number}", { number: String(ordinal) }) : null,
      version.container?.toUpperCase(),
      version.addedAt ? formatDate(version.addedAt, "medium") : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <Menu.RadioItem
        key={ownedKey(version)}
        value={ownedKey(version)}
        closeOnClick
        className={cn(
          menuItem,
          "flex w-full items-start gap-2 px-2 py-2 text-white/70 data-checked:text-white",
          ordinal !== undefined && "pl-6",
        )}
        aria-label={[
          describe(group, version),
          metadata,
          observed ? t("Tracks read locally") : t("as listed"),
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        <span className="mt-1 grid size-1.5 flex-none">
          <Menu.RadioItemIndicator className="size-1.5 rounded-full bg-white" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-3">
            <span className="w-9 flex-none font-semibold">{group.quality}</span>
            <span className={cn("min-w-0 flex-1", observed && "text-white")}>
              {observed ?? group.label}
              {observed && (
                <Check
                  aria-hidden
                  aria-label={t("Tracks read locally")}
                  className="ml-1 inline size-3"
                />
              )}
            </span>
            <span className="flex-none text-[0.8125rem]">{names(group.subscriptionId)}</span>
          </span>
          {(metadata || group.asListed) && (
            <span className="mt-1 block break-words text-[0.75rem] text-white/50">
              {metadata}
              {group.asListed && !observed && `${metadata ? " · " : ""}${t("as listed")}`}
            </span>
          )}
        </span>
      </Menu.RadioItem>
    );
  };
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          trigger ?? (
            <Button
              variant="primary"
              size="lg"
              aria-label={t("Versions")}
              className="rounded-l-none border-l border-black/20 px-3"
            />
          )
        }
      >
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
          <Menu.Popup
            className={cn(
              menuSurface,
              "max-h-[min(60vh,var(--available-height))] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto text-[0.875rem] text-white",
            )}
          >
            <Menu.RadioGroup
              value={picked ? ownedKey(picked) : AUTOMATIC}
              onValueChange={(value: string) => {
                const chosen =
                  title.versions.find((version) => ownedKey(version) === value) ?? null;
                onPick(chosen);
                if (remember) pick(title, chosen);
              }}
            >
              {automatic && (
                <Menu.RadioItem
                  value={AUTOMATIC}
                  closeOnClick
                  className={cn(menuItem, "flex items-start gap-2 px-2 py-2")}
                >
                  <span className="mt-1 grid size-1.5 flex-none">
                    <Menu.RadioItemIndicator className="size-1.5 rounded-full bg-white" />
                  </span>
                  <span className="min-w-0 flex-1">
                    {t("Automatic")}
                    {automaticGroup && automaticFile && (
                      <span className="mt-1 block text-[0.75rem] text-white/60">
                        {describe(automaticGroup, automaticFile)}
                      </span>
                    )}
                  </span>
                </Menu.RadioItem>
              )}
              {groups.map((group) =>
                group.versions.length === 1 ? (
                  item(group, group.versions[0]!)
                ) : (
                  <Fragment key={group.key}>
                    <Menu.Item
                      closeOnClick={false}
                      aria-expanded={expanded.has(group.key)}
                      aria-label={[
                        [group.quality, group.label, t("as listed")].filter(Boolean).join(" · "),
                        t("{count} versions", { count: group.versions.length }),
                        names(group.subscriptionId),
                      ]
                        .filter(Boolean)
                        .join(", ")}
                      onClick={() => expand(group.key, !expanded.has(group.key))}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                          event.preventDefault();
                          event.stopPropagation();
                          expand(group.key, event.key === "ArrowRight");
                        }
                      }}
                      className={cn(
                        menuItem,
                        "flex w-full items-baseline gap-2 px-2 py-2 text-white/70",
                      )}
                    >
                      <span className="grid size-1.5 flex-none">
                        {picked && group.versions.some((version) => sameOwned(version, picked)) && (
                          <span className="size-1.5 rounded-full bg-white" />
                        )}
                      </span>
                      <span className="w-9 flex-none font-semibold">{group.quality}</span>
                      <span className="min-w-0 flex-1">
                        {group.label} · {t("{count} versions", { count: group.versions.length })}{" "}
                        <ChevronRight
                          aria-hidden
                          className={cn("inline size-3", expanded.has(group.key) && "rotate-90")}
                        />
                        {group.asListed && (
                          <span className="ml-1 text-[0.75rem] text-white/50">
                            {t("as listed")}
                          </span>
                        )}
                      </span>
                      <span className="flex-none text-[0.8125rem]">
                        {names(group.subscriptionId)}
                      </span>
                    </Menu.Item>
                    {expanded.has(group.key) &&
                      group.versions.map((version, index) => item(group, version, index + 1))}
                  </Fragment>
                ),
              )}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
