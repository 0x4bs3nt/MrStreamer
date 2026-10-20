import { writeFile } from "node:fs/promises";
import { app, dialog, type BrowserWindow } from "electron";
import { Failed } from "@mrstreamer/core/failure";
import { t } from "@mrstreamer/core/i18n";
import type { DiagnosticsExporter } from "../platform/diagnostics-export.ts";
import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Licences } from "../services/licences.ts";

export function aboutHandlers({
  licences,
  exporter,
  window,
}: {
  readonly licences: Licences["Service"];
  readonly exporter: DiagnosticsExporter;
  readonly window: () => BrowserWindow | null;
}): HandlersFor<"diagnostics" | "licences"> {
  return {
    "diagnostics.preview": () =>
      Effect.tryPromise({
        try: () => exporter.preview(),
        catch: () =>
          new Failed({
            error: { kind: "unexpected", detail: t("Diagnostics could not be read.") },
          }),
      }),
    "diagnostics.save": ({ id }) =>
      Effect.tryPromise({
        try: async () => {
          const text = exporter.textOf(id);
          if (text === null) throw new Error("The preview has expired.");
          const parent = window();
          if (!parent) return false;
          // In the interface language: what the system draws around it follows the system's.
          const selected = await dialog.showSaveDialog(parent, {
            title: t("Save diagnostics"),
            buttonLabel: t("Save"),
            defaultPath: `diagnostics-${app.getVersion()}-${new Date().toISOString().slice(0, 10)}.txt`,
            filters: [{ name: t("Text"), extensions: ["txt"] }],
            properties: ["showOverwriteConfirmation"],
          });
          if (selected.canceled || !selected.filePath) return false;
          await writeFile(selected.filePath, text, "utf8");
          return true;
        },
        catch: () =>
          new Failed({
            error: {
              kind: "unexpected",
              detail: t("Diagnostics could not be saved. Try again."),
            },
          }),
      }),
    "licences.list": () => licences.list,
    "licences.text": ({ id }) => licences.text(id),
  };
}
