import { randomUUID } from "node:crypto";
import type { Result } from "../../../../packages/contracts/src/errors.ts";
import type { IpcOutput } from "../../../../packages/contracts/src/ipc.ts";
import type { Driver } from "./installed-upgrade.ts";

type AudioDriver = Pick<Driver, "actions" | "wait" | "key"> & {
  page: Pick<Driver["page"], "evaluate" | "send">;
  read(method: "preferences.get"): Promise<Pick<IpcOutput<"preferences.get">, "audioLanguage">>;
};

interface AudioEvent {
  at: number;
  timeStamp: number;
  type: string;
  isTrusted: boolean;
  value: string;
  selectedIndex: number;
  focused: boolean;
}

interface AudioSnapshot {
  at: number;
  phase: string;
  publicAudio: string | null | undefined;
  dom: {
    controls: number;
    value: string | null;
    selectedIndex: number | null;
    disabled: boolean;
    multiple: boolean;
    sameTarget: boolean;
    connected: boolean;
    focused: boolean;
    options: { value: string; label: string; disabled: boolean; selected: boolean }[];
  };
  events: AudioEvent[];
  truncated: boolean;
}

interface AudioEvidence {
  snapshots: AudioSnapshot[];
  events: AudioEvent[];
  truncated: boolean;
  keys: { at: number; completedAt?: number; type: string; key: string }[];
  diagnosticErrors: string[];
  error?: string;
}

const errorText = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

/** Restore only stable's Dutch seed, observing its native input through the public save check. */
export async function restoreAudioInput(
  d: AudioDriver,
  writeEvidence: (evidence: AudioEvidence) => Promise<void>,
): Promise<void> {
  const boundary = `Symbol.for(${JSON.stringify(`mrstreamer.restore-audio.${randomUUID()}`)})`;
  const selector = `'[aria-label="Audio in"]'`;
  const control = `
    const controls = document.querySelectorAll(${selector});
    const e = controls[0];
    if (controls.length !== 1 || !(e instanceof HTMLSelectElement) ||
        !e.isConnected || e.matches(':disabled') || e.multiple)
      throw new Error('Expected one enabled single Audio in select');`;
  const trace: AudioEvidence = {
    snapshots: [],
    events: [],
    truncated: false,
    keys: [],
    diagnosticErrors: [],
  };
  // Diagnostics have a short CDP budget of their own, including the public read. They never
  // extend an acknowledgement wait or replace its error if the page is already failing.
  const snapshot = async (phase: string) => {
    let publicAudio: AudioSnapshot["publicAudio"];
    try {
      const result = await d.page.evaluate<
        Result<Pick<IpcOutput<"preferences.get">, "audioLanguage">>
      >("window.mrStreamer.invoke('preferences.get')", 1000);
      if (!result.ok) throw new Error("Audio snapshot preferences.get failed");
      publicAudio = result.value.audioLanguage ?? null;
    } catch (error) {
      trace.diagnosticErrors.push(`${phase} public read: ${errorText(error)}`);
    }
    try {
      const result = await d.page.evaluate<Omit<AudioSnapshot, "phase" | "publicAudio">>(
        `(() => {
          const p = globalThis[${boundary}];
          const controls = document.querySelectorAll(${selector});
          const e = controls[0];
          const select = e instanceof HTMLSelectElement ? e : null;
          return { at: Date.now(),
            dom: { controls: controls.length, value: select?.value ?? null,
              selectedIndex: select?.selectedIndex ?? null,
              disabled: !select || select.matches(':disabled'), multiple: select?.multiple ?? false,
              sameTarget: !!p && p.element === select, connected: p?.element.isConnected ?? false,
              focused: !!select && document.activeElement === select,
              options: [...(select?.options ?? [])].map(o => ({ value: o.value,
                label: (o.getAttribute('label') || o.text).trim(),
                disabled: o.disabled || o.parentElement?.disabled === true,
                selected: o.selected })) },
            events: p?.events ?? [], truncated: p?.truncated ?? false };
        })()`,
        1000,
      );
      const observation = { ...result, phase, publicAudio };
      trace.snapshots.push(observation);
      trace.events = result.events;
      trace.truncated = result.truncated;
      return observation;
    } catch (error) {
      trace.diagnosticErrors.push(`${phase}: ${errorText(error)}`);
      return null;
    }
  };
  let failed = false;
  let primaryError: unknown;
  try {
    await d.wait(
      () => d.page.evaluate<boolean>(`!!document.querySelector(${selector})`),
      30_000,
      "Restore Audio in",
    );
    await d.page.evaluate(
      `(() => {
      ${control}
      const p = { element: e, events: [], truncated: false };
      p.listener = event => {
        if (event.target !== e) return;
        if (p.events.length >= 128) { p.truncated = true; return; }
        p.events.push({ at: Date.now(), timeStamp: event.timeStamp, type: event.type,
          isTrusted: event.isTrusted, value: e.value, selectedIndex: e.selectedIndex,
          focused: document.activeElement === e });
      };
      globalThis[${boundary}] = p;
      for (const type of ['input', 'change']) e.addEventListener(type, p.listener, true);
    })()`,
      1000,
    );
    await snapshot("before-readiness");
    await d.wait(
      async () => {
        const shown = await d.page.evaluate<string>(`(() => { ${control}
          if (globalThis[${boundary}]?.element !== e) throw new Error('Audio in changed element');
          return e.value;
        })()`);
        return shown !== "nl" && shown === (await d.read("preferences.get")).audioLanguage;
      },
      10_000,
      "Settings showing the saved Audio in",
    );
    d.actions.push({ at: new Date().toISOString(), action: "Focus Restore Audio in" });
    await d.page.evaluate(`(() => { ${control} e.focus(); })()`);
    await d.wait(
      () =>
        d.page.evaluate<boolean>(`document.activeElement === document.querySelector(${selector})`),
      10_000,
      "Restore Audio in focus",
    );
    // Read public state first, then the current element/options immediately before input, so
    // mount refresh cannot leave us validating an earlier option list before sending N.
    const focused = await snapshot("focused-before-key");
    const dom = focused?.dom;
    if (
      !dom ||
      dom.controls !== 1 ||
      dom.disabled ||
      dom.multiple ||
      !dom.sameTarget ||
      !dom.connected ||
      !dom.focused ||
      dom.value === "nl" ||
      dom.value !== focused.publicAudio ||
      focused.events.length !== 0 ||
      focused.truncated
    )
      throw new Error("Restore Audio in lost its ready, observed and focused select");
    const enabled = dom.options.filter((o) => !o.disabled);
    const target = enabled.filter((o) => o.value === "nl");
    const prefix = enabled.filter((o) => o.label.toLowerCase().startsWith("n"));
    if (
      target.length !== 1 ||
      target[0]?.label !== "Nederlands" ||
      prefix.length !== 1 ||
      prefix[0] !== target[0]
    )
      throw new Error("N does not uniquely identify enabled Nederlands/nl");
    d.actions.push({ at: new Date().toISOString(), action: "Restore Audio in: N" });
    for (const type of ["keyDown", "keyUp"]) {
      const key: AudioEvidence["keys"][number] = { at: Date.now(), type, key: "N" };
      // Keep the request time even if CDP fails to acknowledge the command.
      trace.keys.push(key);
      const reply = await d.page.send("Input.dispatchKeyEvent", {
        type,
        key: "N",
        code: "KeyN",
        windowsVirtualKeyCode: 78,
        ...(type === "keyDown" ? { text: "N" } : {}),
      });
      key.completedAt = Date.now();
      if (reply.error) throw new Error(`Restore Audio in ${type}: ${String(reply.error)}`);
    }
    const tab: AudioEvidence["keys"][number] = { at: Date.now(), type: "press", key: "Tab" };
    trace.keys.push(tab);
    await d.key("Tab", 9);
    tab.completedAt = Date.now();
    await snapshot("post-input");
    await d.wait(
      () => d.page.evaluate<boolean>(`document.querySelector(${selector})?.value === 'nl'`),
      10_000,
      "Restore Audio in nl",
    );
    await d.wait(
      async () => (await d.read("preferences.get")).audioLanguage === "nl",
      10_000,
      "the original saved audio preference",
    );
  } catch (error) {
    failed = true;
    primaryError = error;
    trace.error = errorText(error);
  } finally {
    await snapshot(failed ? "restore-failure" : "post-public-ack");
    // Save before listener/app cleanup, even when the original public acknowledgement failed.
    try {
      await writeEvidence(trace);
    } catch (error) {
      trace.diagnosticErrors.push(`write evidence: ${errorText(error)}`);
    }
    try {
      await d.page.evaluate(
        `(() => {
        const p = globalThis[${boundary}];
        if (!p) return;
        for (const type of ['input', 'change']) p.element.removeEventListener(type, p.listener, true);
        delete globalThis[${boundary}];
      })()`,
        1000,
      );
    } catch (error) {
      trace.diagnosticErrors.push(`remove listeners: ${errorText(error)}`);
      try {
        await writeEvidence(trace);
      } catch (writeError) {
        trace.diagnosticErrors.push(`write cleanup evidence: ${errorText(writeError)}`);
      }
    }
  }
  if (failed) throw primaryError;
  if (trace.diagnosticErrors.length)
    throw new Error(`Restore Audio in evidence incomplete: ${trace.diagnosticErrors.join("; ")}`);
}
