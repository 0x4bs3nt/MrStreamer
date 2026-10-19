import { Slider } from "@base-ui/react/slider";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { media } from "./e2e/installed-media.ts";

it("observes unrounded public Position seconds from the shipped Slider's native input", async () => {
  const window = new Window();
  try {
    const slider = (label: string, value: number) =>
      createElement(
        Slider.Root,
        { value, min: 0, max: 180, step: 1 },
        createElement(
          Slider.Control,
          null,
          createElement(
            Slider.Track,
            null,
            createElement(Slider.Indicator),
            createElement(Slider.Thumb, { "aria-label": label }),
          ),
        ),
      );
    // Another Position slider outside the title and a Sound slider cannot supply this value.
    window.document.body.innerHTML = renderToStaticMarkup(
      createElement(
        "main",
        null,
        slider("Position", 88),
        createElement(
          "section",
          { "data-view": "title" },
          slider("Sound", 40),
          slider("Position", 11.25),
        ),
      ),
    );
    const page = {
      async evaluate<T>(expression: string): Promise<T> {
        return runInNewContext(expression, { document: window.document, window }) as T;
      },
    };
    expect((await media({ page })).position).toBe(11.25);
    window.document.querySelector("[data-view=title] input[aria-label=Position]")!.remove();
    expect((await media({ page })).position).toBeNull();
  } finally {
    await window.happyDOM.close();
  }
});
