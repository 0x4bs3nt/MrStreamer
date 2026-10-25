import { readLogin, validLogin } from "./auth.ts";
import { binaryResponse, privateError, type Bucket } from "./binary.ts";
import {
  ARTWORK,
  CHANNEL,
  ORIGINALS,
  SOURCE_COMMIT,
  apiAnswer,
  readMediaIndex,
  validateMedia,
  type MediaIndex,
  type ObjectFact,
} from "./catalogue.ts";
import {
  completedSequence,
  EPOCH,
  guideDocument,
  masterPlaylist,
  rollingPlaylist,
} from "./timeline.ts";

export interface Env {
  readonly MEDIA?: Bucket;
  readonly REVIEW_LOGIN?: string;
  readonly PUBLIC_ORIGIN?: string;
}
type Shape =
  | { readonly kind: "api"; readonly action: string; readonly id: string | null }
  | { readonly kind: "guide" }
  | { readonly kind: "path"; readonly folder: string; readonly tail: readonly string[] };
type Parsed =
  | { readonly kind: "malformed" }
  | { readonly kind: "unrelated" }
  | { readonly kind: "artwork"; readonly name: string }
  | {
      readonly kind: "protected";
      readonly username: string;
      readonly password: string;
      readonly shape: Shape;
    };

// Only grammar/credential extraction. No catalogue, key or resource lookup here.
function parseShape(url: URL): Parsed {
  if (url.username || url.password || url.pathname.length > 2048 || url.search.length > 2048)
    return { kind: "malformed" };
  let parts: string[];
  try {
    parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
  } catch {
    return { kind: "malformed" };
  }
  if (parts.some((p) => !/^[A-Za-z0-9_.-]*$/.test(p) || p === "." || p === ".."))
    return { kind: "malformed" };
  if (parts.length === 1 && (parts[0] === "player_api.php" || parts[0] === "xmltv.php")) {
    const allowed = new Set(["username", "password", "action", "vod_id", "series_id"]);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
        return { kind: "malformed" };
    }
    const username = url.searchParams.get("username") ?? "";
    const password = url.searchParams.get("password") ?? "";
    if (username.length > 128 || password.length > 256) return { kind: "malformed" };
    const action = url.searchParams.get("action") ?? "";
    if (action.length > 80) return { kind: "malformed" };
    return {
      kind: "protected",
      username,
      password,
      shape:
        parts[0] === "xmltv.php"
          ? { kind: "guide" }
          : {
              kind: "api",
              action,
              id: url.searchParams.get(action === "get_vod_info" ? "vod_id" : "series_id"),
            },
    };
  }
  if (url.search) return { kind: "malformed" };
  if (parts[0] === "art" && parts.length === 2 && parts[1])
    return { kind: "artwork", name: parts[1] };
  const [folder, username, password, ...tail] = parts;
  if (folder && ["live", "movie", "series", "timeshift"].includes(folder)) {
    if (
      parts.length < 4 ||
      !username ||
      !password ||
      username.length > 128 ||
      password.length > 256 ||
      tail.some((p) => !p)
    )
      return { kind: "malformed" };
    return { kind: "protected", username, password, shape: { kind: "path", folder, tail } };
  }
  return { kind: "unrelated" };
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function clientEncoding(request: Request): string | null {
  const original = request.cf?.clientAcceptEncoding;
  return typeof original === "string" ? original : request.headers.get("Accept-Encoding");
}

function gzipAccepted(header: string | null): boolean {
  if (!header) return false;
  const choices = header
    .toLowerCase()
    .split(",")
    .map((part) => {
      const [name, ...parameters] = part.trim().split(";");
      const q = parameters.find((p) => p.trim().startsWith("q="));
      const quality = q ? Number(q.trim().slice(2)) : 1;
      return {
        name,
        quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0,
      };
    });
  const chosen = choices.find((c) => c.name === "gzip") ?? choices.find((c) => c.name === "*");
  return chosen !== undefined && chosen.quality > 0;
}

function textResponse(
  text: string,
  type: string,
  head: boolean,
  now: number,
  gzip = false,
): Response {
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "private, no-store",
    Date: new Date(now).toUTCString(),
  });
  if (type === "application/vnd.apple.mpegurl") {
    headers.set("Vary", "Accept-Encoding");
    if (gzip) headers.set("Content-Encoding", "gzip");
  }
  // Plain text only. Workers performs the selected compression on transmission.
  return new Response(head ? null : text, { headers });
}

/** One real HTTP boundary. Only the clock and immutable index differ in tests. */
export function createReviewProvider(media: MediaIndex, now: () => number = Date.now) {
  validateMedia(media);
  async function file(
    request: Request,
    fact: ObjectFact,
    env: Env,
    ctx: Pick<ExecutionContext, "waitUntil">,
    art = false,
  ) {
    try {
      return env.MEDIA
        ? await binaryResponse(request, fact, env.MEDIA, ctx, art)
        : privateError(503, request.method === "HEAD");
    } catch {
      return privateError(503, request.method === "HEAD");
    }
  }
  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: Pick<ExecutionContext, "waitUntil">,
    ): Promise<Response> {
      const head = request.method === "HEAD";
      try {
        if (!head && request.method !== "GET") return privateError(405);
        const at = now();
        if (!Number.isFinite(at) || at < EPOCH) return privateError(503, head);
        const parsed = parseShape(new URL(request.url));
        if (parsed.kind === "malformed") return privateError(400, head);
        if (parsed.kind === "unrelated") return privateError(404, head);
        if (parsed.kind === "artwork") {
          const known = ARTWORK.find((art) => `${art.id}.png` === parsed.name);
          return known
            ? file(request, media.artwork[known.id], env, ctx, true)
            : privateError(404, head);
        }
        const login = readLogin(env.REVIEW_LOGIN);
        if (!login) return privateError(503, head);
        if (!(await validLogin(parsed.username, parsed.password, login, at)))
          return privateError(401, head);
        // Existence, action and object lookup starts here, after successful auth.
        const origin = originOf(env.PUBLIC_ORIGIN);
        if (!origin) return privateError(503, head);
        const shape = parsed.shape;
        if (shape.kind === "api") {
          const answer = apiAnswer(shape.action, shape.id, origin);
          return new Response(head ? null : JSON.stringify(answer.body), {
            status: answer.status,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "private, no-store",
            },
          });
        }
        if (shape.kind === "guide")
          return textResponse(guideDocument(at), "application/xml; charset=utf-8", head, at);
        const { folder, tail } = shape;
        if (folder === "movie" || folder === "series") {
          const original = ORIGINALS.find(
            (p) =>
              `${p.id}.mp4` === tail[0] &&
              (folder === "movie" ? p.id === "movie" : p.id !== "movie"),
          );
          return original && tail.length === 1
            ? file(request, media.originals[original.id], env, ctx)
            : privateError(404, head);
        }
        if (folder !== "live") return privateError(404, head);
        if (tail.length === 1 && tail[0] === `${CHANNEL.id}.m3u8`)
          return textResponse(
            masterPlaylist(media),
            "application/vnd.apple.mpegurl",
            head,
            at,
            gzipAccepted(clientEncoding(request)),
          );
        if (tail[0] !== CHANNEL.id || tail[1] !== media.release) return privateError(404, head);
        if (tail.length === 3) {
          const r = media.renditions.find((row) => `${row.id}.m3u8` === tail[2]);
          if (!r) return privateError(404, head);
          const playlist = rollingPlaylist(media, r.id, at);
          return playlist === null
            ? privateError(503, head)
            : textResponse(
                playlist,
                "application/vnd.apple.mpegurl",
                head,
                at,
                gzipAccepted(clientEncoding(request)),
              );
        }
        if (tail.length !== 4) return privateError(404, head);
        const rendition = media.renditions.find((r) => r.id === tail[2]);
        const match = /^(0|[1-9]\d*)\.ts$/.exec(tail[3] ?? "");
        const n = match ? Number(match[1]) : -1;
        if (!rendition || !Number.isSafeInteger(n) || n < 0 || n > completedSequence(at))
          return privateError(404, head);
        const segment = media.segments[n % media.segments.length];
        return segment
          ? file(request, segment.files[rendition.id], env, ctx)
          : privateError(404, head);
      } catch {
        // Never include raw Request, URL, secret or exception in a log/response.
        return privateError(503, head);
      }
    },
  };
}

let production: ReturnType<typeof createReviewProvider> | undefined;
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (!production) {
        const rawMedia: unknown = (
          await import("../generated/media.json", { with: { type: "json" } })
        ).default;
        const media = readMediaIndex(rawMedia);
        if (
          media.sourceCommit !== SOURCE_COMMIT ||
          ORIGINALS.some((o) => media.originals[o.id].sha256 !== o.sha256) ||
          ARTWORK.some((a) => media.artwork[a.id].sha256 !== a.sha256)
        )
          throw new Error("Wrong original provenance");
        production = createReviewProvider(media);
      }
      return production.fetch(request, env, ctx);
    } catch {
      return privateError(503, request.method === "HEAD");
    }
  },
};
