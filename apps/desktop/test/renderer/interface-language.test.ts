// @vitest-environment happy-dom
// Settings > General's Interface language: System default names what it follows, each language is
// listed by its own name, and a pick shows the window's text in it at once, while titles, sound
// and subtitles keep their own languages.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InterfaceLanguage } from "@mrstreamer/contracts/language";
import { setLanguage } from "@mrstreamer/core/i18n";
import { GeneralSection } from "../../src/renderer/src/features/settings/GeneralSection.tsx";
import { useLocale } from "../../src/renderer/src/app/language.ts";

const english: InterfaceLanguage = {
  choice: "system",
  system: "en-US",
  locale: "en-US",
  formats: "en-US",
};
const german: InterfaceLanguage = {
  choice: "de-DE",
  system: "en-US",
  locale: "de-DE",
  formats: "de-DE",
};

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  setLanguage(english);
  document.documentElement.lang = "en";
  vi.useRealTimers();
});

/** Lets React Query tell the section what a query or mutation answered. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));

/** General as the window shows it, under a root that renders again with the language. */
async function render() {
  ipc.reset();
  ipc.prefer({ titleLanguage: "nl", audioLanguage: "original", subtitleLanguage: "en" });
  ipc.always("language.get", english);
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = new QueryClient();
  function Root() {
    useLocale();
    return createElement(QueryClientProvider, { client }, createElement(GeneralSection));
  }
  await act(async () => root.render(createElement(Root)));
  await settle();
  unmount = () => act(() => root.unmount());
  const select = () => container.querySelector<HTMLSelectElement>("section select");
  return { container, select };
}

describe("Interface language", () => {
  it("lists System default with what it follows, then each language by its own name", async () => {
    const { select } = await render();
    const options = [...(select()?.options ?? [])];
    expect(select()?.getAttribute("aria-label")).toBe("Interface language");
    expect(select()?.value).toBe("system");
    expect(options.map((option) => option.textContent)).toEqual([
      "System default (English)",
      "English",
      "Nederlands",
      "Français",
      "Deutsch",
      "Español",
    ]);
    expect(options.slice(1).map((option) => option.lang)).toEqual([
      "en-US",
      "nl-NL",
      "fr-FR",
      "de-DE",
      "es-ES",
    ]);
  });

  it("shows the window in the language picked, and changes no other language", async () => {
    const { container, select } = await render();
    const saving = ipc.hold("language.set");
    await act(async () => {
      const field = select();
      if (!field) throw new Error("No Interface language");
      field.value = "de-DE";
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(ipc.argsOf("language.set")).toEqual([{ choice: "de-DE" }]);
    await act(async () => saving.resolve(german));
    await settle();

    expect(document.documentElement.lang).toBe("de-DE");
    expect(select()?.getAttribute("aria-label")).toBe("Sprache der Oberfläche");
    expect([...container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Allgemein",
    ]);
    expect(ipc.methods()).not.toContain("preferences.update");
  });
});
