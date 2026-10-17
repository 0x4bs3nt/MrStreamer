// Checks the title_hls core on this machine, against the FFmpeg that scripts/build-ffmpeg.sh
// builds for `reference`. For one file it opens the stream from `start` seconds, writes every
// playlist, initialization segment and segment, each rendition, made in order, into a folder,
// then makes every segment again in a shuffled order, each after a seek, and fails unless both
// are the same bytes. A sound segment refused for a gap is printed, not saved, and must be
// refused again after the seek. streams.txt says which stream of the file each sound rendition
// carries. It counts the separate runs of reading the file asks for, which is how
// many requests a provider would see, and the bytes read before the first segment is ready.
//
//   check <file> <folder> [start-seconds [interrupt-after-reads]]
#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../ios/core/title_hls.h"

typedef struct File {
  FILE *file;
  int64_t next; /* where the last read ended: a read elsewhere is a new request */
  int runs;
  int64_t bytes;
  int reads, interrupt_after;
  TitleHls *title;
} File;

static int read_at(void *opaque, int64_t offset, uint8_t *buffer, int size) {
  File *file = opaque;
  if (file->interrupt_after && ++file->reads == file->interrupt_after && file->title)
    title_hls_interrupt(file->title);
  if (offset != file->next) file->runs++;
  if (fseeko(file->file, offset, SEEK_SET) != 0) return -1;
  size_t read = fread(buffer, 1, (size_t)size, file->file);
  if (read == 0 && ferror(file->file)) return -1;
  file->next = offset + (int64_t)read;
  file->bytes += (int64_t)read;
  return (int)read;
}

static int save(const char *folder, const char *name, const uint8_t *data, size_t size) {
  char path[4096];
  snprintf(path, sizeof(path), "%s/%s", folder, name);
  FILE *out = fopen(path, "wb");
  if (!out || fwrite(data, 1, size, out) != size) return -1;
  return fclose(out);
}

/**
 * Copies one resource. A sound segment refused as unsupported, for a gap it can't be played
 * through, is an empty copy and returns 1, once printed; any other failure returns -1.
 */
static int get(TitleHls *title, const char *name, uint8_t **copy, size_t *size) {
  const uint8_t *data;
  const char *type;
  char detail[256] = "";
  TitleHlsResult result = title_hls_get(title, name, &data, size, &type, detail, sizeof(detail));
  if (result == TITLE_HLS_UNSUPPORTED && name[0] == 'a' && strchr(name, '-')) {
    printf("%s refused: %s\n", name, detail);
    *copy = calloc(1, 1);
    *size = 0;
    return 1;
  }
  if (result != TITLE_HLS_OK) {
    printf("%s result=%d detail=%s\n", name, result, detail);
    return -1;
  }
  *copy = malloc(*size + 1);
  memcpy(*copy, data, *size);
  (*copy)[*size] = 0;
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: check <file> <folder> [start-seconds [interrupt-after-reads]]\n");
    return 2;
  }
  File file = {.file = fopen(argv[1], "rb"), .next = 0};
  if (!file.file) return 2;
  fseeko(file.file, 0, SEEK_END);
  TitleHlsSource source = {.opaque = &file, .read_at = read_at, .size = ftello(file.file)};
  double start = argc > 3 ? atof(argv[3]) : 0;
  char detail[256] = "";
  TitleHls *title = NULL;
  TitleHlsResult result = title_hls_open(&source, start, &title, detail, sizeof(detail));
  printf("open start=%.3f result=%d runs=%d bytes=%lld detail=%s\n", start, result, file.runs,
         (long long)file.bytes, detail);
  if (result != TITLE_HLS_OK) return result == TITLE_HLS_DIRECT ? 3 : 1;
  file.title = title;
  if (argc > 4) file.interrupt_after = file.reads + atoi(argv[4]);
  uint8_t *data, **made = NULL;
  size_t size, *sizes = NULL;
  int *order = NULL, differ = 0, status = 1;
  // The renditions the master playlist names, and how many segments each has; a packed audio
  // rendition has no initialization segment and .mp3 segments.
  char renditions[16][16];
  int raw[16] = {0};
  int count = 0, segments = 0;
  // A failure, such as an interrupted read, still closes the title.
  if (get(title, "main.m3u8", &data, &size) < 0) goto done;
  save(argv[2], "main.m3u8", data, size);
  strcpy(renditions[count++], "v");
  for (char *line = strtok((char *)data, "\n"); line; line = strtok(NULL, "\n")) {
    char *uri = strstr(line, "URI=\"a");
    if (uri && count < 16) sscanf(uri + 5, "%15[^.]", renditions[count++]);
  }
  free(data);
  // Which of the file's streams each sound rendition carries, for verify.py.
  char path[4096];
  snprintf(path, sizeof(path), "%s/streams.txt", argv[2]);
  FILE *streams = fopen(path, "w");
  for (int r = 1; streams && r < count; r++)
    fprintf(streams, "%s %d\n", renditions[r], title_hls_sound_stream(title, atoi(renditions[r] + 1)));
  if (streams) fclose(streams);
  for (int r = 0; r < count; r++) {
    char name[64];
    snprintf(name, sizeof(name), "%s.m3u8", renditions[r]);
    if (get(title, name, &data, &size) < 0) goto done;
    save(argv[2], name, data, size);
    if (r == 0)
      for (char *at = (char *)data; (at = strstr(at, "#EXTINF")); at++) segments++;
    raw[r] = strstr((char *)data, "#EXT-X-MAP") == NULL;
    free(data);
    if (raw[r]) continue;
    snprintf(name, sizeof(name), "%s.mp4", renditions[r]);
    if (get(title, name, &data, &size) < 0) goto done;
    save(argv[2], name, data, size);
    free(data);
  }
  int first = 0;
  if (start > 0) {
    // The segment the playlist's start falls in: the first the player asks for.
    if (get(title, "v.m3u8", &data, &size) < 0) goto done;
    double at = 0;
    for (char *line = strtok((char *)data, "\n"); line; line = strtok(NULL, "\n")) {
      double length;
      if (sscanf(line, "#EXTINF:%lf", &length) == 1) {
        if (at + length > start) break;
        at += length;
        first++;
      }
    }
    free(data);
  }
  int runs = file.runs;
  int64_t bytes = file.bytes;
  made = calloc((size_t)(segments * count), sizeof(*made));
  sizes = calloc((size_t)(segments * count), sizeof(*sizes));
  size_t largest = 0;
  for (int n = 0; n < segments; n++) {
    int i = (first + n) % segments;
    for (int r = 0; r < count; r++) {
      char name[64];
      if (r == 0) snprintf(name, sizeof(name), "v%d.m4s", i);
      else snprintf(name, sizeof(name), "%s-%d.%s", renditions[r], i, raw[r] ? "mp3" : "m4s");
      int got = get(title, name, &made[i * count + r], &sizes[i * count + r]);
      if (got < 0) goto done;
      if (got == 0) save(argv[2], name, made[i * count + r], sizes[i * count + r]);
      if (sizes[i * count + r] > largest) largest = sizes[i * count + r];
    }
    if (n == 0)
      printf("first segment %d: %d new runs, %lld more bytes\n", i, file.runs - runs,
             (long long)(file.bytes - bytes));
  }
  printf("in order from %d: %d renditions, %d segments, %d new runs, largest %zu bytes\n", first,
         count, segments, file.runs - runs, largest);
  // Shuffled, deterministically: every segment after a seek, its renditions in another order.
  order = malloc((size_t)segments * sizeof(*order));
  for (int i = 0; i < segments; i++) order[i] = i;
  unsigned seed = 7;
  for (int i = segments - 1; i > 0; i--) {
    seed = seed * 1103515245u + 12345u;
    int j = (int)(seed % (unsigned)(i + 1)), t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  runs = file.runs;
  for (int n = 0; n < segments; n++) {
    int i = order[n];
    for (int k = 0; k < count; k++) {
      int r = (k + n) % count;
      char name[64];
      if (r == 0) snprintf(name, sizeof(name), "v%d.m4s", i);
      else snprintf(name, sizeof(name), "%s-%d.%s", renditions[r], i, raw[r] ? "mp3" : "m4s");
      uint8_t *again;
      if (get(title, name, &again, &size) < 0) goto done;
      // Refused again after a seek is the same answer: both are empty.
      if (size != sizes[i * count + r] || memcmp(again, made[i * count + r], size) != 0) {
        if (differ < 5) printf("%s differs after a seek: %zu vs %zu bytes\n", name, size, sizes[i * count + r]);
        differ++;
      }
      free(again);
    }
  }
  printf("shuffled: %d differ, %d new runs for %d seeks\n", differ, file.runs - runs, segments);
  status = differ ? 1 : 0;
done:
  for (int i = 0; made && i < segments * count; i++) free(made[i]);
  free(made);
  free(sizes);
  free(order);
  title_hls_close(title);
  fclose(file.file);
  return status;
}
