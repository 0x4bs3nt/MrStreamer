import type { LiveCatalogue } from "@mrstreamer/core/provider";
import { describe, expect, it, vi } from "vitest";
import { buildLibrary, combineSteps, inTasks, partSteps, type LiveSource } from "../src/library.ts";

// Large channel lists worked out a few slices per task, as the account owner does on iOS: other
// work runs between the tasks, the channels come out as buildLibrary shows them at once, and the
// work stops when it is no longer wanted.

/** A panel's list: channels by country and quality, some for adults, some in no category. */
function catalogue(count: number, offset: number): LiveCatalogue {
  const countries = ["NL", "BE", "UK", "DE"];
  const categories = [
    ...countries.flatMap((code) => [
      { id: `${code}-news`, name: `${code} | News` },
      { id: `${code}-sport`, name: `${code} | Sport HD` },
    ]),
    { id: "adult", name: "XXX Adults" },
  ];
  const channels = Array.from({ length: count }, (_, at) => {
    // Each channel in three qualities, one after another.
    const n = Math.floor((at + offset) / 3);
    const code = countries[n % countries.length] ?? "NL";
    const quality = ["FHD", "HD", "SD"][at % 3];
    return {
      id: String(at + 1),
      name: `${code} | Channel ${n} ${quality}`,
      number: null,
      logoUrl: null,
      categoryIds:
        n % 97 === 0 ? [] : n % 89 === 0 ? ["adult"] : [`${code}-${n % 2 ? "news" : "sport"}`],
      guideId: at % 5 === 0 ? `Channel${n}.${code.toLowerCase()}` : null,
      adult: at % 211 === 0,
      catchupDays: null,
    };
  });
  return { categories, channels };
}

const home: LiveSource = { subscriptionId: "a", label: "Home", catalogue: catalogue(3000, 0) };
// The second lists some of the first's channels under the same names.
const cabin: LiveSource = { subscriptionId: "b", label: "Cabin", catalogue: catalogue(1500, 1200) };
const sources = [home, cabin];

/** Competing input tasks during work whose scheduler clock advances independently of host speed. */
async function alongside<A>(work: () => Promise<A>): Promise<{ result: A; tasks: number }> {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => ++now);
  let tasks = 0;
  let timer = setTimeout(function task() {
    tasks += 1;
    timer = setTimeout(task, 0);
  }, 0);
  try {
    return { result: await work(), tasks };
  } finally {
    clearTimeout(timer);
    clock.mockRestore();
  }
}

/** Every part worked out in tasks, then joined in tasks, as the account owner does. */
async function libraryInTasks(of: readonly LiveSource[]) {
  const parts = [];
  for (const source of of) {
    const part = await inTasks(partSteps(source), () => true);
    if (!part) throw new Error("Stopped");
    parts.push({ label: source.label, part });
  }
  return inTasks(combineSteps(parts), () => true);
}

/** One name listed `count` times in one category, each stream under `guideId`. */
const listedOften = (name: string, guideId: string | null, count: number): LiveCatalogue => ({
  categories: [{ id: "1", name: "NL | Events" }],
  channels: Array.from({ length: count }, (_, at) => ({
    id: String(at + 1),
    name,
    number: null,
    logoUrl: null,
    categoryIds: ["1"],
    guideId,
    adult: false,
    catchupDays: null,
  })),
});

describe("a library worked out in tasks", () => {
  it("lets other tasks run between its slices, and shows what buildLibrary shows", async () => {
    const { result, tasks } = await alongside(() => libraryInTasks(sources));
    expect(tasks).toBeGreaterThan(2);
    const library = buildLibrary(sources);
    expect(result).toEqual(library);
    // What the two-provider list holds, so the comparison above covers each rule.
    const channels = library.regions.flatMap((region) => region.channels);
    expect(channels.some((each) => each.ambiguous)).toBe(true);
    expect(channels.some((each) => each.variants.length > 1)).toBe(true);
    expect(library.regions.at(-1)?.name).toBe("Other channels");
    expect([...library.placeOf.values()].some((place) => place.endsWith(" · Cabin"))).toBe(true);
  });

  it("shows a channel listed hundreds of times, and names under one placeholder guide id, as buildLibrary does", async () => {
    const often: LiveSource[] = [
      {
        subscriptionId: "a",
        label: "Home",
        catalogue: listedOften("Event Offline HD", null, 600),
      },
      {
        subscriptionId: "b",
        label: "Cabin",
        catalogue: listedOften("NL | Event Offline HD", "placeholder.tv", 600),
      },
    ];
    const { result, tasks } = await alongside(() => libraryInTasks(often));
    expect(tasks).toBeGreaterThan(2);
    expect(result).toEqual(buildLibrary(often));
  });

  it("stops, unfinished, once it is no longer wanted", async () => {
    let wanted = true;
    const working = inTasks(partSteps(home), () => wanted);
    setTimeout(() => (wanted = false), 0);
    expect(await working).toBeNull();
  });
});
