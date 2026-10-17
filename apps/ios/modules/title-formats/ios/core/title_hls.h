// A movie or episode file AVPlayer can't open, such as Matroska, served as a VOD HLS stream it
// can: a complete playlist cut at the keyframes the file's own index lists, and segments made on
// request from the file's packets, copied unchanged: fragmented MP4, or packed audio for MP3.
// Nothing is decoded; where a sound track has no packets, frames of silence fill in.
//
// The picture is one rendition and each sound track AVPlayer plays (AAC-LC, HE-AAC, AC-3,
// E-AC-3, MP3) another, listed as the stream's audio choices. Subtitles aren't served.
//
// The file is read through `TitleHlsSource`, which the app answers from the provider or from a
// downloaded copy. One title is used from one thread at a time; `title_hls_interrupt` may be
// called from any thread, and makes a read in progress, and every later one, fail.
#ifndef TITLE_HLS_H
#define TITLE_HLS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TitleHlsSource {
  void *opaque;
  /** Reads up to `size` bytes at `offset`: the bytes read, 0 at the end, negative on failure. */
  int (*read_at)(void *opaque, int64_t offset, uint8_t *buffer, int size);
  /** The file's size in bytes, or -1 when unknown. */
  int64_t size;
} TitleHlsSource;

typedef enum TitleHlsResult {
  TITLE_HLS_OK = 0,
  /**
   * Not a file this reads, whatever its name said: an MP4 or MOV, which AVPlayer opens itself,
   * or another container AVPlayer may try.
   */
  TITLE_HLS_DIRECT,
  /** A Matroska file with a track or layout this can't copy: the detail says which. */
  TITLE_HLS_UNSUPPORTED,
  /** The source failed to read; the app knows why. */
  TITLE_HLS_READ_FAILED,
  /** Interrupted on request. */
  TITLE_HLS_INTERRUPTED,
  TITLE_HLS_NO_MEMORY,
  /** No such resource. */
  TITLE_HLS_MISSING,
} TitleHlsResult;

typedef struct TitleHls TitleHls;

/**
 * Reads the file's header and index and plans its segments. Playback starts at `start` seconds
 * of the title: the playlist says so, and opening reads the file there rather than at its
 * start. On failure `*out` is NULL and `detail`, when given, says why in a short sentence
 * without any address.
 */
TitleHlsResult title_hls_open(const TitleHlsSource *source, double start, TitleHls **out,
                              char *detail, size_t detail_size);

/**
 * One resource of the stream, by the name AVPlayer asks for: "main.m3u8", the playlists and
 * initialization segments it names, and the segments those name. `*data` and `*type` stay the
 * title's, valid until the next call. A segment is made on request, continuing the read when it
 * follows the last one made, else seeking.
 */
TitleHlsResult title_hls_get(TitleHls *title, const char *name, const uint8_t **data,
                             size_t *size, const char **type, char *detail, size_t detail_size);

/** The file's stream index of sound rendition `track` ("a<track>"), or -1: for checks. */
int title_hls_sound_stream(const TitleHls *title, int track);

void title_hls_interrupt(TitleHls *title);
void title_hls_close(TitleHls *title);

#ifdef __cplusplus
}
#endif

#endif
