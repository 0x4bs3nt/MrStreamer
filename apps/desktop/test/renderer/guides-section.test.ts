// @vitest-environment happy-dom
// Settings > Guides: the XMLTV sources every subscription reads after its own guide, each a row of
// its host and what it is doing, in the order Up and Down give them; an address added at Add is
// sent once and the field starts empty again; a failing source says why and since when, and that
// its last download stays in use; each row moves on as `guide.updated` tells it; a move or a
// removal that fails says why on its row; and the keyboard lands on a button it can press after
// either.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuideSourceStatus } from "@mrstreamer/contracts/guide";
import { formatBytes, formatPercent } from "@mrstreamer/core/i18n";
import { GuidesSection } from "../../src/renderer/src/features/settings/GuidesSection.tsx";
import { comingTime, pastTime } from "../../src/renderer/src/lib/format.ts";
import { describeError } from "../../src/renderer/src/lib/errors.ts";
import { syncGuideUpdates } from "../../src/renderer/src/lib/queries.ts";

let unmount = () => {};
afterEach(() => unmount());

const HOUR = 60 * 60 * 1000;
const now = Date.now();
const ready: GuideSourceStatus = {
  id: "ready",
  origin: "https://iptv-epg.example",
  locked: false,
  processing: {
    state: "ready",
    channels: 412,
    programmes: 1204,
    until: now + 40 * HOUR,
    fetchedAt: now - 3 * HOUR,
  },
};
const downloading: GuideSourceStatus = {
  id: "downloading",
  origin: "https://epg.northsea.example",
  locked: false,
  processing: { state: "downloading", bytes: 46 * 1024 * 1024, total: 82 * 1024 * 1024 },
};
const reading: GuideSourceStatus = {
  id: "reading",
  origin: "https://guide.bigtv.example",
  locked: false,
  processing: { state: "reading", programmes: 640, since: now - HOUR },
};
const failed: GuideSourceStatus = {
  id: "failed",
  origin: "http://xml.oldhost.example:8080",
  locked: false,
  processing: {
    state: "failed",
    reason: { kind: "guide", failure: { kind: "not-xmltv" } },
    since: now - 5 * HOUR,
    kept: now - 30 * HOUR,
  },
};

/** Settings > Guides with `sources` answered, kept in step with the main process's events. */
async function section(sources: readonly GuideSourceStatus[]) {
  ipc.reset();
  ipc.always("guide.sources", sources);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = syncGuideUpdates(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(GuidesSection))),
  );
  unmount = () => {
    stop();
    act(() => root.unmount());
    container.remove();
  };
  const settled = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  await settled();
  /** Each row: its host, what it is doing, whether that is said as a failure, and its buttons. */
  const rows = () =>
    [...container.querySelectorAll("li")].map((row) => {
      const [host, state] = [...(row.firstElementChild?.children ?? [])];
      return {
        host: host?.textContent,
        state: state?.textContent,
        failing: state?.className.includes("text-destructive") ?? false,
        buttons: [...row.querySelectorAll("button")].map(
          (each) => each.getAttribute("aria-label") ?? each.textContent,
        ),
      };
    });
  /** Presses the button called `label` from the keyboard: it has the focus first. */
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (each) => (each.getAttribute("aria-label") ?? each.textContent?.trim()) === label,
    );
    if (!button) throw new Error(`No button ${label}`);
    button.focus();
    await act(async () => button.click());
    await settled();
  };
  /** What the keyboard is on, by its name. */
  const focused = () =>
    document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName;
  const field = () => container.querySelector("input");
  const type = async (value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      const input = field();
      setValue?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settled();
  };
  return { container, rows, click, focused, field, type, submit, settled };
}

describe("Settings > Guides", () => {
  it("shows each source as its host and what it is doing, in order, failing ones in red", async () => {
    const { rows } = await section([ready, downloading, reading, failed]);

    expect(rows()).toEqual([
      {
        host: "iptv-epg.example",
        state: `Ready · 412 channels · ${(1204).toLocaleString()} programmes · until ${comingTime(now + 40 * HOUR, now)} · updated ${pastTime(now - 3 * HOUR, now)}`,
        failing: false,
        buttons: [
          "Refresh iptv-epg.example",
          "Move iptv-epg.example up",
          "Move iptv-epg.example down",
          "Remove iptv-epg.example",
        ],
      },
      {
        host: "epg.northsea.example",
        state: `Downloading · ${formatBytes(46 * 1024 * 1024)} of ${formatBytes(82 * 1024 * 1024)}`,
        failing: false,
        buttons: [
          "Move epg.northsea.example up",
          "Move epg.northsea.example down",
          "Remove epg.northsea.example",
        ],
      },
      {
        host: "guide.bigtv.example",
        state: `Reading · 640 programmes so far · since ${pastTime(now - HOUR, now)}`,
        failing: false,
        buttons: [
          "Move guide.bigtv.example up",
          "Move guide.bigtv.example down",
          "Remove guide.bigtv.example",
        ],
      },
      {
        host: "xml.oldhost.example:8080",
        state: `Failed since ${pastTime(now - 5 * HOUR, now)} · The address answered, but not with an XMLTV guide. · programmes from ${pastTime(now - 30 * HOUR, now)} stay in use`,
        failing: true,
        buttons: [
          "Retry xml.oldhost.example:8080",
          "Move xml.oldhost.example:8080 up",
          "Move xml.oldhost.example:8080 down",
          "Remove xml.oldhost.example:8080",
        ],
      },
    ]);
  });

  it("draws how far a download got as a still bar, with no bar while its size is unknown", async () => {
    const { container } = await section([downloading]);

    const bar = container.querySelector("li span span") as HTMLElement | null;
    expect(bar?.style.width).toBe(`${(46 / 82) * 100}%`);
    expect(container.textContent).toContain(formatPercent(46 / 82));
    // Nothing on it repaints on its own.
    expect(container.innerHTML).not.toContain("animate-");
    unmount();

    const unknown = await section([
      {
        ...downloading,
        processing: { state: "downloading", bytes: 31 * 1024 * 1024, total: null },
      },
    ]);
    expect(unknown.container.querySelector("li span span")).toBeNull();
    expect(unknown.rows()[0]?.state).toBe(`Downloading · ${formatBytes(31 * 1024 * 1024)} so far`);
  });

  it("adds an address at Add, empties the field, and shows the new row as the main process tells it", async () => {
    const { rows, field, type, submit, settled } = await section([ready]);
    const address = "https://new.example.org/guide.xml.gz?key=s3cret";

    const added = ipc.hold("guide.addSource");
    await type(address);
    await submit();
    expect(ipc.argsOf("guide.addSource")).toEqual([{ address }]);
    const fresh: GuideSourceStatus = {
      id: "new",
      origin: "https://new.example.org",
      locked: false,
      processing: { state: "downloading", bytes: 0, total: null },
    };
    ipc.always("guide.sources", [ready, fresh]);
    added.resolve(fresh);
    await settled();

    expect(field()?.value).toBe("");
    expect(rows().map((each) => [each.host, each.state])).toEqual([
      ["iptv-epg.example", expect.stringMatching(/^Ready/)],
      ["new.example.org", `Downloading · ${formatBytes(0)} so far`],
    ]);
    // It moves on as the main process tells it.
    ipc.always("guide.sources", [
      ready,
      { ...fresh, processing: { state: "reading", programmes: 20, since: now } },
    ]);
    await act(async () => ipc.emit("guide.updated", null));
    await settled();
    expect(rows()[1]?.state).toBe(`Reading · 20 programmes so far · since ${pastTime(now, now)}`);
    // Nothing of the address shows but its host.
    expect(document.body.textContent).not.toContain("s3cret");
  });

  it("says why an address can't be added, and keeps it in the field to correct", async () => {
    const { container, field, type, submit } = await section([]);

    ipc.hold("guide.addSource").reject({ kind: "guide", failure: { kind: "address" } });
    await type("ftp://guide.example.org/x");
    await submit();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Enter the address of an XMLTV guide.",
    );
    expect(field()?.value).toBe("ftp://guide.example.org/x");
  });

  it("moves a source up and down, removes one, and retries a failing one", async () => {
    const { rows, click } = await section([ready, failed]);

    expect(rows()[0]?.buttons).toContain("Move iptv-epg.example up");
    // At the ends, there is nowhere to go.
    const disabled = (label: string) =>
      [...document.querySelectorAll("button")].find(
        (each) => each.getAttribute("aria-label") === label,
      )?.disabled;
    expect(disabled("Move iptv-epg.example up")).toBe(true);
    expect(disabled("Move xml.oldhost.example:8080 down")).toBe(true);

    await click("Move xml.oldhost.example:8080 up");
    await click("Move iptv-epg.example down");
    await click("Retry xml.oldhost.example:8080");
    await click("Remove iptv-epg.example");

    expect(ipc.argsOf("guide.moveSource")).toEqual([
      { id: "failed", by: -1 },
      { id: "ready", by: 1 },
    ]);
    expect(ipc.argsOf("guide.refreshSource")).toEqual([{ id: "failed" }]);
    expect(ipc.argsOf("guide.removeSource")).toEqual([{ id: "ready" }]);
  });

  it("says on its row why a move or a removal failed, and keeps the list as it was", async () => {
    const { container, rows, click } = await section([ready, failed]);
    const disk = { kind: "unexpected", detail: "EISDIR" } as const;

    ipc.hold("guide.removeSource").reject(disk);
    await click("Remove iptv-epg.example");
    const alerts = () =>
      [...container.querySelectorAll('li [role="alert"]')].map((each) => [
        each.closest("li")?.dataset["source"],
        each.textContent,
      ]);
    expect(alerts()).toEqual([["ready", describeError(disk)]]);
    expect(rows().map((each) => each.host)).toEqual([
      "iptv-epg.example",
      "xml.oldhost.example:8080",
    ]);

    ipc.hold("guide.moveSource").reject(disk);
    await click("Move xml.oldhost.example:8080 up");
    expect(alerts()).toEqual([
      ["ready", describeError(disk)],
      ["failed", describeError(disk)],
    ]);
    // Done again, and done, the line goes.
    ipc.hold("guide.moveSource").resolve(null);
    await click("Move xml.oldhost.example:8080 up");
    expect(alerts()).toEqual([["ready", describeError(disk)]]);
  });

  it("keeps the keyboard on a button it can press after a move or a removal", async () => {
    const { click, focused } = await section([ready, downloading, failed]);

    // Moved to the top, where up goes no further: down instead.
    ipc.always("guide.sources", [downloading, ready, failed]);
    ipc.hold("guide.moveSource").resolve(null);
    await click("Move epg.northsea.example up");
    expect(focused()).toBe("Move epg.northsea.example down");
    // Moved within the list: the arrow pressed.
    ipc.always("guide.sources", [ready, downloading, failed]);
    ipc.hold("guide.moveSource").resolve(null);
    await click("Move epg.northsea.example down");
    expect(focused()).toBe("Move epg.northsea.example down");

    // Removed: the row that took its place, else the one before, else the field.
    ipc.always("guide.sources", [ready, failed]);
    ipc.hold("guide.removeSource").resolve(null);
    await click("Remove epg.northsea.example");
    expect(focused()).toBe("Remove xml.oldhost.example:8080");
    ipc.always("guide.sources", [ready]);
    ipc.hold("guide.removeSource").resolve(null);
    await click("Remove xml.oldhost.example:8080");
    expect(focused()).toBe("Remove iptv-epg.example");
    ipc.always("guide.sources", []);
    ipc.hold("guide.removeSource").resolve(null);
    await click("Remove iptv-epg.example");
    expect(focused()).toBe("Address of an XMLTV guide");
  });
});

vi.setConfig({ testTimeout: 10_000 });
