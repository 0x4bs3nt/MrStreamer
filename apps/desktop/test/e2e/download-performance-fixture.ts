// Performance-only persisted copies and slow HTTP boundary. Neither replaces app IPC or state.
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, stat } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { databaseLayer } from "../../src/main/platform/database.ts";
import { DownloadStore, downloadStoreLayer } from "../../src/main/platform/downloads-store.ts";

/** Seed only while the owned app is closed. Files share one valid clip's inode, not its bytes. */
export async function seedCopies(profile: string, clip: string) {
  const registry: unknown = JSON.parse(await readFile(join(profile, "subscriptions.json"), "utf8"));
  if (
    !registry ||
    typeof registry !== "object" ||
    !("subscriptions" in registry) ||
    !Array.isArray(registry.subscriptions)
  )
    throw new Error("Owned UI login did not persist its registry");
  const owner: unknown = registry.subscriptions[0];
  if (
    !owner ||
    typeof owner !== "object" ||
    !("id" in owner) ||
    typeof owner.id !== "string" ||
    !("key" in owner) ||
    typeof owner.key !== "string"
  )
    throw new Error("Owned UI login has no account key");
  const runtime = ManagedRuntime.make(
    downloadStoreLayer.pipe(Layer.provide(databaseLayer(profile))),
  );
  const size = (await stat(clip)).size;
  try {
    const store = await runtime.runPromise(DownloadStore);
    for (let index = 0; index < 2000; index++) {
      const id = randomUUID();
      const folder = join(profile, "downloads", id);
      await mkdir(folder, { recursive: true });
      await link(clip, join(folder, "media.mp4"));
      await runtime.runPromise(
        store.put({
          id,
          account: owner.key,
          subscriptionId: owner.id,
          title: { kind: "movie", id: `performance-copy-${index}` },
          listingKey: "performance-copy",
          sourceStamp: "copy",
          container: "mp4",
          about: {
            name: `Performance copy ${index}`,
            episodeName: null,
            year: 2024,
            duration: 20,
            originalLanguage: "en",
            poster: null,
            wide: null,
          },
          state: "complete",
          size,
          received: size,
          identity: null,
          restarted: false,
          addedAt: index,
          completedAt: index,
          progress: null,
        }),
      );
    }
    const inventory = await runtime.runPromise(store.list);
    if (inventory.records.length !== 2000 || inventory.unreadable.size)
      throw new Error("Performance fixture inventory differs from 2000 readable copies");
    return {
      copies: inventory.records.length,
      logicalBytes: size * 2000,
      physicalClipBytes: size,
      note: "Performance-only seed via public DownloadStore, matching persisted UI-login account. sourceStamp copy grants no provider rights.",
    };
  } finally {
    await runtime.dispose();
  }
}

/** Pace file bodies by 4 KiB per 25 ms, keeping main's 250 ms snapshot timer busy. */
export async function slowProvider(origin: string) {
  let url = "";
  let bytes = 0;
  let files = 0;
  const server = createServer((incoming, outgoing) => {
    const abort = new AbortController();
    const upstream = request(
      new URL(incoming.url ?? "/", origin),
      { headers: incoming.headers },
      (response) => {
        const headers = { ...response.headers };
        if (headers.location?.startsWith(origin))
          headers.location = headers.location.replace(origin, url);
        outgoing.writeHead(response.statusCode ?? 502, headers);
        const paced = incoming.url?.startsWith("/files/") ?? false;
        if (paced) files++;
        void (async () => {
          for await (const chunk of response) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            for (let at = 0; at < buffer.length; at += 4096) {
              if (paced) await delay(25, undefined, { signal: abort.signal });
              if (outgoing.destroyed) return;
              const piece = buffer.subarray(at, at + 4096);
              if (paced) bytes += piece.length;
              outgoing.write(piece);
            }
          }
          outgoing.end();
        })().catch(() => outgoing.destroy());
      },
    );
    upstream.on("error", () => outgoing.destroy());
    outgoing.on("close", () => {
      abort.abort();
      upstream.destroy();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No proxy port");
  url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    observed: () => ({ bytes, files, pieceBytes: 4096, pieceDelayMs: 25 }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
