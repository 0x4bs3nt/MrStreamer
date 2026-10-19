import { DownloadTask, type File } from "expo-file-system";

// One picture fetched to a file by expo-file-system's DownloadTask on its foreground session,
// whose URLSession keeps no URL cache (urlCache nil, reloadIgnoringLocalCacheData), so the
// picture's address, which may carry a login, isn't stored in iOS's shared cache. The artwork
// cache and Downloads' kept pictures use it; each owns the file it names.

/**
 * Fetches `url` into `file`, replacing what was there only once every byte arrived, and answers
 * its size. Throws when the server answers an error, the fetch takes over `timeoutMs`, or the
 * picture grows past `maxBytes`; a file past `maxBytes` is deleted first.
 */
export async function fetchPicture(
  url: string,
  file: File,
  { timeoutMs, maxBytes = Number.POSITIVE_INFINITY }: { timeoutMs: number; maxBytes?: number },
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const task = new DownloadTask(url, file, {
    sessionType: "foreground",
    signal: controller.signal,
    onProgress: ({ bytesWritten, totalBytes }) => {
      if (bytesWritten > maxBytes || totalBytes > maxBytes) controller.abort();
    },
  });
  try {
    const done = await task.downloadAsync();
    const bytes = done?.size ?? 0;
    if (bytes < 1 || bytes > maxBytes) {
      if (done?.exists) done.delete();
      throw new Error("Not a picture to keep");
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}
