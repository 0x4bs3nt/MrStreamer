// What the window calls a guide of Settings > Guides: its name, else its host, and as much of its
// id as tells it from another that would read alike, the same whatever their order.
import { describe, expect, it } from "vitest";
import { guideName, guideNames } from "../../src/renderer/src/lib/guide-names.ts";

const host = "https://epg.example.net";
const source = (id: string, label: string | null = null, origin = host) => ({ id, origin, label });

describe("guide names", () => {
  it("adds to a tag only while two still share it, and only for those two", () => {
    const sources = [
      source("3f9a0c11-0000-4000-8000-000000000001"),
      source("3f9a0d22-0000-4000-8000-000000000002"),
      source("c0712b44-0000-4000-8000-000000000003"),
      source("77777777-0000-4000-8000-000000000004", null, "https://other.example"),
    ];

    expect([...guideNames(sources).values()]).toEqual([
      "epg.example.net 3f9a0c",
      "epg.example.net 3f9a0d",
      "epg.example.net c071",
      "other.example",
    ]);
    expect(guideNames(sources.toReversed()).get(sources[0]?.id ?? "")).toBe(
      "epg.example.net 3f9a0c",
    );
  });

  it("tags a guide not yet listed among those that are", () => {
    const listed = [source("3f9a0c11-0000-4000-8000-000000000001", "Netherlands")];

    expect(guideName(source("c0712b44-0000-4000-8000-000000000003", "netherlands"), listed)).toBe(
      "netherlands c071",
    );
    expect(guideName(source("c0712b44-0000-4000-8000-000000000003"), listed)).toBe(
      "epg.example.net",
    );
  });
});
