import { type Observed, type ProofCase } from "../cases.ts";

export const cases: readonly ProofCase[] = [
  {
    name: "runtime globals",
    compare: "record",
    run: () => {
      const has = (value: unknown) => typeof value !== "undefined";
      const zone = (() => {
        try {
          return new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
          }).format(0);
        } catch (error) {
          return error instanceof Error ? error.name : "failed";
        }
      })();
      const scope = globalThis as Record<string, unknown>;
      const crypto = scope["crypto"] as { randomUUID?: unknown; subtle?: unknown } | undefined;
      return {
        Buffer: has(scope["Buffer"]),
        TextEncoder: has(scope["TextEncoder"]),
        TextDecoder: has(scope["TextDecoder"]),
        ReadableStream: has(scope["ReadableStream"]),
        structuredClone: has(scope["structuredClone"]),
        setImmediate: has(scope["setImmediate"]),
        cryptoRandomUUID: has(crypto?.randomUUID),
        cryptoSubtle: has(crypto?.subtle),
        AbortSignalTimeout: "timeout" in AbortSignal,
        AbortSignalAny: "any" in AbortSignal,
        PromiseWithResolvers: typeof Promise.withResolvers === "function",
        MapGroupBy: typeof Map.groupBy === "function",
        ArrayToSorted: typeof Array.prototype.toSorted === "function",
        IntlDisplayNames: has(Intl.DisplayNames),
        IntlListFormat: has(Intl.ListFormat),
        IntlPluralRules: has(Intl.PluralRules),
        IntlLocale: has(Intl.Locale),
        IntlCollator: has(Intl.Collator),
        timeZoneKolkataMidnightUtc: zone,
        normalizeNfd: "é".normalize("NFD").length,
      };
    },
  },
  {
    name: "URL: WHATWG parsing the shared rules rely on",
    compare: "same",
    run: () => {
      const attempt = (make: () => URL): Observed => {
        try {
          const url = make();
          return [url.href, url.origin, url.pathname, url.search, url.username, url.password];
        } catch (error) {
          return error instanceof Error ? error.name : "failed";
        }
      };
      const statics = URL as unknown as Record<string, unknown>;
      return {
        canParse: typeof statics["canParse"] === "function",
        parse: typeof statics["parse"] === "function",
        relative: attempt(() => new URL("../ok?a=1", "http://line.test:8080/live/user/pass/1.ts")),
        absolutePath: attempt(() => new URL("/ok", "https://line.test/player_api.php?x=1")),
        otherHost: attempt(() => new URL("http://cdn.test/a b", "https://line.test/")),
        credentials: attempt(() => new URL("http://us%40er:p%3Ass@line.test:80/get.php")),
        uppercase: attempt(() => new URL("HTTP://LINE.Test/Path")),
        notAUrl: attempt(() => new URL("line.test without scheme")),
        rtmp: attempt(() => new URL("rtmp://echo.test/live")),
        params: (() => {
          const url = new URL("http://line.test/get.php?username=a%20b&password=x%26y");
          return [url.searchParams.get("username"), url.searchParams.get("password")];
        })(),
      };
    },
  },
];
