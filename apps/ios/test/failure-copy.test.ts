import { describe, expect, it } from "vitest";
import { failureOf } from "../src/errors.ts";

// What Connect, Live and Home say when the provider fails: the provider by its host alone, what
// happened and what to do. Status codes and the system's own words stay off the screen.

describe("failureOf", () => {
  it("names the provider by its host, without scheme, port or path", () => {
    const failure = failureOf(
      {
        kind: "unreachable",
        server: "http://tv.example.net:8080/",
        detail: "ECONNREFUSED 10.0.0.1",
      },
      "http://typed.example:80",
    );
    expect(failure).toEqual({
      headline: "Couldn't reach tv.example.net",
      advice: "Check the address and that your iPhone is online.",
    });
  });

  it("leaves a provider's HTTP status off the screen", () => {
    const failure = failureOf({ kind: "provider-error", status: 503 }, "https://tv.example.net");
    expect(failure.headline).toBe("tv.example.net isn't answering");
    expect(JSON.stringify(failure)).not.toContain("503");
  });

  it("dates an expired subscription and says where to renew it", () => {
    const failure = failureOf(
      { kind: "account-inactive", state: "expired", expiresAt: "2026-10-02T00:00:00Z" },
      "http://tv.example.net",
    );
    expect(failure.headline).toMatch(/^This subscription expired on .*2026/);
    expect(failure.advice).toBe("Renew it with tv.example.net, then try again.");
  });

  it("keeps an incomplete login's own sentence, with nothing to add", () => {
    expect(failureOf({ kind: "incomplete-login", detail: "Add the server address." }, "")).toEqual({
      headline: "Add the server address.",
      advice: null,
    });
  });
});
