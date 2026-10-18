import { describe, expect, it } from "vitest";
import { matchRanges, searchWords } from "../src/text.ts";

/** What a search for `query` marks in `text`. */
const marked = (text: string, query: string) =>
  matchRanges(text, searchWords(query)).map(([start, end]) => text.slice(start, end));

describe("what a search marks in a name", () => {
  it("marks each word where it shows, whatever the case, the accents and how they are written", () => {
    expect(marked("BBC News at Six", "news")).toEqual(["News"]);
    expect(marked("Euronews", "NEWS")).toEqual(["news"]);
    expect(marked("Één: Het Journaal", "een journ")).toEqual(["Één", "Journ"]);
    // An accent written as a character of its own belongs to its letter.
    expect(marked("Café Noir", "cafe")).toEqual(["Café"]);
    expect(marked("News, news & more News", "news")).toEqual(["News", "news", "News"]);
  });

  it("marks words that run into each other once, and nothing unless every word shows", () => {
    expect(marked("Sportsnight", "sports sport night")).toEqual(["Sportsnight"]);
    expect(marked("BBC News at Six", "bbc ten")).toEqual([]);
    expect(marked("BBC News at Six", "  ")).toEqual([]);
  });
});

it("marks joined apostrophe and hyphen matches using the actual displayed span", () => {
  expect(marked("Spider-Man", "spiderman")).toEqual(["Spider-Man"]);
  expect(marked("Spiderman / Spider-Man", "spiderman")).toEqual(["Spiderman", "Spider-Man"]);
  expect(marked("O’Brien", "obrien")).toEqual(["O’Brien"]);
  expect(marked("Spider Man", "spiderman")).toEqual([]);
  expect(marked("Café-Noir", "cafenoir")).toEqual(["Café-Noir"]);
  expect(marked("Café-Noir", "cafenoir")).toEqual(["Café-Noir"]);
});
