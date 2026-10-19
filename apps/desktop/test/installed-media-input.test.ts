import { Window } from "happy-dom";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeMediaSubscription } from "./e2e/installed-media-input.ts";

type MediaDriver = Parameters<typeof removeMediaSubscription>[0];
type Evidence = Parameters<Parameters<typeof removeMediaSubscription>[1]>[0];
const windows: Window[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

/** Real helper expressions and DOM events; supplied layout/CDP routing, no Chromium trust. */
function standIn(collapsed = true) {
  const window = new Window();
  windows.push(window);
  const document = window.document;
  document.body.innerHTML = `<main><button>Remove from Continue watching</button></main>
    <section><ul><li><button aria-expanded="${!collapsed}">Fixture · Active</button>
    ${collapsed ? "" : '<div role="region"><button>Remove Fixture</button></div>'}</li></ul></section>`;
  const row = document.querySelector("li")!;
  const header = row.querySelector("button")!;
  const app = {
    window,
    row,
    header,
    shift: 0,
    covered: false,
    onMove: () => {},
    beforePress: () => {},
    onSnapshot: () => {},
    onOutcome: (_what: string) => {},
    inputReply: {} as Awaited<ReturnType<MediaDriver["page"]["send"]>>,
    writeError: null as Error | null,
    primary: null as Error | null,
    flood: false,
    dropClick: false,
    commands: [] as { method: string; type?: unknown; timeout: number | undefined }[],
    waits: [] as { what: string; timeout: number }[],
    saved: [] as Evidence[],
  };
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  });
  const rect = (element: { textContent: string | null }) => {
    const y = element === header ? 20 : app.shift + 100;
    return { x: 10, y, width: 101, height: 31, top: y, bottom: y + 31, left: 10, right: 111 };
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const r = rect(this);
    return new window.DOMRect(r.x, r.y, r.width, r.height);
  };
  const hit = (x: number, y: number) =>
    (app.covered
      ? undefined
      : [...row.querySelectorAll("button")].find((button) => {
          const r = rect(button);
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        })) ?? document.body;
  Object.defineProperty(document, "elementFromPoint", { value: hit });
  header.addEventListener("click", () => {
    header.setAttribute("aria-expanded", "true");
    row.insertAdjacentHTML("beforeend", '<div role="region"><button>Remove Fixture</button></div>');
  });
  row.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof window.HTMLButtonElement)) return;
    if (target.textContent === "Remove Fixture") {
      row.querySelector('[role="region"]')?.remove();
      header.setAttribute("aria-expanded", "false");
      row.insertAdjacentHTML(
        "beforeend",
        '<form>Remove Fixture from this device?<button type="button">Remove</button></form>',
      );
    } else if (target.textContent === "Remove") {
      target.disabled = true;
      row.parentElement!.parentElement!.remove();
      document.body.insertAdjacentHTML("beforeend", "<form><input></form>");
    }
  });
  const context = createContext({
    document,
    window,
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 0,
    requestAnimationFrame: (callback: () => void) => callback(),
    Date,
  });
  let pressed: ReturnType<typeof hit> | undefined;
  const d: MediaDriver = {
    actions: [],
    page: {
      async evaluate<T>(expression: string, timeout?: number): Promise<T> {
        app.commands.push({ method: "evaluate", timeout });
        const result: unknown = await runInContext(expression, context);
        if (result && typeof result === "object" && "events" in result) app.onSnapshot();
        return structuredClone(result) as T;
      },
      async send(method, params = {}, timeout) {
        app.commands.push({ method, type: params["type"], timeout });
        if (app.inputReply.error) return app.inputReply;
        if (params["type"] === "mouseMoved") app.onMove();
        else {
          if (params["type"] === "mousePressed") app.beforePress();
          const target = hit(Number(params["x"]), Number(params["y"]));
          const dispatch = (type: string) =>
            target.dispatchEvent(
              new window.MouseEvent(type, {
                bubbles: true,
                clientX: Math.round(Number(params["x"])),
                clientY: Math.round(Number(params["y"])),
              }),
            );
          if (params["type"] === "mousePressed") {
            pressed = target;
            dispatch("mousedown");
            if (app.flood) for (let i = 0; i < 130; i++) dispatch("mousedown");
          } else {
            dispatch("mouseup");
            if (target === pressed && !app.dropClick) dispatch("click");
          }
        }
        return {};
      },
    },
    async wait(check, timeout = 30_000, what = "condition") {
      app.waits.push({ what, timeout });
      if (["subscription row", "removal confirmation", "Connect"].includes(what)) {
        app.onOutcome(what);
        if (app.primary) throw app.primary;
      }
      for (let attempt = 0; attempt < 3; attempt++) if (await check()) return;
      throw new Error(`Timed out waiting for ${what}`);
    },
  };
  return {
    window,
    row,
    header,
    app,
    d,
    run: () =>
      removeMediaSubscription(d, async (evidence) => {
        app.commands.push({ method: "save", timeout: undefined });
        app.saved.push(structuredClone(evidence));
        if (app.writeError) throw app.writeError;
      }),
    evidence: () => app.saved.at(-1)!,
  };
}

describe("installed media removal delivery, synthetic only", () => {
  it("keeps independent stage receipts through Ask and Settings unmounts and preserves budgets", async () => {
    const s = standIn();
    await s.run();
    const evidence = s.evidence();
    expect(evidence.phases.map((phase) => phase.stage)).toEqual(["header", "ask", "confirm"]);
    for (const phase of evidence.phases) {
      expect(phase.commands.map((command) => command.type)).toEqual([
        "mouseMoved",
        "mousePressed",
        "mouseReleased",
      ]);
      const events = phase.snapshots.at(-1)!.events;
      expect(events.map((event) => event.type)).toEqual(["mousedown", "mouseup", "click"]);
      expect(
        events.every(
          (event) => event.stage === phase.stage && event.contained && event.isTrusted !== true,
        ),
      ).toBe(true);
      expect(phase.outcome!.deadline).toBe(phase.outcome!.releaseAckAt + phase.outcome!.budgetMs);
      expect(phase.outcome!.remainingMs).toBeGreaterThan(0);
      expect(phase.outcome!.remainingMs).toBeLessThanOrEqual(phase.outcome!.budgetMs);
    }
    expect(evidence.phases[1]!.snapshots.at(-1)!.connected).toBe(false);
    expect(evidence.phases[2]!.snapshots.at(-1)!.rowConnected).toBe(false);
    expect(
      s.app.waits
        .filter((wait) => ["Ask removal", "Remove"].includes(wait.what))
        .map((wait) => wait.timeout),
    ).toEqual([30_000, 30_000]);
    expect(s.app.waits.find((wait) => wait.what === "Open collapsed subscription")!.timeout).toBe(
      10_000,
    );
    for (let i = 0; i < s.app.commands.length; i++) {
      const command = s.app.commands[i]!;
      if (command.type === "mousePressed") expect(s.app.commands[i - 1]!.method).toBe("evaluate");
    }
  });

  it("does not reuse header receipts when Ask never appears", async () => {
    const s = standIn();
    s.app.onOutcome = (what) => {
      if (what === "subscription row") s.row.querySelector('[role="region"] button')?.remove();
    };
    await expect(s.run()).rejects.toThrow("Timed out waiting for Ask removal");
    const phases = s.evidence().phases;
    expect(phases[0]!.snapshots.at(-1)!.events).toHaveLength(3);
    expect(phases[1]!.snapshots.at(-1)!.events).toHaveLength(0);
  });

  it("refreshes geometry after a move before the final check", async () => {
    const s = standIn(false);
    s.app.onMove = () => {
      s.app.shift = 52;
    };
    await s.run();
    const ask = s.evidence().phases[0]!;
    expect(ask.initial!.y).not.toBe(ask.final!.y);
    expect(ask.snapshots.at(-1)!.events.every((event) => event.contained)).toBe(true);
  });

  it.each(["move", "replace"])(
    "records %s after the check and still runs the primary outcome",
    async (mode) => {
      const s = standIn(false);
      s.app.beforePress = () => {
        if (mode === "move") s.app.shift += 52;
        else {
          const button = s.row.querySelector('[role="region"] button')!;
          button.replaceWith(button.cloneNode(true));
        }
      };
      // Model an independently visible outcome so delivery completeness decides after the wait.
      s.app.onOutcome = (what) => {
        if (what === "removal confirmation")
          s.row.insertAdjacentHTML("beforeend", "<p>from this device?</p>");
      };
      await expect(s.run()).rejects.toThrow("evidence incomplete");
      expect(s.app.waits.some((wait) => wait.what === "removal confirmation")).toBe(true);
      expect(
        s
          .evidence()
          .phases[0]!.snapshots.at(-1)!
          .events.some((event) => !event.contained),
      ).toBe(true);
    },
  );

  it.each(["ambiguous", "disabled", "wrong row", "disconnected", "replaced"])(
    "fails closed before input for %s",
    async (mode) => {
      const s = standIn(false);
      const button = s.row.querySelector('[role="region"] button')!;
      if (mode === "ambiguous") button.parentElement!.append(button.cloneNode(true));
      if (mode === "disabled") button.setAttribute("disabled", "");
      if (mode === "wrong row") {
        const nested = s.window.document.createElement("li");
        button.parentElement!.append(nested);
        nested.append(button);
      }
      if (mode === "disconnected" || mode === "replaced")
        s.app.onMove = () => {
          if (mode === "disconnected") button.remove();
          else button.replaceWith(button.cloneNode(true));
        };
      await expect(s.run()).rejects.toThrow(/target/);
      expect(s.app.commands.some((command) => command.type === "mousePressed")).toBe(false);
    },
  );

  it.each(["truncated", "missing click"])(
    "rejects %s receipts after a successful outcome",
    async (mode) => {
      const s = standIn(false);
      s.app.flood = mode === "truncated";
      s.app.dropClick = mode === "missing click";
      s.app.onOutcome = (what) => {
        if (what === "removal confirmation")
          s.row.insertAdjacentHTML("beforeend", "<p>from this device?</p>");
      };
      await expect(s.run()).rejects.toThrow("evidence incomplete");
      const last = s.evidence().phases[0]!.snapshots.at(-1)!;
      expect(last.events.length).toBeLessThanOrEqual(128);
      expect(last.truncated).toBe(mode === "truncated");
    },
  );

  it("rejects an input protocol error before the outcome wait and keeps its reply", async () => {
    const s = standIn(false);
    s.app.inputReply = { error: "Input.dispatchMouseEvent timed out" };
    await expect(s.run()).rejects.toThrow("input protocol error");
    expect(s.evidence().phases[0]!.commands[0]!.reply).toEqual(s.app.inputReply);
    expect(s.app.waits.some((wait) => wait.what === "removal confirmation")).toBe(false);
  });

  it("preserves the primary Error object through evidence and observer cleanup failures", async () => {
    const s = standIn(false);
    const primary = new Error("Timed out waiting for removal confirmation");
    s.app.primary = primary;
    s.app.writeError = new Error("disk unavailable");
    vi.spyOn(s.window.document, "removeEventListener").mockImplementation(() => {
      throw new Error("cleanup unavailable");
    });
    await expect(s.run()).rejects.toBe(primary);
    expect(s.evidence().error).toContain(primary.message);
    expect(s.evidence().diagnosticErrors.join(" ")).toContain("cleanup unavailable");
  });

  it("runs the outcome even when the post-release diagnostic fails", async () => {
    const s = standIn(false);
    s.app.onSnapshot = () => {
      throw new Error("diagnostic unavailable");
    };
    await expect(s.run()).rejects.toThrow("evidence incomplete");
    expect(s.app.waits.some((wait) => wait.what === "removal confirmation")).toBe(true);
  });

  it.each(["write", "cleanup"])(
    "fails otherwise successful removal when %s evidence is incomplete",
    async (mode) => {
      const s = standIn(false);
      if (mode === "write") s.app.writeError = new Error("disk unavailable");
      else
        vi.spyOn(s.window.document, "removeEventListener").mockImplementation(() => {
          throw new Error("cleanup unavailable");
        });
      await expect(s.run()).rejects.toThrow("evidence incomplete");
      expect(
        s.app.waits.some(
          (wait) => wait.what === (mode === "write" ? "removal confirmation" : "Connect"),
        ),
      ).toBe(true);
    },
  );

  it("retains a failed final hit check without pressing", async () => {
    const s = standIn(false);
    s.app.onMove = () => {
      s.app.covered = true;
    };
    await expect(s.run()).rejects.toThrow("target not under pointer");
    expect(s.evidence().phases[0]!.final!.contained).toBe(false);
    expect(s.app.commands.some((command) => command.type === "mousePressed")).toBe(false);
  });

  it("labels an exhausted diagnostic budget as evidence overrun", async () => {
    const s = standIn(false);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    s.app.onSnapshot = () => {
      clock.mockReturnValue(now + 10_001);
    };
    await expect(s.run()).rejects.toThrow("instrumentation/evidence overrun");
    expect(s.app.waits.some((wait) => wait.what === "removal confirmation")).toBe(false);
  });
});
