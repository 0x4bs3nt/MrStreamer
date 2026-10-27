// The update feed: updates.json at the root of the project's GitHub Pages site, naming the newest
// release on each channel. The release workflow writes it after every release with
// `scripts/release-plan.ts feed`; the app reads it to find updates and downloads them from GitHub
// Releases, and the website reads it to link the newest stable installers.
// docs/maintainers/releasing.md describes the policy.
//
// Release jobs run this with plain node before installing packages, so it imports only
// ./version.ts and ./release-files.ts, by relative path.
import { UPDATE_METADATA } from "./release-files.ts";
import {
  channelOf,
  compareVersions,
  formatVersion,
  parseVersion,
  type Channel,
  type Version,
} from "./version.ts";

/** The update metadata electron-builder writes for macOS, Windows and Linux. */
const PLATFORM_FILES = Object.values(UPDATE_METADATA);

/** How the files people install end: the DMG, the setup .exe, the AppImage and the deb. */
const INSTALLER_ENDINGS = [".dmg", ".exe", ".AppImage", ".deb"] as const;

export interface UpdateFeed {
  readonly schema: 1;
  /** When the feed was written, as an ISO time. */
  readonly generated: string;
  /** The highest stable release. */
  readonly stable: FeedRelease | null;
  /**
   * The highest nightly. Versions 0.0.3 and earlier offer Nightly users the higher of this and
   * `stable`; later versions offer them nightlies only. Feeds deployed before 0.0.4 may name a
   * stable release here, which later versions skip.
   */
  readonly nightly: FeedRelease | null;
}

export interface FeedRelease {
  /** Stable immediately before this one, when known. Optional for schema-1 compatibility. */
  readonly previousStable?: string;
  /** Such as 0.0.2 or 0.0.3-nightly.20261002.14, without the tag's "v". */
  readonly version: string;
  /** When the release was published, as an ISO time. */
  readonly published: string;
  /** The release's page on GitHub. */
  readonly page: string;
  /**
   * The folder holding the release's files, https://github.com/OWNER/REPO/releases/download/TAG,
   * for electron-updater's generic provider.
   */
  readonly files: string;
  /** The release notes, in Markdown. */
  readonly notes: string;
  /** Which of latest-mac.yml, latest.yml and latest-linux.yml the release carries. */
  readonly platforms: readonly string[];
  /**
   * The names of the installers the release carries, such as Mr-Streamer-0.0.7-mac-arm64.dmg. The
   * website links only these (apps/marketing/src/downloads.ts); the app doesn't read them. Feeds
   * written before the list existed lack it.
   */
  readonly installers?: readonly string[];
}

/** A release as GitHub lists it, with what the feed needs. */
export interface GitHubRelease {
  readonly tag: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  /** ISO time; null while a draft. */
  readonly publishedAt: string | null;
  /** The release's page. */
  readonly page: string;
  /** The release body, in Markdown. */
  readonly notes: string;
  /** The names of its files. */
  readonly assets: readonly string[];
}

/**
 * The feed for a repository's releases. A release counts only when it is published, its version
 * and pre-release flag name the same channel, and it carries every platform's update metadata: a
 * release missing one is incomplete. Each channel takes its highest version, by version order and
 * never by date.
 *
 * `repository` is the repository's page, such as https://github.com/owner/repo.
 */
export function buildFeed(
  repository: string,
  releases: readonly GitHubRelease[],
  generated: string,
): UpdateFeed {
  const listed = releases
    .flatMap((release): { version: Version; entry: FeedRelease }[] => {
      const version = parseVersion(release.tag);
      if (!version || release.draft || release.publishedAt === null) return [];
      if ((channelOf(version) === "nightly") !== release.prerelease) return [];
      const platforms = PLATFORM_FILES.filter((file) => release.assets.includes(file));
      if (platforms.length < PLATFORM_FILES.length) return [];
      const entry: FeedRelease = {
        version: formatVersion(version),
        published: release.publishedAt,
        page: release.page,
        files: `${repository}/releases/download/${release.tag}`,
        notes: release.notes,
        platforms,
        installers: release.assets.filter((name) =>
          INSTALLER_ENDINGS.some((ending) => name.endsWith(ending)),
        ),
      };
      return [{ version, entry }];
    })
    .sort((a, b) => compareVersions(b.version, a.version));
  const stable = listed.filter(({ version }) => !version.nightly);
  const latest = stable[0];
  const previous = stable.find(
    ({ version }) => latest && compareVersions(version, latest.version) < 0,
  );
  return {
    schema: 1,
    generated,
    stable: latest
      ? { ...latest.entry, ...(previous && { previousStable: previous.entry.version }) }
      : null,
    nightly: listed.find(({ version }) => version.nightly)?.entry ?? null,
  };
}

/**
 * The feed to publish: `next`, except that neither channel moves to a lower version than the
 * `current` feed names, so a late or stale publication never takes users back. Each channel is
 * compared with its own releases: a stable release that a feed deployed before 0.0.4 names as
 * nightly gives way to the highest nightly. That takes no one back: versions 0.0.3 and earlier
 * still find it as `stable`, and later ones never offered it on Nightly. `current` is null
 * before the first publication. `allowRegress` publishes `next` as it is, to withdraw a release
 * that was deleted.
 */
export function mergeFeeds(
  current: UpdateFeed | null,
  next: UpdateFeed,
  options: { readonly allowRegress?: boolean } = {},
): UpdateFeed {
  if (!current || options.allowRegress) return next;
  return {
    ...next,
    stable: higher(current.stable, next.stable),
    nightly: higher(isNightly(current.nightly) ? current.nightly : null, next.nightly),
  };
}

/** Reads a feed from parsed JSON, such as the deployed one. Throws when it is not a schema 1 feed. */
export function readFeed(json: unknown): UpdateFeed {
  if (!isRecord(json) || json["schema"] !== 1 || typeof json["generated"] !== "string") {
    throw new Error("This is not an update feed with schema 1.");
  }
  return {
    schema: 1,
    generated: json["generated"],
    stable: readRelease(json["stable"], "stable"),
    nightly: readRelease(json["nightly"], "nightly"),
  };
}

function isNightly(entry: FeedRelease | null): boolean {
  return Boolean(entry && parseVersion(entry.version)?.nightly);
}

/** The entry with the higher version; `next` when both name the same one. */
function higher(current: FeedRelease | null, next: FeedRelease | null): FeedRelease | null {
  if (!current || !next) return next ?? current;
  const was = parseVersion(current.version);
  const now = parseVersion(next.version);
  return was && now && compareVersions(now, was) < 0 ? current : next;
}

function readRelease(json: unknown, channel: Channel): FeedRelease | null {
  if (json === null) return null;
  const malformed = new Error(`The feed's ${channel} release is malformed.`);
  if (!isRecord(json)) throw malformed;
  const text = (key: keyof FeedRelease): string => {
    const value = json[key];
    if (typeof value !== "string") throw malformed;
    return value;
  };
  const platforms = json["platforms"];
  // The app never reads the installers, so a list it can't read is left out, not refused.
  const installers = json["installers"];
  if (!isNames(platforms)) throw malformed;
  const version = parseVersion(text("version"));
  if (!version || (channel === "stable" && version.nightly)) {
    throw new Error(`The feed's ${channel} release has version "${text("version")}".`);
  }
  const previous =
    typeof json["previousStable"] === "string" ? parseVersion(json["previousStable"]) : null;
  return {
    version: formatVersion(version),
    published: text("published"),
    page: text("page"),
    files: text("files"),
    notes: text("notes"),
    platforms,
    ...(isNames(installers) && { installers }),
    ...(channel === "stable" &&
      previous &&
      !previous.nightly &&
      compareVersions(previous, version) < 0 && { previousStable: formatVersion(previous) }),
  };
}

function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
