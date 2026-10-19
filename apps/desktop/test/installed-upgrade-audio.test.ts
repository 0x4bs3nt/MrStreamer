import { Window } from "happy-dom";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreAudioInput } from "./e2e/installed-upgrade-audio.ts";

type AudioDriver = Parameters<typeof restoreAudioInput>[0];
type AudioEvidence = Parameters<Parameters<typeof restoreAudioInput>[1]>[0];
const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

/** A closed select's typeahead commits only when the selected value actually changes. */
function standIn() {
  const window = new Window();
  windows.push(window);
  // happy-dom omits isTrusted. Every event this stand-in creates is synthetic and untrusted.
  Object.defineProperty(window.Event.prototype, "isTrusted", { value: false });
  window.document.body.innerHTML = `
    <select aria-label="Audio in">
      <option value="en">English</option><option value="es" selected>Español</option>
      <option value="nl">Nederlands</option><option value="fr">Français</option>
    </select><select aria-label="Subtitles"><option>Français</option></select>`;
  const select = window.document.querySelector("select")!;
  const app = {
    window,
    select,
    publicAudio: "es",
    acknowledge: true,
    revert: false,
    inputError: null as Error | null,
    diagnosticReadError: null as Error | null,
    onPublicRead: () => {},
    onRejectedPoll: (_what: string, _attempt: number) => {},
    commands: [] as { method: string; params: Record<string, unknown> }[],
    waits: [] as { what: string; timeout: number }[],
    timeouts: [] as Error[],
    budgets: [] as number[],
    written: [] as AudioEvidence[],
  };
  select.addEventListener("change", () => {
    if (app.acknowledge) app.publicAudio = select.value;
    if (app.revert) select.value = "es";
  });
  const added = vi.spyOn(select, "addEventListener");
  const removed = vi.spyOn(select, "removeEventListener");
  const typeahead = (prefix: string) => {
    const options = [...select.options];
    const ordered = [
      ...options.slice(select.selectedIndex + 1),
      ...options.slice(0, select.selectedIndex + 1),
    ];
    const next = ordered.find(
      (o) =>
        !o.disabled &&
        o.parentElement?.getAttribute("disabled") === null &&
        (o.getAttribute("label") || o.text).trim().toLowerCase().startsWith(prefix.toLowerCase()),
    );
    if (!next || next.value === select.value) return;
    select.value = next.value;
    for (const type of ["input", "change"])
      select.dispatchEvent(new window.Event(type, { bubbles: true }));
  };
  Object.assign(window, {
    mrStreamer: {
      async invoke(method: string) {
        expect(method).toBe("preferences.get");
        app.onPublicRead();
        if (app.diagnosticReadError) throw app.diagnosticReadError;
        return { ok: true, value: { audioLanguage: app.publicAudio } };
      },
    },
  });
  // Use one context for the scoped observer and clone results as CDP returnByValue does.
  const context = {
    window,
    document: window.document,
    HTMLSelectElement: window.HTMLSelectElement,
  };
  const d: AudioDriver = {
    actions: [],
    page: {
      async evaluate<T>(expression: string, timeout?: number): Promise<T> {
        if (timeout !== undefined) app.budgets.push(timeout);
        return structuredClone(await runInNewContext(expression, context)) as T;
      },
      async send(method, params = {}) {
        app.commands.push({ method, params });
        expect(method).toBe("Input.dispatchKeyEvent");
        if (app.inputError) throw app.inputError;
        if (params["type"] === "keyDown" && typeof params["text"] === "string") {
          expect(window.document.activeElement).toBe(select);
          typeahead(params["text"]);
        }
        if (params["type"] === "rawKeyDown" && params["key"] === "Tab")
          window.document.querySelectorAll("select")[1]?.focus();
        return {};
      },
    },
    async wait(check, timeout = 30_000, what = "condition") {
      app.waits.push({ what, timeout });
      for (let attempt = 0; attempt < 4; attempt++) {
        if (await check().catch(() => false)) return;
        app.onRejectedPoll(what, attempt);
      }
      const error = new Error(`Timed out waiting for ${what}`);
      app.timeouts.push(error);
      throw error;
    },
    async read(method) {
      expect(method).toBe("preferences.get");
      return { audioLanguage: app.publicAudio };
    },
    async key(name, code) {
      d.actions.push({ at: new Date().toISOString(), action: `Press ${name}` });
      for (const type of ["rawKeyDown", "keyUp"])
        await d.page.send("Input.dispatchKeyEvent", {
          type,
          key: name,
          code: name,
          windowsVirtualKeyCode: code,
        });
    },
  };
  const write = vi.fn(async (trace: AudioEvidence) => {
    app.written.push(structuredClone(trace));
  });
  return { window, select, d, write, added, removed, typeahead, state: app };
}

function expectRemoved(app: ReturnType<typeof standIn>) {
  expect(app.removed.mock.calls).toEqual(app.added.mock.calls);
  expect(app.removed).toHaveBeenCalledTimes(2);
}

describe("installed-upgrade's original Dutch audio restore", () => {
  it("sends no input on stale Dutch, waits for public Spanish, then commits one N and Tab", async () => {
    const app = standIn();
    app.select.value = "nl";
    app.typeahead("N");
    expect(app.state.publicAudio).toBe("es"); // The stale selection is a real no-op in this model.
    app.state.onRejectedPoll = (what, attempt) => {
      expect(what).toBe("Settings showing the saved Audio in");
      expect(app.state.commands).toEqual([]);
      if (attempt === 1) app.select.value = "es";
    };

    await restoreAudioInput(app.d, app.write);

    expect(app.state.commands).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "N", code: "KeyN", windowsVirtualKeyCode: 78, text: "N" },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", key: "N", code: "KeyN", windowsVirtualKeyCode: 78 },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
      },
    ]);
    expect(app.d.actions.map((each) => each.action)).toEqual([
      "Focus Restore Audio in",
      "Restore Audio in: N",
      "Press Tab",
    ]);
    expect(app.state.waits).toEqual([
      { what: "Restore Audio in", timeout: 30_000 },
      { what: "Settings showing the saved Audio in", timeout: 10_000 },
      { what: "Restore Audio in focus", timeout: 10_000 },
      { what: "Restore Audio in nl", timeout: 10_000 },
      { what: "the original saved audio preference", timeout: 10_000 },
    ]);
    const trace = app.state.written[0]!;
    expect(trace.diagnosticErrors).toEqual([]);
    expect(trace.snapshots).toMatchObject([
      { phase: "before-readiness", publicAudio: "es", dom: { value: "nl" }, events: [] },
      {
        phase: "focused-before-key",
        publicAudio: "es",
        dom: { value: "es", sameTarget: true, connected: true, focused: true },
        events: [],
      },
      { phase: "post-input", publicAudio: "nl", dom: { value: "nl" } },
      { phase: "post-public-ack", publicAudio: "nl", dom: { value: "nl" } },
    ]);
    expect(trace.events).toMatchObject([
      { type: "input", isTrusted: false, value: "nl", selectedIndex: 2, focused: true },
      { type: "change", isTrusted: false, value: "nl", selectedIndex: 2, focused: true },
    ]);
    expect(trace.truncated).toBe(false);
    for (const event of trace.events) {
      expect(event.at).toBeGreaterThanOrEqual(trace.keys[0]!.at);
      expect(event.at).toBeLessThanOrEqual(trace.keys[1]!.at);
      expect(event.timeStamp).toEqual(expect.any(Number));
    }
    expect(trace.keys.map(({ type, key }) => ({ type, key }))).toEqual([
      { type: "keyDown", key: "N" },
      { type: "keyUp", key: "N" },
      { type: "press", key: "Tab" },
    ]);
    expect(trace.keys.every((key) => key.completedAt! >= key.at)).toBe(true);
    expect(app.state.budgets.every((budget) => budget === 1000)).toBe(true);
    expectRemoved(app);
  });

  it.each(["stale Dutch", "mismatched public state", "no saved alternate"])(
    "fails readiness without native input for %s",
    async (state) => {
      const app = standIn();
      if (state === "mismatched public state") app.state.publicAudio = "fr";
      else app.select.value = "nl";
      if (state === "no saved alternate") app.state.publicAudio = "nl";
      await expect(restoreAudioInput(app.d, app.write)).rejects.toThrow(
        "Timed out waiting for Settings showing the saved Audio in",
      );
      expect(app.state.commands).toEqual([]);
      expect(app.state.written[0]?.error).toContain("Settings showing the saved Audio in");
      expectRemoved(app);
    },
  );

  it.each<[string, (app: ReturnType<typeof standIn>) => void]>([
    ["missing control", (app) => app.select.remove()],
    [
      "disabled control",
      (app) => {
        app.select.disabled = true;
      },
    ],
    [
      "multiple select",
      (app) => {
        app.select.multiple = true;
      },
    ],
    ["duplicate control", (app) => app.select.after(app.select.cloneNode(true))],
    [
      "wrong control type",
      (app) => {
        app.select.outerHTML = '<input aria-label="Audio in">';
      },
    ],
  ])("fails closed before input for %s", async (_, change) => {
    const app = standIn();
    change(app);
    await expect(restoreAudioInput(app.d, app.write)).rejects.toThrow();
    expect(app.state.commands).toEqual([]);
    expect(app.write).toHaveBeenCalledOnce();
  });

  it.each<[string, (app: ReturnType<typeof standIn>) => void]>([
    ["missing nl", (app) => app.select.options[2]!.remove()],
    [
      "disabled nl",
      (app) => {
        app.select.options[2]!.disabled = true;
      },
    ],
    [
      "wrong nl label",
      (app) => {
        app.select.options[2]!.setAttribute("label", "Dutch");
      },
    ],
    ["duplicate nl", (app) => app.select.append(app.select.options[2]!.cloneNode(true))],
    [
      "ambiguous N",
      (app) => app.select.insertAdjacentHTML("beforeend", '<option value="no">Norsk</option>'),
    ],
    [
      "disabled optgroup",
      (app) => {
        const group = app.window.document.createElement("optgroup");
        group.disabled = true;
        group.append(app.select.options[2]!);
        app.select.append(group);
      },
    ],
  ])("validates %s after readiness and focus, before sending any key", async (_, change) => {
    const app = standIn();
    // A mount refresh can change the option list after the earlier readiness observation.
    app.select.addEventListener("focus", () => change(app), { once: true });
    await expect(restoreAudioInput(app.d, app.write)).rejects.toThrow(
      "N does not uniquely identify enabled Nederlands/nl",
    );
    expect(app.state.commands).toEqual([]);
    expect(app.state.written[0]?.snapshots.at(-1)?.phase).toBe("restore-failure");
  });

  it("refuses a replacement focused select instead of typing into an unobserved element", async () => {
    const app = standIn();
    app.select.addEventListener(
      "focus",
      () => {
        const replacement = app.select.cloneNode(true);
        app.select.replaceWith(replacement);
        app.window.document.querySelector("select")!.focus();
      },
      { once: true },
    );
    await expect(restoreAudioInput(app.d, app.write)).rejects.toThrow(
      "lost its ready, observed and focused select",
    );
    expect(app.state.commands).toEqual([]);
    expect(app.state.written[0]?.snapshots.at(-1)?.dom).toMatchObject({
      connected: false,
      sameTarget: false,
    });
  });

  it("checks options again when they change during the focused public read", async () => {
    const app = standIn();
    app.state.onPublicRead = () => {
      if (app.window.document.activeElement === app.select)
        app.select.insertAdjacentHTML("beforeend", '<option value="no">Norsk</option>');
    };
    await expect(restoreAudioInput(app.d, app.write)).rejects.toThrow(
      "N does not uniquely identify",
    );
    expect(app.state.commands).toEqual([]);
  });

  it.each(["DOM", "public"])(
    "keeps the original %s acknowledgement failure and saves before removing listeners",
    async (which) => {
      const app = standIn();
      app.state.acknowledge = false;
      app.state.revert = which === "DOM";
      app.write.mockImplementation(async (trace) => {
        expect(app.removed).not.toHaveBeenCalled();
        app.state.written.push(structuredClone(trace));
      });
      const error = await restoreAudioInput(app.d, app.write).catch((error: unknown) => error);
      expect(error).toBe(app.state.timeouts[0]);
      expect(error).toEqual(
        new Error(
          `Timed out waiting for ${which === "DOM" ? "Restore Audio in nl" : "the original saved audio preference"}`,
        ),
      );
      expect(app.state.written[0]?.snapshots.at(-1)).toMatchObject({
        phase: "restore-failure",
        publicAudio: "es",
      });
      expect(app.state.written[0]?.events).toHaveLength(2);
      expectRemoved(app);
    },
  );

  it("observes through public acknowledgement failure with a bounded trace and truncation", async () => {
    const app = standIn();
    app.state.acknowledge = false;
    app.state.onRejectedPoll = (what) => {
      if (what !== "the original saved audio preference") return;
      for (let i = 0; i < 150; i++) app.select.dispatchEvent(new app.window.Event("change"));
    };
    await expect(restoreAudioInput(app.d, app.write)).rejects.toThrow(
      "the original saved audio preference",
    );
    const trace = app.state.written[0]!;
    expect(trace.events).toHaveLength(128);
    expect(trace.truncated).toBe(true);
    expect(trace.events.every((event) => event.isTrusted === false)).toBe(true);
    expectRemoved(app);
  });

  it.each(["native input", "public acknowledgement"])(
    "preserves the exact %s Error when diagnostics also fail",
    async (which) => {
      const app = standIn();
      const primary = new Error("original native input failure");
      if (which === "native input") {
        app.state.inputError = primary;
        app.d.page.send = async () => {
          app.state.diagnosticReadError = new Error("diagnostic read failed");
          throw primary;
        };
      } else {
        app.state.acknowledge = false;
        app.state.onRejectedPoll = (what, attempt) => {
          if (what === "the original saved audio preference" && attempt === 3)
            app.state.diagnosticReadError = new Error("diagnostic read failed");
        };
      }
      app.write.mockRejectedValue(new Error("diagnostic write failed"));
      app.removed.mockImplementation(() => {
        throw new Error("diagnostic cleanup failed");
      });
      const error = await restoreAudioInput(app.d, app.write).catch((error: unknown) => error);
      expect(error).toBe(which === "native input" ? primary : app.state.timeouts[0]);
      expect(app.write).toHaveBeenCalled();
      expect(app.removed).toHaveBeenCalled();
      expect(app.state.budgets.every((budget) => budget === 1000)).toBe(true);
      const trace = app.write.mock.calls[0]![0];
      expect(trace.diagnosticErrors.join(" ")).toContain("diagnostic read failed");
      expect(trace.diagnosticErrors.join(" ")).toContain("diagnostic write failed");
      expect(trace.diagnosticErrors.join(" ")).toContain("diagnostic cleanup failed");
      expect(trace.events).toHaveLength(which === "native input" ? 0 : 2);
    },
  );
});
