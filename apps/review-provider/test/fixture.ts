import {
  ARTWORK,
  ORIGINALS,
  type MediaIndex,
  type ObjectFact,
  type Segment,
} from "../src/catalogue.ts";

// Explicitly NON-MEDIA bytes for protocol/clock tests. These are not derivative
// certification or a substitute for generated/media.json from actual preparation.
export const USER = "fixture_reviewer";
export const PASSWORD = "nonsecret_fixture_password_for_contract_tests";
export const FIXTURE_NOW = Date.UTC(2026, 9, 25, 12);
export const FIXTURE_ORIGIN = "https://review.fixture.invalid";
export async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

export async function fixture() {
  const objects = new Map<string, Uint8Array>();
  async function fact(name: string, mime: ObjectFact["mime"]): Promise<ObjectFact> {
    const bytes = new TextEncoder().encode(
      `NON-MEDIA HTTP fixture ${name} 0123456789 abcdefghijklmnopqrstuvwxyz`,
    );
    const key = `fixture/${name}.bin`;
    objects.set(key, bytes);
    return { key, sha256: await digest(bytes), bytes: bytes.length, mime };
  }
  const originals = {
    movie: await fact("movie", "video/mp4"),
    "episode-1": await fact("episode-1", "video/mp4"),
    "episode-2": await fact("episode-2", "video/mp4"),
  };
  const artwork = {
    "movie-cover": await fact("movie-cover", "image/png"),
    "movie-backdrop": await fact("movie-backdrop", "image/png"),
    "series-cover": await fact("series-cover", "image/png"),
    "series-backdrop": await fact("series-backdrop", "image/png"),
  };
  const segments: Segment[] = [];
  for (const original of ORIGINALS) {
    for (let i = 0; i < original.frames / 144; i++) {
      segments.push({
        programme: original.id,
        frames: 144,
        videoDurationTicks: 540000,
        files: {
          "540p": await fact(`${original.id}/540p/${i}`, "video/mp2t"),
          "180p": await fact(`${original.id}/180p/${i}`, "video/mp2t"),
        },
      });
    }
  }
  const media: MediaIndex = {
    version: 1,
    sourceCommit: "synthetic-http-fixture-not-media",
    release: "fixture-release",
    originals,
    artwork,
    segments,
    programmes: await Promise.all(
      ORIGINALS.map(async (p) => ({
        id: p.id,
        videoFrames: p.frames,
        audio: {
          accessUnitsSha256: await digest(`synthetic AAC assertion ${p.id}`),
          firstEdgeTicks: 0,
          lastEdgeTicks: 0,
          continuous: true,
        },
      })),
    ),
    renditions: (["540p", "180p"] as const).map((id) => {
      const sizes = segments.map((s) => s.files[id].bytes);
      return {
        id,
        width: id === "540p" ? 960 : 320,
        height: id === "540p" ? 540 : 180,
        frameRate: 24,
        codecs: "avc1.42c01f,mp4a.40.2",
        bandwidth: Math.ceil((Math.max(...sizes) * 8) / 6),
        averageBandwidth: Math.ceil((sizes.reduce((sum, n) => sum + n, 0) * 8) / 330),
      };
    }),
  };
  return {
    media,
    objects,
    login: JSON.stringify({ username: USER, passwordSha256: await digest(PASSWORD) }),
    artworkIds: ARTWORK.map((a) => a.id),
  };
}
