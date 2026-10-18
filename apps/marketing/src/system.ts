// Which desktop system a visitor is on, so the download page puts that system's installer first:
// the Microsoft Store badge, Download the DMG or Download the AppImage above the rows for every
// system. Anything else, and anything this can't tell, gets the rows alone.
//
// The build writes `systemOf`'s own text into the head of every page (vite.config.ts), where it
// runs before the page paints and sets data-os on <html>. styles.css shows the block that
// matches. So the function uses nothing outside itself. It reads what every request already
// carries, asks for no detailed hints, and stores and sends nothing.

/** The systems Mr. Streamer has an installer for. */
export type System = "windows" | "mac" | "linux";

/** What `systemOf` reads from the browser's `navigator`. Only Chromium has `userAgentData`. */
export interface SystemHints {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  readonly userAgentData?: { readonly platform: string; readonly mobile: boolean };
}

/**
 * The visitor's system, or undefined when it is none of the three or can't be told. It names the
 * system, never the processor: the line under the button says which hardware the file is for.
 *
 * - Phones, tablets, consoles and ChromeOS are undefined, whatever else they claim.
 * - An iPad asking for the desktop site calls itself a Mac. Its touch screen gives it away.
 * - Linux needs the word Linux beside X11 or Wayland, as desktop browsers write it. X11 alone is
 *   any Unix, and Linux alone is also a television.
 * - Where the browser names its platform, that name and the user agent must agree.
 */
export function systemOf({
  userAgent,
  maxTouchPoints,
  userAgentData,
}: SystemHints): System | undefined {
  if (userAgentData?.mobile || /android|iphone|ipad|ipod|mobile|cros|xbox/i.test(userAgent)) {
    return undefined;
  }
  const platform = userAgentData?.platform.toLowerCase() ?? "";
  const is = (name: string, pattern: RegExp) =>
    (platform === "" || platform === name) && pattern.test(userAgent);
  if (is("windows", /windows nt/i)) return "windows";
  if (is("macos", /macintosh/i) && maxTouchPoints <= 1) return "mac";
  if (is("linux", /\b(x11|wayland);.*\blinux\b/i)) return "linux";
  return undefined;
}
