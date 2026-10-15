// The live addresses the Xtream adapter gives each app's player: MPEG-TS for the desktop app's,
// HLS for AVPlayer on iOS. Panels serve both from the same login.
import { describe, expect, it } from "vitest";
import { xtreamProvider } from "../src/xtream.ts";

const account = { server: "http://panel.test:8080", username: "fixture user", password: "p/w" };
const unused: typeof fetch = () => Promise.reject(new Error("no request expected"));

describe("Xtream live streams", () => {
  it("asks for MPEG-TS unless told otherwise", async () => {
    const provider = xtreamProvider(account, { userAgent: "fixture", fetch: unused });
    expect(await provider.liveStream("1001")).toEqual({
      url: "http://panel.test:8080/live/fixture%20user/p%2Fw/1001.ts",
      format: "mpegts",
    });
  });

  it("asks for HLS for a player that takes only HLS", async () => {
    const provider = xtreamProvider(account, { userAgent: "fixture", fetch: unused, live: "hls" });
    expect(await provider.liveStream("1001")).toEqual({
      url: "http://panel.test:8080/live/fixture%20user/p%2Fw/1001.m3u8",
      format: "hls",
    });
  });
});
