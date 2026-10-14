// Notices for what the installers ship, the app itself included, as Settings > About lists them.
// The build writes them to out/licences/third-party.json (apps/desktop/scripts/licences.ts), and
// the main process reads that file when the UI asks.
import { type } from "arktype";
import { lazy, type Infer } from "./lazy.ts";

const Notice = lazy(() =>
  type({
    /** `name@version`, unique in the list. */
    id: "string",
    name: "string",
    version: "string",
    /** An SPDX licence expression, such as `MIT` or `GPL-2.0-or-later`. */
    licence: "string",
    /** Where the source is: the repository, or the exact archive for what the app builds itself. */
    source: "string",
    homepage: "string | null",
  }),
);

/** A component the installers carry: a bundled package, Electron, FFmpeg, the app itself. */
export type ThirdPartyNotice = Infer<typeof Notice>;

/**
 * third-party.json. A notice's text is inline, or a project's section of the Chromium credits page
 * that ships with Electron (`*` for the whole page), which the app reads from its own install.
 * `{chrome}` and `{node}` in versions and links stand for the versions of the running Electron.
 */
export const NoticeManifest = lazy(() =>
  type({
    version: "1",
    notices: Notice()
      .merge({ text: type("string").or({ credits: "string" }) })
      .array(),
  }),
);
export type NoticeManifest = Infer<typeof NoticeManifest>;
