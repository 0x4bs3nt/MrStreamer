import { request as httpRequest } from "node:http";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import { liveChannels } from "@mrstreamer/core/catalogue/variants";
import { xmltvReader, type XmltvProgramme } from "@mrstreamer/core/guide/xmltv";
import { CHANNEL } from "../src/catalogue.ts";
import { EPOCH } from "../src/timeline.ts";
import { digest, fixture, FIXTURE_NOW, FIXTURE_ORIGIN, PASSWORD, USER } from "./fixture.ts";

let runtime: Miniflare;
let origin: string;
let data: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  data = await fixture();
  const output = await build({
    absWorkingDir: fileURLToPath(new NodeURL("..", import.meta.url)),
    entryPoints: ["test/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    // Only the unused production entry imports measured data. Tests inject the
    // explicit NON-MEDIA index and never need a private preparation stage.
    external: ["../generated/media.json"],
  });
  const script = output.outputFiles[0]?.text;
  if (!script) throw new Error("Missing local worker bundle");
  runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    host: "127.0.0.1",
    port: 0,
    cf: false,
    r2Buckets: ["MEDIA"],
    bindings: { PUBLIC_ORIGIN: FIXTURE_ORIGIN },
    log: new Log(LogLevel.NONE),
  });
  origin = (await runtime.ready).origin;
  const bucket = await runtime.getR2Bucket("MEDIA");
  for (const [key, value] of data.objects) await bucket.put(key, new Uint8Array(value).buffer);
});
afterAll(async () => {
  await runtime?.dispose();
});

function clockFetch(now = FIXTURE_NOW, extra: Readonly<Record<string, string>> = {}): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-Fixture-Clock", String(now));
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return fetch(input, { ...init, headers });
  };
}
function provider(now = FIXTURE_NOW) {
  return xtreamProvider(
    { server: origin, username: USER, password: PASSWORD },
    { userAgent: "MrStreamer/local-service-contract", live: "hls", fetch: clockFetch(now) },
  );
}
const credentials = () => new URLSearchParams({ username: USER, password: PASSWORD });
const live = (tail = `${CHANNEL.id}.m3u8`, password = PASSWORD) =>
  `/live/${USER}/${password}/${tail}`;
const movie = (password = PASSWORD) => `/movie/${USER}/${password}/movie.mp4`;
async function get(path: string, init: RequestInit = {}, now = FIXTURE_NOW) {
  return clockFetch(now)(origin + path, init);
}

// Native HTTP transport without automatic decompression. This is local workerd
// wire evidence, never a claim about a Cloudflare-deployed endpoint.
function raw(path: string, method = "GET", headers: Readonly<Record<string, string>> = {}) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>((resolve, reject) => {
    const request = httpRequest(
      new NodeURL(path, origin),
      {
        method,
        headers: { "X-Fixture-Clock": String(FIXTURE_NOW), ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("aborted", () => reject(new Error("Local transfer aborted")));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.setTimeout(7000, () => request.destroy(new Error("Local HTTP deadline")));
    request.end();
  });
}

describe("normal Xtream review contract", () => {
  it("feeds the real Provider auth, catalogue, grouping, details, files and native GuideRequest", async () => {
    const p = provider();
    expect(await p.authenticate()).toEqual({
      state: "active",
      expiresAt: null,
      maxConnections: null,
      activeConnections: null,
    });
    const list = await p.liveCatalogue();
    const grouped = liveChannels(normalizeCatalogue(list).streams);
    expect(list.channels).toMatchObject([
      { id: CHANNEL.id, guideId: CHANNEL.guideId, categoryIds: ["sample-live"], catchupDays: null },
    ]);
    expect(grouped.channels).toHaveLength(1);
    expect([...grouped.guideIds.values()]).toEqual([[CHANNEL.guideId]]);
    const titles = await p.onDemandCatalogue();
    expect(titles.movies).toMatchObject([
      { id: "movie", name: "Generated sample movie", container: "mp4", tmdbId: null, rating: null },
    ]);
    expect(titles.series).toMatchObject([
      { id: "series", container: null, tmdbId: null, releaseDate: null },
    ]);
    const film = await p.movieDetails("movie");
    expect(film).toMatchObject({
      duration: 150,
      container: "mp4",
      cast: [],
      directors: [],
      releaseDate: null,
    });
    const series = await p.seriesDetails("series");
    expect(series.duration).toBeNull();
    expect(series.episodes.map((e) => [e.id, e.season, e.number, e.duration, e.container])).toEqual(
      [
        ["episode-1", 1, 1, 90, "mp4"],
        ["episode-2", 1, 2, 90, "mp4"],
      ],
    );
    const file = await p.titleFile("episode", "episode-1", "mp4");
    expect(file.container).toBe("mp4");
    const answer = await p.request(file.url);
    expect(await answer.text()).toContain("NON-MEDIA HTTP fixture episode-1");
    const descriptor = await p.liveGuideRequest?.();
    expect(descriptor).toMatchObject({ kind: "request", headers: { Accept: "application/xml" } });
    const guide = await p.liveGuide();
    if (guide.kind !== "document") throw new Error("Expected real XMLTV body");
    const programmes: XmltvProgramme[] = [];
    const channels: string[] = [];
    const reader = xmltvReader(
      { programme: (row) => programmes.push(row), channel: (row) => channels.push(row.id) },
      16_384,
    );
    for await (const bytes of guide.body) reader.push(bytes);
    expect(reader.end()).toBe("whole");
    expect(channels).toEqual([CHANNEL.guideId]);
    expect(
      programmes.some(
        (row) =>
          row.channel === CHANNEL.guideId &&
          row.start <= FIXTURE_NOW &&
          (row.stop ?? 0) > FIXTURE_NOW,
      ),
    ).toBe(true);
  });

  it.each(["", "wrong_fixture_password"])(
    "refuses known and unknown private resources before R2 access with %s",
    async (bad) => {
      const paths = [
        `/player_api.php?username=${USER}&password=${bad}`,
        `/player_api.php?username=${USER}&password=${bad}&action=unknown_action`,
        `/player_api.php?username=${USER}&password=${bad}&action=get_vod_info&vod_id=unknown`,
        `/xmltv.php?username=${USER}&password=${bad}`,
        live(`${CHANNEL.id}.m3u8`, bad || "missing_fixture"),
        live("unknown.m3u8", bad || "missing_fixture"),
        live(`${CHANNEL.id}/bad-release/unknown.m3u8`, bad || "missing_fixture"),
        movie(bad || "missing_fixture"),
        `/series/${USER}/${bad || "missing_fixture"}/unknown.mp4`,
      ];
      for (const path of paths)
        for (const method of ["GET", "HEAD"]) {
          const answer = await get(path, { method, headers: { "X-Fixture-No-Bucket": "1" } });
          expect(answer.status).toBe(401);
          expect(answer.headers.get("cache-control")).toBe("private, no-store");
          expect(answer.headers.get("location")).toBeNull();
          const body = await answer.text();
          expect(body).not.toContain(PASSWORD);
        }
      expect((await get(movie(), { headers: { "X-Fixture-No-Bucket": "1" } })).status).toBe(503);
    },
  );

  it("rejects missing secret configuration and preserves coordinated password rotation", async () => {
    const path = `/player_api.php?${credentials()}`;
    expect((await get(path, { headers: { "X-Fixture-Login": "{}" } })).status).toBe(503);
    const currentHash = await digest("new_nonsecret_fixture_password");
    const oldHash = await digest(PASSWORD);
    const active = JSON.stringify({
      username: USER,
      passwordSha256: currentHash,
      retiring: { passwordSha256: oldHash, retireAfterUtc: null },
    });
    expect((await get(path, { headers: { "X-Fixture-Login": active } })).status).toBe(200);
    const retired = JSON.stringify({
      username: USER,
      passwordSha256: currentHash,
      retiring: { passwordSha256: oldHash, retireAfterUtc: new Date(FIXTURE_NOW).toISOString() },
    });
    for (const endpoint of [path, movie(), live()])
      expect((await get(endpoint, { headers: { "X-Fixture-Login": retired } })).status).toBe(401);
    expect(
      (
        await get(`/player_api.php?username=${USER}&password=new_nonsecret_fixture_password`, {
          headers: { "X-Fixture-Login": retired },
        })
      ).status,
    ).toBe(200);
  });

  const refusedRequests: readonly (readonly [() => string, number])[] = [
    [(): string => `/player_api.php?${credentials()}&action=unknown_action`, 400],
    [(): string => `/player_api.php?${credentials()}&action=get_vod_info&vod_id=missing`, 404],
    [
      (): string => `/player_api.php?${credentials()}&action=get_series_info&series_id=missing`,
      404,
    ],
    [(): string => movie().replace("movie.mp4", "missing.mp4"), 404],
    [(): string => `/series/${USER}/${PASSWORD}/series.mp4`, 404],
    [(): string => live(`${CHANNEL.id}.ts`), 404],
    [(): string => live(`${CHANNEL.id}/unknown/540p.m3u8`), 404],
    [(): string => live(`${CHANNEL.id}/${data.media.release}/180p/-1.ts`), 404],
    [(): string => live(`${CHANNEL.id}/${data.media.release}/180p/99999999999999999999.ts`), 404],
    [(): string => `/player_api.php?${credentials()}&password=duplicate`, 400],
    [(): string => movie() + "?username=override", 400],
    [(): string => `/movie/${USER}/${PASSWORD}/evil%2Fmovie.mp4`, 400],
    [(): string => `/movie/${USER}/${PASSWORD}/%252e%252e`, 400],
    [() => "/art/unknown.png", 404],
    [() => "/public/movie.mp4", 404],
  ];
  it.each(refusedRequests)(
    "refuses unsupported/malformed resources through HTTP",
    async (path, status) => {
      expect((await get(path())).status).toBe(status);
    },
  );

  it("keeps exactly four original artwork routes public and never exposes storage or writes", async () => {
    for (const id of data.artworkIds) {
      const answer = await get(`/art/${id}.png`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("content-type")).toBe("image/png");
      expect(await answer.text()).toContain("NON-MEDIA HTTP fixture");
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      const answer = await get(movie(), { method });
      expect(answer.status).toBe(405);
      expect(answer.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("keeps real Provider guide failures as failures, never invented success", async () => {
    const offline: typeof fetch = () =>
      Promise.reject(new TypeError("Explicit fixture network outage"));
    const p = xtreamProvider(
      { server: origin, username: USER, password: PASSWORD },
      { userAgent: "nonsecret fixture", live: "hls", fetch: offline },
    );
    await expect(p.liveGuide()).rejects.toMatchObject({ error: { kind: "unreachable" } });
    const bad = xtreamProvider(
      { server: origin, username: USER, password: "bad_fixture" },
      { userAgent: "nonsecret fixture", live: "hls", fetch: clockFetch() },
    );
    await expect(bad.liveGuide()).rejects.toMatchObject({ error: { kind: "invalid-login" } });
  });
});

describe("linear clock and Guide", () => {
  function mediaRows(text: string) {
    const rows = text.trim().split("\n");
    return {
      rows,
      sequence: Number(rows.find((r) => r.startsWith("#EXT-X-MEDIA-SEQUENCE:"))?.split(":")[1]),
      ds: Number(rows.find((r) => r.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:"))?.split(":")[1]),
      segments: rows.filter((r) => !r.startsWith("#")),
      times: rows
        .filter((r) => r.startsWith("#EXT-X-PROGRAM-DATE-TIME:"))
        .map((r) => Date.parse(r.slice(25))),
    };
  }
  const mediaPath = (): string => live(`${CHANNEL.id}/${data.media.release}/540p.m3u8`);

  it("serves measured master attributes and a private relative URI graph", async () => {
    const stream = await provider().liveStream(CHANNEL.id);
    expect(stream.format).toBe("hls");
    const text = await (await provider().request(stream.url)).text();
    expect(text).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    for (const r of data.media.renditions)
      expect(text).toContain(
        `BANDWIDTH=${r.bandwidth},AVERAGE-BANDWIDTH=${r.averageBandwidth},CODECS="${r.codecs}",RESOLUTION=${r.width}x${r.height},FRAME-RATE=24.000`,
      );
    const variants = text
      .trim()
      .split("\n")
      .filter((r) => !r.startsWith("#"));
    expect(variants).toHaveLength(2);
    for (const relative of variants) {
      const url = new NodeURL(relative, stream.url);
      expect(url.origin).toBe(origin);
      expect(url.pathname).toContain(`/live/${USER}/${PASSWORD}/`);
      const body = await (await clockFetch()(url.href)).text();
      const rows = mediaRows(body);
      expect(rows.segments.length).toBeGreaterThanOrEqual(150);
      const segment = new NodeURL(rows.segments[0]!, url);
      expect((await clockFetch()(segment.href)).status).toBe(200);
    }
  });

  it("advances the UTC video clock across all seams and retains older absolute segment URIs", async () => {
    let before: ReturnType<typeof mediaRows> | undefined;
    for (const offset of [0, 6_000, 150_000, 240_000, 330_000, 990_000]) {
      const at = FIXTURE_NOW + offset;
      const current = mediaRows(await (await get(mediaPath(), {}, at)).text());
      expect(current.rows).toContain("#EXT-X-TARGETDURATION:6");
      expect(current.rows.filter((r) => r === "#EXTINF:6.000,")).toHaveLength(
        current.segments.length,
      );
      expect(current.rows.join("\n")).not.toMatch(/ENDLIST|PLAYLIST-TYPE/);
      expect(current.segments.length * 6).toBeGreaterThanOrEqual(900);
      expect(current.times[0]).toBe(EPOCH + current.sequence * 6000);
      expect(current.times.at(-1)! + 6000).toBeLessThanOrEqual(at);
      expect(current.times.at(-1)).toBe(EPOCH + (Math.floor((at - EPOCH) / 6000) - 1) * 6000);
      const remainder = current.sequence % 55;
      expect([0, 25, 40]).not.toContain(remainder);
      const m = current.sequence - 1;
      expect(current.ds).toBe(Math.floor(m / 55) * 3 + Number(m % 55 >= 25) + Number(m % 55 >= 40));
      expect(current.rows.filter((r) => r === "#EXT-X-DISCONTINUITY")).toHaveLength(
        current.segments.filter((_, i) => [0, 25, 40].includes((current.sequence + i) % 55)).length,
      );
      if (before) expect(current.sequence).toBeGreaterThanOrEqual(before.sequence);
      before = current;
    }
    const past = mediaRows(await (await get(mediaPath())).text());
    const old = new NodeURL(past.segments[0]!, origin + mediaPath()).pathname;
    const firstBytes = await (await get(old)).arrayBuffer();
    expect(await (await get(old, {}, FIXTURE_NOW + 2_000_000)).arrayBuffer()).toEqual(firstBytes);
    expect((await get(mediaPath(), {}, EPOCH + 899_999)).status).toBe(503);
  });

  it.each([
    EPOCH + 150_000,
    EPOCH + 240_000,
    EPOCH + 330_000,
    FIXTURE_NOW,
    FIXTURE_NOW + 86_400_000,
  ])("keeps exact half-open XMLTV programme intervals on the video clock", async (at) => {
    const guide = await provider(at).liveGuide();
    if (guide.kind !== "document") throw new Error("Expected guide");
    const programmes: XmltvProgramme[] = [];
    const reader = xmltvReader({ programme: (p) => programmes.push(p), channel: () => {} }, 16_384);
    for await (const chunk of guide.body) reader.push(chunk);
    expect(reader.end()).toBe("whole");
    const current = programmes.filter((p) => p.start <= at && (p.stop ?? 0) > at);
    expect(current).toHaveLength(1);
    for (const [i, row] of programmes.entries()) {
      expect(row.channel).toBe(CHANNEL.guideId);
      expect([150_000, 90_000]).toContain((row.stop ?? 0) - row.start);
      if (i) expect(row.start).toBe(programmes[i - 1]?.stop);
    }
  });
});

describe("local workerd binary and gzip transmission", () => {
  it("aborts a deliberately pending R2 transfer and admits an independent subsequent read", async () => {
    const controller = new AbortController();
    const answer = await get(movie(), {
      signal: controller.signal,
      headers: { "X-Fixture-R2-Fault": "slow" },
    });
    if (!answer.body) throw new Error("Missing stream");
    const reader = answer.body.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    await reader.cancel().catch(() => {});
    const retry = await raw(movie());
    expect(retry.status).toBe(200);
    expect(retry.body.length).toBe(data.media.originals.movie.bytes);
  });

  it("fails before headers for a missing object and never completes short/long/failed source bodies", async () => {
    expect((await raw(movie(), "GET", { "X-Fixture-R2-Fault": "missing" })).status).toBe(503);
    expect((await raw(movie(), "GET", { "X-Fixture-R2-Fault": "reject" })).status).toBe(503);
    for (const mode of ["short", "long", "error"]) {
      const outcome = await raw(movie(), "GET", { "X-Fixture-R2-Fault": mode }).then(
        (response) => ({ kind: "response" as const, response }),
        () => ({ kind: "transfer-failed" as const }),
      );
      if (outcome.kind === "response") expect(outcome.response.status).toBeGreaterThanOrEqual(500);
    }
  });

  it("preserves actual full/range Content-Length and bytes, and proves HEAD independently", async () => {
    const source = data.objects.get(data.media.originals.movie.key)!;
    const full = await raw(movie());
    expect(full.status).toBe(200);
    expect(full.headers["content-encoding"]).toBeUndefined();
    expect(Number(full.headers["content-length"])).toBe(source.length);
    expect(full.body).toEqual(Buffer.from(source));
    const head = await raw(movie(), "HEAD", { Range: "bytes=1-4" });
    expect(head.status).toBe(200);
    expect(Number(head.headers["content-length"])).toBe(source.length);
    expect(head.body.length).toBe(0);
    expect(head.headers["content-range"]).toBeUndefined();
    for (const [range, start, end] of [
      ["bytes=0-5", 0, 5],
      ["bytes=6-", 6, source.length - 1],
      ["bytes=-4", source.length - 4, source.length - 1],
    ] as const) {
      const answer = await raw(movie(), "GET", { Range: range });
      expect(answer.status).toBe(206);
      expect(answer.headers["content-range"]).toBe(`bytes ${start}-${end}/${source.length}`);
      expect(Number(answer.headers["content-length"])).toBe(end - start + 1);
      expect(answer.body).toEqual(Buffer.from(source.slice(start, end + 1)));
    }
  });

  it("refuses unsatisfiable ranges, ignores malformed/multi-range and implements If-Range", async () => {
    const size = data.media.originals.movie.bytes;
    for (const range of [`bytes=${size}-`, "bytes=-0"]) {
      const answer = await raw(movie(), "GET", { Range: range });
      expect(answer.status).toBe(416);
      expect(answer.headers["content-range"]).toBe(`bytes */${size}`);
    }
    for (const range of ["bytes=9-1", "bytes=", "bytes=0-1,4-5"])
      expect((await raw(movie(), "GET", { Range: range })).status).toBe(200);
    const etag = (await raw(movie())).headers.etag;
    if (typeof etag !== "string") throw new Error("Missing ETag");
    expect((await raw(movie(), "GET", { Range: "bytes=0-3", "If-Range": etag })).status).toBe(206);
    expect(
      (await raw(movie(), "GET", { Range: "bytes=0-3", "If-Range": '"old-fixture"' })).status,
    ).toBe(200);
  });

  it("lets workerd gzip plain playlists exactly once on the HTTP wire", async () => {
    for (const path of [live(), live(`${CHANNEL.id}/${data.media.release}/180p.m3u8`)]) {
      const answer = await raw(path, "GET", { "Accept-Encoding": "gzip" });
      expect(answer.status).toBe(200);
      expect(answer.headers["content-encoding"]).toBe("gzip");
      expect(answer.headers.vary).toContain("Accept-Encoding");
      const decoded = gunzipSync(answer.body);
      expect(decoded.toString()).toMatch(/^#EXTM3U\n/);
      expect(() => gunzipSync(decoded)).toThrow();
      const identity = await raw(path, "GET", { "Accept-Encoding": "gzip;q=0, identity" });
      expect(identity.headers["content-encoding"]).toBeUndefined();
      expect(identity.body.toString()).toMatch(/^#EXTM3U\n/);
    }
  });
});
