import { describe, expect, it } from "vitest";
import { xtreamProvider } from "../src/main/providers/xtream.ts";

// Scalar string IDs and numeric arrays are documented at the pinned source in
// docs/user/category-compatibility.md. The malformed/duplicate cases are defensive fixtures.
describe("Xtream category memberships", () => {
  it("uses the same raw membership rules for live, movies and series", async () => {
    const memberships = [
      { category_id: "001" },
      { category_id: 2 },
      { category_id: "001", category_ids: [2, "2", "001", "", 99] },
      { category_id: "001", category_ids: [] },
      { category_id: "001", category_ids: [""] },
      { category_id: null, category_ids: null },
      {},
    ];
    const categories = [
      { category_id: "001", category_name: "News" },
      { category_id: 2, category_name: "News" },
      { category_id: 3, category_name: "" },
    ];
    const provider = xtreamProvider(
      { server: "https://panel.test", username: "fixture", password: "fixture" },
      {
        userAgent: "fixture",
        fetch: async (input) => {
          const action = new URL(String(input)).searchParams.get("action") ?? "";
          return Response.json(
            action.endsWith("categories")
              ? categories
              : memberships.map((membership, index) => ({
                  stream_id: String(index + 10),
                  series_id: index + 10,
                  name: `Entry ${index}`,
                  ...membership,
                })),
          );
        },
      },
    );
    const live = await provider.liveCatalogue();
    const titles = await provider.onDemandCatalogue();
    const expected = [["001"], ["2"], ["2", "001", "99"], ["001"], [], [], []];
    expect(live.channels.map((channel) => channel.categoryIds)).toEqual(expected);
    expect(titles.movies.map((movie) => movie.categoryIds)).toEqual(expected);
    expect(titles.series.map((series) => series.categoryIds)).toEqual(expected);
    expect(live.channels.map((channel) => channel.id)).toEqual([
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
    ]);
    expect(live.categories).toEqual([
      { id: "001", name: "News" },
      { id: "2", name: "News" },
      { id: "3", name: "Category 3" },
    ]);
    expect(titles.movieCategories).toEqual(live.categories);
    expect(titles.seriesCategories).toEqual(live.categories);
  });
});
