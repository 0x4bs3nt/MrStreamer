// @vitest-environment happy-dom
import * as React from "react";
import { describe, expect, it } from "vitest";

// A screen's read answers only the request it was made for: once the viewer picks another
// version or season, nothing of the earlier answer shows, from the very next render, until the
// new request answers. Run with React DOM; the tests resolve React and React DOM from the
// desktop's install (vitest.config.ts), so the hook and the renderer share one React.

/** The app's own types have no React DOM; the tests resolve it from the desktop's install. */
const REACT_DOM = "react-dom/client";

type Root = { render(node: unknown): void; unmount(): void };
/** happy-dom's document; the app's own types have no DOM. */
const { document } = globalThis as unknown as {
  document: { createElement(tag: string): object };
};
const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: object): Root;
};
const { useRead } = await import("../src/read.ts");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Answers held by request, released by the test. */
const answers = new Map<string, (value: string) => void>();
const readOf = (key: string) => () => new Promise<string>((resolve) => answers.set(key, resolve));

/** Each render's view of the read: what the screen would act on. */
const seen: string[] = [];
function Probe({ request, again }: { request: string; again: number }) {
  const read = React.useMemo(() => readOf(request), [request]);
  const loaded = useRead(request, read, again);
  seen.push(`${request}:${loaded.kind === "ready" ? loaded.value : loaded.kind}`);
  return null;
}

async function mount() {
  const root = createRoot(document.createElement("div"));
  const show = (request: string, again = 0) =>
    React.act(() => root.render(React.createElement(Probe, { request, again })));
  const release = (key: string, value: string) => React.act(async () => answers.get(key)?.(value));
  return { show, release, root };
}

describe("a read keyed by its request", () => {
  it("shows the new request as loading at once, never the earlier answer", async () => {
    seen.length = 0;
    const { show, release, root } = await mount();
    await show("version-a");
    await release("version-a", "A details");
    await show("version-b");
    expect(seen.filter((each) => each.startsWith("version-b"))).not.toContain(
      "version-b:A details",
    );
    expect(seen.at(-1)).toBe("version-b:loading");
    await release("version-b", "B details");
    expect(seen.at(-1)).toBe("version-b:B details");
    root.unmount();
  });

  it("drops an answer that arrives after its request was replaced", async () => {
    seen.length = 0;
    const { show, release, root } = await mount();
    await show("season-1");
    await show("season-2");
    await release("season-1", "season 1 rows");
    expect(seen.at(-1)).toBe("season-2:loading");
    await release("season-2", "season 2 rows");
    expect(seen.at(-1)).toBe("season-2:season 2 rows");
    root.unmount();
  });

  it("keeps the answer while the same request is read again", async () => {
    seen.length = 0;
    const { show, release, root } = await mount();
    await show("version-a");
    await release("version-a", "first");
    await show("version-a", 1);
    expect(seen.at(-1)).toBe("version-a:first");
    await release("version-a", "second");
    expect(seen.at(-1)).toBe("version-a:second");
    root.unmount();
  });
});
