import type { ObjectFact } from "./catalogue.ts";

/** Only the native R2 capabilities this service reads, also usable by explicit test ports. */
export interface Bucket {
  head(key: string): Promise<Pick<R2Object, "size" | "etag" | "httpEtag" | "uploaded"> | null>;
  get(
    key: string,
    options: {
      readonly onlyIf: { readonly etagMatches: string };
      readonly range?: { readonly offset: number; readonly length: number };
    },
  ): Promise<{ readonly size: number; readonly body?: ReadableStream<Uint8Array> } | null>;
}
type Range = { readonly offset: number; readonly length: number };

/** Unsupported/malformed ranges are ignored; valid unsatisfiable ranges are refused. */
function rangeOf(header: string | null, size: number): Range | "unsatisfiable" | null {
  if (!header || header.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (match[2] && end < start))
    return null;
  if (start >= size) return "unsatisfiable";
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

export function privateError(status: number, head = false): Response {
  return new Response(
    head
      ? null
      : JSON.stringify({
          error:
            status === 401
              ? "Unauthorized"
              : status === 404
                ? "Not found"
                : status === 400
                  ? "Bad request"
                  : "Service unavailable",
        }),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        ...(status === 405 ? { Allow: "GET, HEAD" } : {}),
      },
    },
  );
}

/** R2 remains private. Every fact passed here has already been allowlisted after auth. */
export async function binaryResponse(
  request: Request,
  fact: ObjectFact,
  bucket: Bucket,
  context: Pick<ExecutionContext, "waitUntil">,
  publicArtwork = false,
): Promise<Response> {
  const head = request.method === "HEAD";
  const metadata = await bucket.head(fact.key);
  if (!metadata || metadata.size !== fact.bytes) return privateError(503, head);
  const headers = new Headers({
    "Content-Type": fact.mime,
    "Accept-Ranges": "bytes",
    ETag: metadata.httpEtag,
    "Last-Modified": metadata.uploaded.toUTCString(),
    "Cache-Control": publicArtwork ? "public, max-age=0, must-revalidate" : "private, no-store",
  });
  // Actual local workerd preserves explicit length for a bodyless HEAD. GET/206
  // still require FixedLengthStream; deployed HEAD behavior remains a gate.
  if (head) {
    headers.set("Content-Length", String(fact.bytes));
    return new Response(null, { headers });
  }
  const validator = request.headers.get("If-Range");
  const range =
    head || (validator !== null && validator !== metadata.httpEtag)
      ? null
      : rangeOf(request.headers.get("Range"), metadata.size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${metadata.size}`);
    return new Response(null, { status: 416, headers });
  }
  const selected = range ?? { offset: 0, length: fact.bytes };
  const object = await bucket.get(fact.key, {
    onlyIf: { etagMatches: metadata.etag },
    ...(range ? { range: selected } : {}),
  });
  if (!object || !("body" in object) || !object.body || object.size !== fact.bytes)
    return privateError(503, head);
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${selected.offset}-${selected.offset + selected.length - 1}/${fact.bytes}`,
    );
  const fixed = new FixedLengthStream(selected.length);
  // The response must reach the reader before this backpressured pipe can finish.
  // pipeTo errors/cancellation propagate to the transfer. Observing its rejection
  // does not turn an incomplete body into success, or change already-sent headers.
  const pump = object.body.pipeTo(fixed.writable, { signal: request.signal });
  context.waitUntil(pump.catch(() => {}));
  return new Response(fixed.readable, { status: range ? 206 : 200, headers });
}
