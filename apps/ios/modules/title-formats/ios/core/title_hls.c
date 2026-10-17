// See title_hls.h. How the stream is made:
//
// - The cuts are keyframes of the picture the file's index lists. Matroska's demuxer reads its
//   Cues only on the first seek, so opening seeks once and then takes the index as it stands;
//   reading later adds entries that the plan never uses. Without Cues FFmpeg's seek would read
//   the whole file to find keyframes, so the index may take INDEX_BYTES_MOST at most.
// - Title time 0 is the first cut. A segment is about SEGMENT_S long; a gap in the index longer
//   than SEGMENT_MOST_S, or an index that stops short of the end, leaves the file unsupported
//   rather than with a playlist that would be wrong.
// - Matroska stores presentation times only. A segment's pictures keep their order, and their
//   decode times are their presentation times sorted, less the segment's reorder delay so none
//   is after its presentation. The muxer writes negative composition offsets and takes that
//   delay off again (its first packet, the cut's keyframe, has the earliest presentation), so
//   the decode timeline of segment k runs exactly from cut k to cut k+1, however it was reached.
// - Matroska rounds times to its tick, often a millisecond. Sound whose frames all have one
//   length is placed on its frame grid, anchored at the first packet opening read, so frames
//   follow each other without the gaps or overlaps the rounding would leave.
// - A segment has the picture's packets from its cut's keyframe up to the next cut's, and each
//   sound track's packets whose time is between the two cuts, made in one pass of the file and
//   written per rendition. Made in order, the packets read past a cut are kept for the next
//   segment; made after a seek, and at open, the read starts at the cut's cluster, or one cut
//   earlier when sound of this segment may lie before it. A muxer may store sound ahead of the
//   picture, so sound for the first cut can lie in clusters before the first cut's: opening
//   reads the file's first clusters up to the picture's first keyframe and keeps that sound
//   (within LEAD_PACKETS_MOST and LEAD_BYTES_MOST) for whenever the read starts at the first cut.
// - A sound track may end before the picture, pause, or start late. Sound is waited for until the
//   picture is LATE_SOUND_S past the cut, and a track with nothing near where playing starts
//   isn't offered. AVPlayer's clock stops where the chosen sound stops, so each frame of a
//   track's grid that has no packet gets a frame of silence: its rendition runs the whole
//   title. The silence is built for AAC-LC and MP3, and encoded once with FFmpeg's encoder for
//   AC-3 and E-AC-3 when that writes frames like the track's. A track without one may start or
//   end EDGE_S inside the picture; a segment where it has a gap elsewhere is refused, with a
//   reason, when that track is chosen, rather than left to stall. The session fails with it,
//   and opening the title again, from where it stopped, plays the default sound.
// - Each rendition's MP4 is written by a muxer of its own, fed the packets and flushed twice:
//   with delay_moov the first flush writes the header, which for AC-3 and E-AC-3 the muxer can
//   only write once it has parsed a packet, and the second the fragment. A segment keeps the
//   fragment, the initialization segment the header.
// - AVPlayer doesn't take MP3 in fragmented MP4; HLS carries it as packed audio. An MP3
//   rendition has no initialization segment, and each of its segments is an ID3 tag with the
//   MPEG-2 transport stream time of its first frame (33 bits of a 90 kHz clock) followed by the
//   frames as they are. A frame may take part of its data from up to the last 511 bytes of the
//   frames before it (the bit reservoir), so playing from a segment reached by a seek, its first
//   few frames may not decode fully.
#include "title_hls.h"

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avstring.h>
#include <libavutil/bprint.h>
#include <libavutil/mathematics.h>
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/** About how long a segment is: the first cut this long after the last. Seconds. */
#define SEGMENT_S 4.0
/** The longest gap between cuts. A longer one leaves the file unsupported. */
#define SEGMENT_MOST_S 20.0
/** A last segment shorter than this joins the one before it. */
#define LAST_LEAST_S 1.0
/** Segments a playlist lists at most: some 44 hours. */
#define SEGMENTS_MOST 40000
/**
 * The most one segment's packets, all renditions together, may hold. Two segments are kept and
 * one is being made, so this bounds what a title holds in memory.
 */
#define SEGMENT_BYTES_MOST (48 * 1024 * 1024)
/** Packets read past a segment's end at most, before giving up on the sound catching up. */
#define AHEAD_PACKETS_MOST 4096
/**
 * The most reading the index may take. A file's Cues are a small fraction of it; without them,
 * FFmpeg's seek would read the whole file to find keyframes, so the reading stops here instead.
 */
#define INDEX_BYTES_MOST (16 * 1024 * 1024)
/**
 * How far past a cut the picture may be read while sound of the segment before it is still
 * awaited. Muxers keep sound within about a second of the picture; a track with nothing by then
 * has nothing there.
 */
#define LATE_SOUND_S 5.0
/**
 * Packets read from the file's start for sound before the first cut's cluster at most, and the
 * bytes of sound kept from them.
 */
#define LEAD_PACKETS_MOST 1024
#define LEAD_BYTES_MOST (4 * 1024 * 1024)
/**
 * How far inside the picture a track that can't be filled with silence may start or end without
 * its segment being refused: AVPlayer starts its clock where such sound starts, and stops it
 * where it ends, so this little is lost at either end of the title.
 */
#define EDGE_S 0.1
/** Sound tracks offered at most. */
#define SOUNDS_MOST 8
/** Segments kept after they were made, every rendition of each. */
#define KEPT 2
#define IO_BUFFER 65536

typedef struct Packets {
  AVPacket **items;
  int count, capacity;
  size_t bytes;
} Packets;

typedef struct Bytes {
  uint8_t *data;
  size_t size;
} Bytes;

/** A sound track offered as an audio rendition. */
typedef struct Sound {
  int stream;
  AVRational base;
  /** Samples per frame for sound on a frame grid, 0 otherwise; and its sample rate. */
  int frame, rate;
  /** The grid's anchor: the first packet opening read, in `base`. */
  int64_t first;
  /** That packet, which the initialization segment is written from. */
  AVPacket *sample;
  /** Empty for packed audio, which has none. */
  Bytes init;
  /** A frame of silence, filling where the track has none; NULL when one can't be made. */
  AVPacket *silence;
} Sound;

/** Every rendition of one segment; a sound rendition without data was refused for a gap. */
typedef struct Made {
  int index; /* -1 when empty */
  Bytes renditions[1 + SOUNDS_MOST];
} Made;

struct TitleHls {
  TitleHlsSource source;
  int64_t position;
  /** Bytes reading may still take, or -1 for no limit. */
  int64_t budget;
  atomic_int interrupted;
  AVIOContext *io;
  AVFormatContext *input;
  int video;
  AVRational video_base;
  AVPacket *video_sample;
  Bytes video_init;
  Sound sounds[SOUNDS_MOST];
  int sound_count;
  /** Cuts in the picture's time base; cuts[count] is the end of the title. */
  int64_t *cuts;
  int count;
  /** Where playback starts, in title seconds; 0 for the start. */
  double start;
  /** The segment the input continues into without a seek, or -1. */
  int next;
  Packets ahead;
  /** Sound stored before the first cut's cluster, which a seek there doesn't read. */
  Packets lead;
  Made kept[KEPT];
  int kept_next;
  /** The last playlist asked for. */
  char *text;
};

static const char *const MPEGURL = "application/vnd.apple.mpegurl";
static const char *const MP4 = "video/mp4";
static const char *const MPEG_AUDIO = "audio/mpeg";

static void say(char *detail, size_t size, const char *text) {
  if (detail && size) av_strlcpy(detail, text, size);
}

static int read_packet(void *opaque, uint8_t *buffer, int size) {
  TitleHls *title = opaque;
  if (atomic_load(&title->interrupted)) return AVERROR_EXIT;
  if (title->budget == 0) return AVERROR(ERANGE);
  if (title->budget > 0 && size > title->budget) size = (int)title->budget;
  int read = title->source.read_at(title->source.opaque, title->position, buffer, size);
  if (read < 0) return atomic_load(&title->interrupted) ? AVERROR_EXIT : AVERROR(EIO);
  if (read == 0) return AVERROR_EOF;
  title->position += read;
  if (title->budget > 0) title->budget -= read;
  return read;
}

static int64_t seek(void *opaque, int64_t offset, int whence) {
  TitleHls *title = opaque;
  int64_t size = title->source.size;
  switch (whence & ~AVSEEK_FORCE) {
    case AVSEEK_SIZE:
      return size >= 0 ? size : AVERROR(ENOSYS);
    case SEEK_SET:
      break;
    case SEEK_CUR:
      offset += title->position;
      break;
    case SEEK_END:
      if (size < 0) return AVERROR(ENOSYS);
      offset += size;
      break;
    default:
      return AVERROR(EINVAL);
  }
  if (offset < 0) return AVERROR(EINVAL);
  title->position = offset;
  return offset;
}

static int interrupted(void *opaque) {
  return atomic_load(&((TitleHls *)opaque)->interrupted);
}

static TitleHlsResult failure(TitleHls *title, int error) {
  if (atomic_load(&title->interrupted) || error == AVERROR_EXIT) return TITLE_HLS_INTERRUPTED;
  if (error == AVERROR(ENOMEM)) return TITLE_HLS_NO_MEMORY;
  if (error == AVERROR(EIO)) return TITLE_HLS_READ_FAILED;
  return TITLE_HLS_UNSUPPORTED;
}

static int push(Packets *list, AVPacket *packet) {
  if (list->count == list->capacity) {
    int capacity = list->capacity ? list->capacity * 2 : 256;
    AVPacket **items = av_realloc_array(list->items, capacity, sizeof(*items));
    if (!items) return AVERROR(ENOMEM);
    list->items = items;
    list->capacity = capacity;
  }
  list->items[list->count++] = packet;
  list->bytes += packet->size;
  return 0;
}

static void clear(Packets *list) {
  for (int i = 0; i < list->count; i++) av_packet_free(&list->items[i]);
  list->count = 0;
  list->bytes = 0;
}

static void release(Packets *list) {
  clear(list);
  av_freep(&list->items);
  list->capacity = 0;
}

static double seconds(int64_t ts, AVRational base) { return ts * av_q2d(base); }

/** Samples per frame of the sound codecs whose frames are all one length. */
static int frame_samples(enum AVCodecID codec) {
  switch (codec) {
    case AV_CODEC_ID_AAC:
      return 1024;
    case AV_CODEC_ID_AC3:
    case AV_CODEC_ID_EAC3:
      return 1536;
    case AV_CODEC_ID_MP3:
      return 1152;
    default:
      return 0;
  }
}

/**
 * Samples per frame of the sound `sample` begins: for MP3, Layer III frames hold 1152 samples in
 * MPEG-1 and 576 in MPEG-2 and 2.5, as its header says, or its sample rate when the header can't
 * be read; for the others, `frame_samples`.
 */
static int sample_frame(const AVCodecParameters *par, const AVPacket *sample) {
  if (par->codec_id != AV_CODEC_ID_MP3) return frame_samples(par->codec_id);
  const uint8_t *x = sample ? sample->data : NULL;
  if (x && sample->size >= 4 && x[0] == 0xFF && (x[1] & 0xE0) == 0xE0 && ((x[1] >> 1) & 3) == 1) {
    int version = (x[1] >> 3) & 3; /* 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5 */
    if (version != 1) return version == 3 ? 1152 : 576;
  }
  return par->sample_rate >= 32000 ? 1152 : 576;
}

/** The sound codecs AVPlayer plays from fragmented MP4, copied as they are. */
static int sound_copyable(enum AVCodecID codec) { return frame_samples(codec) > 0; }

/** The time base a sound track is written in: its samples on a frame grid, else its own. */
static AVRational sound_base(const Sound *sound) {
  return sound->frame ? (AVRational){1, sound->rate} : sound->base;
}

/**
 * A sound packet's time from title time 0, in `sound_base`: on a frame grid, the anchor's time
 * plus a whole number of frames.
 */
static int64_t sound_time(const TitleHls *title, const Sound *sound, const AVPacket *packet) {
  AVRational base = sound_base(sound);
  int64_t origin = av_rescale_q(title->cuts[0], title->video_base, base);
  int64_t at = av_rescale_q(packet->pts, sound->base, base);
  if (!sound->frame) return at - origin;
  int64_t first = av_rescale_q(sound->first, sound->base, base);
  return first + llrint((double)(at - first) / sound->frame) * sound->frame - origin;
}

/** Whether a sound packet's time lies before the cut `at`, on the picture's clock. */
static int sound_before(const TitleHls *title, const Sound *sound, const AVPacket *packet,
                        int64_t at) {
  return av_compare_ts(sound_time(title, sound, packet), sound_base(sound), at - title->cuts[0],
                       title->video_base) < 0;
}

/** The offered sound track a packet belongs to, or NULL. */
static Sound *sound_of(TitleHls *title, const AVPacket *packet) {
  for (int i = 0; i < title->sound_count; i++) {
    if (title->sounds[i].stream == packet->stream_index) return &title->sounds[i];
  }
  return NULL;
}

/** Whether a track is served as packed audio, not fragmented MP4: MP3, as AVPlayer takes it. */
static int packed(const TitleHls *title, const Sound *sound) {
  return title->input->streams[sound->stream]->codecpar->codec_id == AV_CODEC_ID_MP3;
}

/** Where the first top-level box of `type` starts in an MP4, or with `after`, where it ends. */
static size_t box_offset(const uint8_t *data, size_t size, const char *type, int after) {
  size_t at = 0;
  while (at + 8 <= size) {
    uint64_t length = (uint64_t)data[at] << 24 | (uint64_t)data[at + 1] << 16 |
                      (uint64_t)data[at + 2] << 8 | data[at + 3];
    if (length == 1 && at + 16 <= size) {
      length = 0;
      for (int i = 0; i < 8; i++) length = length << 8 | data[at + 8 + i];
    }
    if (length < 8 || at + length > size) return SIZE_MAX;
    if (memcmp(data + at + 4, type, 4) == 0) return after ? at + (size_t)length : at;
    at += (size_t)length;
  }
  return SIZE_MAX;
}

static void put32(uint8_t *at, uint32_t value) {
  at[0] = value >> 24;
  at[1] = value >> 16;
  at[2] = value >> 8;
  at[3] = value;
}

typedef struct Bits {
  const uint8_t *data;
  int size, at;
} Bits;

/** Reads `count` bits, zeros past the end. */
static unsigned bits_read(Bits *bits, int count) {
  unsigned value = 0;
  for (int i = 0; i < count; i++, bits->at++) {
    int bit = bits->at < bits->size * 8 ? bits->data[bits->at >> 3] >> (7 - (bits->at & 7)) & 1 : 0;
    value = value << 1 | (unsigned)bit;
  }
  return value;
}

static void bits_put(uint8_t *data, int *at, int count, unsigned value) {
  for (int i = count - 1; i >= 0; i--, (*at)++) {
    if (value >> i & 1) data[*at >> 3] |= 0x80 >> (*at & 7);
  }
}

/** A key packet holding a copy of `size` bytes of `data`. */
static int frame_packet(const uint8_t *data, int size, AVPacket **made) {
  AVPacket *packet = av_packet_alloc();
  if (!packet || av_new_packet(packet, size) < 0) {
    av_packet_free(&packet);
    return AVERROR(ENOMEM);
  }
  memcpy(packet->data, data, (size_t)size);
  packet->flags = AV_PKT_FLAG_KEY;
  *made = packet;
  return 0;
}

/** The AAC audio object type `par`'s AudioSpecificConfig names, or 0 when it has none. */
static unsigned aac_type(const AVCodecParameters *par) {
  if (par->extradata_size < 1) return 0;
  Bits config = {par->extradata, par->extradata_size, 0};
  unsigned type = bits_read(&config, 5);
  return type == 31 ? 32 + bits_read(&config, 6) : type;
}

/**
 * Whether AVPlayer plays a sound track's codec in HLS: AAC only as AAC-LC or HE-AAC (v1, v2), as
 * Apple's HLS authoring specification lists it. A variant naming another AAC, such as AAC Main,
 * in its CODECS fails to open whole, the default sound with it; such a track isn't offered.
 */
static int sound_playable(const AVCodecParameters *par) {
  if (!sound_copyable(par->codec_id)) return 0;
  if (par->codec_id != AV_CODEC_ID_AAC) return 1;
  unsigned type = aac_type(par);
  return type == 0 || type == 2 || type == 5 || type == 29;
}

/**
 * An AAC-LC frame of silence for the channels `par`'s AudioSpecificConfig names: every channel
 * element has no scale factor bands, so all its coefficients are zero. None for other AAC (SBR,
 * 960-sample frames, a channel configuration of its own), which this can't silence.
 */
static int aac_silence(const AVCodecParameters *par, AVPacket **made) {
  // The channel elements of channel configurations 1 to 7: S single, C pair, L low frequency.
  static const char *const ELEMENTS[] = {"", "S", "C", "SC", "SCS", "SCC", "SCCL", "SCCCL"};
  if (par->extradata_size < 2 || aac_type(par) != 2) return 0;
  Bits config = {par->extradata, par->extradata_size, 5};
  if (bits_read(&config, 4) == 15) bits_read(&config, 24);
  unsigned channels = bits_read(&config, 4);
  if (channels < 1 || channels > 7) return 0;
  if (bits_read(&config, 1)) return 0; /* 960-sample frames */
  if (bits_read(&config, 1)) bits_read(&config, 14);
  bits_read(&config, 1);
  // A sync extension may say SBR follows the plain AAC.
  if (config.size * 8 - config.at >= 16 && bits_read(&config, 11) == 0x2b7 &&
      bits_read(&config, 5) == 5 && bits_read(&config, 1))
    return 0;
  uint8_t frame[32] = {0};
  int at = 0, tags[4] = {0};
  for (const char *element = ELEMENTS[channels]; *element; element++) {
    int id = *element == 'S' ? 0 : *element == 'C' ? 1 : 3;
    bits_put(frame, &at, 3, (unsigned)id);
    bits_put(frame, &at, 4, (unsigned)tags[id]++);
    if (id == 1) bits_put(frame, &at, 1, 0); /* common_window */
    for (int channel = 0; channel < (id == 1 ? 2 : 1); channel++) {
      bits_put(frame, &at, 8, 100); /* global_gain */
      // ics_info: reserved, one long window, its shape, max_sfb 0, no prediction.
      bits_put(frame, &at, 11, 0);
      // No pulse, TNS or gain control data; with no bands, no sections, scale factors or
      // spectral data.
      bits_put(frame, &at, 3, 0);
    }
  }
  bits_put(frame, &at, 3, 7); /* END */
  return frame_packet(frame, (at + 7) / 8, made);
}

/**
 * An MP3 frame of silence like `sample`'s: its header without CRC or padding, then side
 * information of zeros, so no granule has any data, and nothing else. None for a free-format
 * bitrate, whose frame length the header doesn't give.
 */
static int mp3_silence(const AVPacket *sample, AVPacket **made) {
  static const int KBPS[2][15] = {
      {0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320},
      {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160}};
  static const int RATES[4][3] = {{11025, 12000, 8000}, {0}, {22050, 24000, 16000},
                                  {44100, 48000, 32000}};
  const uint8_t *x = sample ? sample->data : NULL;
  if (!x || sample->size < 4 || x[0] != 0xFF || (x[1] & 0xE0) != 0xE0 || (x[1] >> 1 & 3) != 1)
    return 0;
  int version = x[1] >> 3 & 3, bitrate = x[2] >> 4, rate = x[2] >> 2 & 3;
  if (version == 1 || bitrate == 0 || bitrate == 15 || rate == 3) return 0;
  // Layer III: 144 bytes a frame per bit per second over the rate in MPEG-1, 72 in MPEG-2 and 2.5.
  uint8_t frame[1440] = {0};
  int size = (version == 3 ? 144 : 72) * KBPS[version != 3][bitrate] * 1000 / RATES[version][rate];
  frame[0] = 0xFF;
  frame[1] = x[1] | 1;
  frame[2] = x[2] & ~2;
  frame[3] = x[3];
  return frame_packet(frame, size, made);
}

/** How the first syncframe of an AC-3 or E-AC-3 packet is coded. */
typedef struct Dolby {
  int eac3, rate, acmod, lfe, blocks, size;
  /** AC-3's bitrate, in its table. */
  int bitrate;
} Dolby;

static const int DOLBY_RATES[3] = {48000, 44100, 32000};
static const int AC3_KBPS[19] = {32,  40,  48,  56,  64,  80,  96,  112, 128, 160,
                                 192, 224, 256, 320, 384, 448, 512, 576, 640};

/** Reads an AC-3 (bsid up to 8) or independent E-AC-3 (bsid 11 to 16) syncframe's header. */
static int dolby_header(const uint8_t *data, int size, Dolby *out) {
  if (size < 8 || data[0] != 0x0B || data[1] != 0x77) return 0;
  int bsid = data[5] >> 3; /* at the same place in both */
  Bits bits = {data, size, 16};
  Dolby d = {0};
  if (bsid <= 8) {
    bits_read(&bits, 16); /* crc1 */
    int fscod = (int)bits_read(&bits, 2), code = (int)bits_read(&bits, 6);
    if (fscod == 3 || code >= 38) return 0;
    bits_read(&bits, 8); /* bsid, bsmod */
    d.acmod = (int)bits_read(&bits, 3);
    if ((d.acmod & 1) && d.acmod != 1) bits_read(&bits, 2);
    if (d.acmod & 4) bits_read(&bits, 2);
    if (d.acmod == 2) bits_read(&bits, 2);
    d.lfe = (int)bits_read(&bits, 1);
    d.rate = DOLBY_RATES[fscod];
    d.bitrate = code >> 1;
    d.blocks = 6;
    // 16-bit words: 96 per kbit/s per kHz of the rate; at 44.1 kHz odd codes add a word.
    d.size = 2 * (AC3_KBPS[d.bitrate] * 96000 / d.rate) + (d.rate == 44100 ? 2 * (code & 1) : 0);
  } else if (bsid >= 11 && bsid <= 16) {
    d.eac3 = 1;
    if (bits_read(&bits, 2) != 0) return 0; /* not an independent substream */
    bits_read(&bits, 3);
    d.size = 2 * ((int)bits_read(&bits, 11) + 1);
    int fscod = (int)bits_read(&bits, 2);
    if (fscod == 3) return 0; /* half rates, which FFmpeg's encoder doesn't write */
    d.blocks = (int[]){1, 2, 3, 6}[bits_read(&bits, 2)];
    d.acmod = (int)bits_read(&bits, 3);
    d.lfe = (int)bits_read(&bits, 1);
    d.rate = DOLBY_RATES[fscod];
  } else {
    return 0;
  }
  *out = d;
  return 1;
}

/**
 * An AC-3 or E-AC-3 frame of silence coded like `sample`'s: FFmpeg's encoder given one frame
 * of zeros at the track's rate, channels and bitrate. None when the track's frames aren't ones
 * that encoder writes: two independent mono channels, E-AC-3 with fewer than six blocks a frame
 * or dependent substreams (over 5.1), or anything it writes differently.
 */
static int dolby_silence(const AVCodecParameters *par, const AVPacket *sample, AVPacket **made) {
  // The channels of acmod 1 to 7: 1/0, 2/0, 3/0, 2/1, 3/1, 2/2, 3/2.
  static const uint64_t LAYOUTS[8] = {0,
                                      AV_CH_LAYOUT_MONO,
                                      AV_CH_LAYOUT_STEREO,
                                      AV_CH_LAYOUT_SURROUND,
                                      AV_CH_LAYOUT_2_1,
                                      AV_CH_LAYOUT_4POINT0,
                                      AV_CH_LAYOUT_2_2,
                                      AV_CH_LAYOUT_5POINT0};
  Dolby want, got;
  if (!sample || !dolby_header(sample->data, sample->size, &want) || !LAYOUTS[want.acmod] ||
      want.blocks != 6 || want.size != sample->size)
    return 0;
  const AVCodec *codec = avcodec_find_encoder(par->codec_id);
  if (!codec) return 0;
  AVCodecContext *context = avcodec_alloc_context3(codec);
  AVFrame *frame = av_frame_alloc();
  AVPacket *packet = av_packet_alloc();
  int error = AVERROR(ENOMEM);
  if (!context || !frame || !packet) goto end;
  context->sample_rate = want.rate;
  context->sample_fmt = AV_SAMPLE_FMT_FLTP;
  av_channel_layout_from_mask(&context->ch_layout,
                              LAYOUTS[want.acmod] | (want.lfe ? AV_CH_LOW_FREQUENCY : 0));
  context->bit_rate = want.eac3 ? (int64_t)want.size * 8 * want.rate / 1536
                                : (int64_t)AC3_KBPS[want.bitrate] * 1000;
  // A rate, layout or bitrate the encoder refuses: no silence.
  if ((error = avcodec_open2(context, codec, NULL)) < 0) goto end;
  frame->nb_samples = context->frame_size;
  frame->format = context->sample_fmt;
  frame->sample_rate = context->sample_rate;
  if ((error = av_channel_layout_copy(&frame->ch_layout, &context->ch_layout)) < 0 ||
      (error = av_frame_get_buffer(frame, 0)) < 0)
    goto end;
  av_samples_set_silence(frame->extended_data, 0, frame->nb_samples,
                         frame->ch_layout.nb_channels, context->sample_fmt);
  if ((error = avcodec_send_frame(context, frame)) < 0) goto end;
  error = avcodec_receive_packet(context, packet);
  if (error == AVERROR(EAGAIN) && (error = avcodec_send_frame(context, NULL)) >= 0)
    error = avcodec_receive_packet(context, packet);
  if (error < 0) goto end;
  if (dolby_header(packet->data, packet->size, &got) && got.eac3 == want.eac3 &&
      got.rate == want.rate && got.acmod == want.acmod && got.lfe == want.lfe &&
      got.blocks == 6 && got.size == packet->size &&
      (want.eac3 ? got.size == want.size : got.bitrate == want.bitrate)) {
    packet->pts = packet->dts = AV_NOPTS_VALUE;
    packet->flags = AV_PKT_FLAG_KEY;
    *made = packet;
    packet = NULL;
  }
end:
  av_packet_free(&packet);
  av_frame_free(&frame);
  avcodec_free_context(&context);
  return error == AVERROR(ENOMEM) ? error : 0;
}

/** The track's frame of silence, or none: `silence` stays NULL. */
static int silence_of(const AVCodecParameters *par, const AVPacket *sample, AVPacket **silence) {
  switch (par->codec_id) {
    case AV_CODEC_ID_AAC:
      return aac_silence(par, silence);
    case AV_CODEC_ID_MP3:
      return mp3_silence(sample, silence);
    case AV_CODEC_ID_AC3:
    case AV_CODEC_ID_EAC3:
      return dolby_silence(par, sample, silence);
    default:
      return 0;
  }
}

/** The first frame of the grid at or after the cut `cut`, as sound_before tells it. */
static int64_t slot_at(const TitleHls *title, const Sound *sound, int64_t first, int64_t cut) {
  int64_t at = av_rescale_q_rnd(cut - title->cuts[0], title->video_base, sound_base(sound),
                                AV_ROUND_UP) - first;
  return at >= 0 ? (at + sound->frame - 1) / sound->frame : -(-at / sound->frame);
}

/**
 * Fills each frame of the grid between the cuts `from` and `to` that has no packet of
 * `packets`, a segment's, stamped and in order, with the track's silence, adding its bytes to
 * `*bytes`: AVPlayer's clock stops where the chosen sound stops, so a rendition has sound for
 * the whole of every segment. A track without silence is left as it is; 1 when it has a gap
 * more than EDGE_S inside the title, which this segment can't be played through. The frames are
 * those of one segment, so the work is bounded by its length.
 */
static int fill(const TitleHls *title, const Sound *sound, Packets *packets, int64_t from,
                int64_t to, size_t *bytes) {
  AVRational base = sound_base(sound);
  int64_t first = av_rescale_q(sound->first, sound->base, base) -
                  av_rescale_q(title->cuts[0], title->video_base, base);
  int64_t slots[2] = {slot_at(title, sound, first, from), slot_at(title, sound, first, to)};
  if (!sound->silence) {
    int64_t edge = (int64_t)(EDGE_S * sound->rate / sound->frame);
    int64_t inside[2] = {slot_at(title, sound, first, title->cuts[0]) + edge,
                         slot_at(title, sound, first, title->cuts[title->count]) - edge};
    int i = 0;
    for (int64_t slot = slots[0]; slot < slots[1]; slot++) {
      int64_t at = first + slot * sound->frame;
      int heard = 0;
      for (; i < packets->count && packets->items[i]->pts <= at; i++)
        heard |= packets->items[i]->pts == at;
      if (!heard && slot >= inside[0] && slot < inside[1]) return 1;
    }
    return 0;
  }
  Packets out = {0};
  int i = 0, error = 0;
  for (int64_t slot = slots[0]; slot < slots[1]; slot++) {
    int64_t at = first + slot * sound->frame;
    int heard = 0;
    for (; i < packets->count && packets->items[i]->pts <= at; i++) {
      heard |= packets->items[i]->pts == at;
      if ((error = push(&out, packets->items[i])) < 0) goto end;
      packets->items[i] = NULL;
    }
    if (heard) continue;
    AVPacket *silent = av_packet_clone(sound->silence);
    if (!silent || (error = push(&out, silent)) < 0) {
      av_packet_free(&silent);
      error = error < 0 ? error : AVERROR(ENOMEM);
      goto end;
    }
    silent->pts = silent->dts = at;
    silent->duration = sound->frame;
    *bytes += (size_t)silent->size;
  }
  for (; i < packets->count; i++) {
    if ((error = push(&out, packets->items[i])) < 0) goto end;
    packets->items[i] = NULL;
  }
  release(packets);
  *packets = out;
  return 0;
end:
  release(&out);
  return error;
}

/**
 * Writes a packed audio segment of `packets`, frames on the grid of `sound`: an ID3 tag whose
 * PRIV frame gives the first frame's MPEG-2 transport stream time, then the frames as they are.
 */
static int pack(const Sound *sound, const Packets *packets, Bytes *made) {
  static const char OWNER[] = "com.apple.streaming.transportStreamTimestamp";
  // The tag's header, its frame's header, the owner with its NUL and the eight-byte time.
  enum { PRIV = sizeof(OWNER) + 8, TAG = 10 + 10 + PRIV };
  size_t size = TAG;
  for (int i = 0; i < packets->count; i++) size += (size_t)packets->items[i]->size;
  uint8_t *x = av_malloc(size);
  if (!x) return AVERROR(ENOMEM);
  // Sizes in ID3v2.4 are syncsafe, seven bits a byte; both fit in one.
  memcpy(x, "ID3\x04\x00\x00\x00\x00\x00", 9);
  x[9] = TAG - 10;
  memcpy(x + 10, "PRIV\x00\x00\x00", 7);
  x[17] = PRIV;
  x[18] = x[19] = 0;
  memcpy(x + 20, OWNER, sizeof(OWNER));
  int64_t at = packets->count ? av_rescale(packets->items[0]->pts, 90000, sound->rate) : 0;
  uint64_t clock = (uint64_t)at & ((UINT64_C(1) << 33) - 1);
  put32(x + 20 + sizeof(OWNER), (uint32_t)(clock >> 32));
  put32(x + 24 + sizeof(OWNER), (uint32_t)clock);
  size_t offset = TAG;
  for (int i = 0; i < packets->count; i++) {
    memcpy(x + offset, packets->items[i]->data, (size_t)packets->items[i]->size);
    offset += (size_t)packets->items[i]->size;
  }
  made->data = x;
  made->size = size;
  return 0;
}

/**
 * Writes one rendition: the fragment of `packets`, whose times are in `base`, or with `packets`
 * NULL the initialization segment, written from `sample`.
 */
static int mux(const AVStream *in, AVRational base, int frame, Packets *packets,
               const AVPacket *sample, int index, Bytes *made) {
  AVFormatContext *out = NULL;
  AVDictionary *options = NULL;
  AVIOContext *io = NULL;
  uint8_t *bytes = NULL;
  AVPacket *copy = NULL;
  int error = avformat_alloc_output_context2(&out, NULL, "mp4", NULL);
  if (error < 0) return error;
  AVStream *st = avformat_new_stream(out, NULL);
  if (!st) {
    error = AVERROR(ENOMEM);
    goto end;
  }
  if ((error = avcodec_parameters_copy(st->codecpar, in->codecpar)) < 0) goto end;
  st->codecpar->codec_tag = 0;
  if (st->codecpar->codec_id == AV_CODEC_ID_HEVC) st->codecpar->codec_tag = MKTAG('h', 'v', 'c', '1');
  if (frame) st->codecpar->frame_size = frame;
  st->time_base = base;
  out->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
  av_dict_set(&options, "movflags",
              "frag_custom+delay_moov+default_base_moof+negative_cts_offsets+frag_discont", 0);
  av_dict_set(&options, "use_editlist", "0", 0);
  av_dict_set_int(&options, "fragment_index", index + 1, 0);
  if ((error = avio_open_dyn_buf(&io)) < 0) goto end;
  out->pb = io;
  if ((error = avformat_write_header(out, &options)) < 0) goto end;
  if (packets) {
    for (int i = 0; i < packets->count; i++) {
      AVPacket *packet = packets->items[i];
      packet->stream_index = 0;
      av_packet_rescale_ts(packet, base, st->time_base);
      if ((error = av_write_frame(out, packet)) < 0) goto end;
    }
  } else if (sample) {
    if (!(copy = av_packet_clone(sample))) {
      error = AVERROR(ENOMEM);
      goto end;
    }
    copy->stream_index = 0;
    copy->pts = copy->dts = 0;
    copy->duration = frame ? frame : 1;
    av_packet_rescale_ts(copy, base, st->time_base);
    if ((error = av_write_frame(out, copy)) < 0) goto end;
  }
  // The first flush writes the header, the second the fragment.
  if ((error = av_write_frame(out, NULL)) < 0) goto end;
  if (packets && (error = av_write_frame(out, NULL)) < 0) goto end;
  int length = avio_close_dyn_buf(io, &bytes);
  io = NULL;
  size_t from = packets ? box_offset(bytes, (size_t)length, "moof", 0) : 0;
  size_t to = packets ? (size_t)length : box_offset(bytes, (size_t)length, "moov", 1);
  if (from == SIZE_MAX || to == SIZE_MAX || to < from) {
    error = AVERROR_INVALIDDATA;
    goto end;
  }
  made->data = av_malloc(to - from + 1);
  if (!made->data) {
    error = AVERROR(ENOMEM);
    goto end;
  }
  memcpy(made->data, bytes + from, to - from);
  made->size = to - from;
  error = 0;
end:
  av_free(bytes);
  av_packet_free(&copy);
  if (io) {
    uint8_t *rest = NULL;
    avio_close_dyn_buf(io, &rest);
    av_free(rest);
  }
  if (out) out->pb = NULL;
  avformat_free_context(out);
  av_dict_free(&options);
  return error;
}

/** Plans the cuts from the picture's index. */
static TitleHlsResult plan(TitleHls *title, char *detail, size_t detail_size) {
  AVStream *video = title->input->streams[title->video];
  int entries = avformat_index_get_entries_count(video);
  if (entries < 1) {
    say(detail, detail_size, "The file lists no keyframes to cut at.");
    return TITLE_HLS_UNSUPPORTED;
  }
  // Matroska says how long the file is; MP4 says how long each track is.
  int64_t end = AV_NOPTS_VALUE;
  if (title->input->duration > 0) {
    int64_t start = title->input->start_time == AV_NOPTS_VALUE ? 0 : title->input->start_time;
    end = av_rescale_q(start + title->input->duration, AV_TIME_BASE_Q, title->video_base);
  } else if (video->duration > 0) {
    end = (video->start_time == AV_NOPTS_VALUE ? 0 : video->start_time) + video->duration;
  }
  if (end == AV_NOPTS_VALUE) {
    say(detail, detail_size, "The file doesn't say how long it is.");
    return TITLE_HLS_UNSUPPORTED;
  }
  title->cuts = av_malloc_array(entries + 1, sizeof(*title->cuts));
  if (!title->cuts) return TITLE_HLS_NO_MEMORY;
  int64_t step = llrint(SEGMENT_S / av_q2d(title->video_base));
  int64_t most = llrint(SEGMENT_MOST_S / av_q2d(title->video_base));
  int64_t least = llrint(LAST_LEAST_S / av_q2d(title->video_base));
  int count = 0;
  int64_t last = AV_NOPTS_VALUE;
  for (int i = 0; i < entries; i++) {
    const AVIndexEntry *entry = avformat_index_get_entry(video, i);
    if (!(entry->flags & AVINDEX_KEYFRAME) || entry->timestamp >= end) continue;
    if (last != AV_NOPTS_VALUE && entry->timestamp <= last) continue;
    if (last != AV_NOPTS_VALUE && entry->timestamp - last > most) break;
    if (last == AV_NOPTS_VALUE || entry->timestamp - title->cuts[count - 1] >= step)
      title->cuts[count++] = entry->timestamp;
    last = entry->timestamp;
  }
  if (count == 0 || end - last > most) {
    say(detail, detail_size, "The file's keyframe index leaves out too much of it.");
    return TITLE_HLS_UNSUPPORTED;
  }
  if (count > 1 && end - title->cuts[count - 1] < least) count--;
  if (count > SEGMENTS_MOST) {
    say(detail, detail_size, "The file is too long.");
    return TITLE_HLS_UNSUPPORTED;
  }
  title->cuts[count] = end;
  title->count = count;
  return TITLE_HLS_OK;
}

/** The segment `at` seconds of the title fall in. */
static int segment_at(const TitleHls *title, double at) {
  int64_t ts = title->cuts[0] + llrint(at / av_q2d(title->video_base));
  int index = 0;
  while (index + 1 < title->count && title->cuts[index + 1] <= ts) index++;
  return index;
}

/** Reads the next packet of the offered tracks, taking any read ahead first. */
static int next_packet(TitleHls *title, Packets *ahead, int *at, AVPacket **out) {
  if (*at < ahead->count) {
    *out = ahead->items[*at];
    ahead->items[(*at)++] = NULL;
    return 0;
  }
  AVPacket *packet = av_packet_alloc();
  if (!packet) return AVERROR(ENOMEM);
  int error = av_read_frame(title->input, packet);
  if (error < 0) {
    av_packet_free(&packet);
    return error;
  }
  *out = packet;
  return 0;
}

/**
 * Moves the read to segment `index`'s cut, or one earlier when some offered sound track's first
 * packet there is already past the cut, so its sound may start before the cluster the seek
 * found. Read from the first cut, the lead comes first. What was read on the way stays in
 * `ahead`.
 */
static int reach(TitleHls *title, int index, Packets *ahead) {
  for (int from = index; from >= 0 && from >= index - 1; from--) {
    clear(ahead);
    int error = av_seek_frame(title->input, title->video, title->cuts[from], AVSEEK_FLAG_BACKWARD);
    if (error < 0) return error;
    for (int i = 0; from == 0 && i < title->lead.count; i++) {
      AVPacket *copy = av_packet_clone(title->lead.items[i]);
      if (!copy || push(ahead, copy) < 0) {
        av_packet_free(&copy);
        return AVERROR(ENOMEM);
      }
    }
    int seen[SOUNDS_MOST] = {0}, missing = title->sound_count, late = 0;
    int64_t until = title->cuts[index] + llrint(LATE_SOUND_S / av_q2d(title->video_base));
    for (int i = 0; missing > 0 && i < AHEAD_PACKETS_MOST; i++) {
      AVPacket *packet = i < ahead->count ? ahead->items[i] : av_packet_alloc();
      if (!packet) return AVERROR(ENOMEM);
      if (i == ahead->count) {
        if ((error = av_read_frame(title->input, packet)) < 0) {
          av_packet_free(&packet);
          if (error == AVERROR_EOF) break;
          return error;
        }
        if ((error = push(ahead, packet)) < 0) {
          av_packet_free(&packet);
          return error;
        }
      }
      Sound *sound = sound_of(title, packet);
      if (sound && packet->pts != AV_NOPTS_VALUE && !seen[sound - title->sounds]) {
        seen[sound - title->sounds] = 1;
        missing--;
        if (av_compare_ts(packet->pts, sound->base, title->cuts[index], title->video_base) >= 0)
          late = 1;
      }
      // A track with nothing near here has nothing to start before the cut either.
      if (packet->stream_index == title->video && packet->pts != AV_NOPTS_VALUE &&
          packet->pts >= until)
        break;
    }
    if (!late || from == 0 || from == index - 1) return 0;
  }
  return 0;
}

/**
 * Reads the file's first clusters, where opening left the read, up to the picture's first
 * keyframe, keeping the offered sound found there in the lead. A muxer may store sound ahead of
 * the picture, before the first cut's cluster, where a seek to the first cut doesn't read;
 * `prune` keeps only that. It reads LEAD_PACKETS_MOST packets and keeps LEAD_BYTES_MOST bytes at
 * most.
 */
static int read_lead(TitleHls *title) {
  for (int read = 0; read < LEAD_PACKETS_MOST && title->lead.bytes < LEAD_BYTES_MOST; read++) {
    AVPacket *packet = av_packet_alloc();
    if (!packet) return AVERROR(ENOMEM);
    int error = av_read_frame(title->input, packet);
    if (error < 0) {
      av_packet_free(&packet);
      return error == AVERROR_EOF ? 0 : error;
    }
    if (packet->stream_index == title->video && (packet->flags & AV_PKT_FLAG_KEY)) {
      av_packet_free(&packet);
      return 0;
    }
    if (!sound_of(title, packet) || packet->pts == AV_NOPTS_VALUE || packet->pos < 0 ||
        (error = push(&title->lead, packet)) < 0)
      av_packet_free(&packet);
    if (error < 0) return error;
  }
  return 0;
}

/** Keeps of the lead what lies before the cluster a seek to the first cut starts at. */
static void prune(TitleHls *title) {
  AVStream *video = title->input->streams[title->video];
  int index = av_index_search_timestamp(video, title->cuts[0], AVSEEK_FLAG_BACKWARD);
  const AVIndexEntry *entry = index >= 0 ? avformat_index_get_entry(video, index) : NULL;
  int kept = 0;
  for (int i = 0; i < title->lead.count; i++) {
    AVPacket *packet = title->lead.items[i];
    if (entry && packet->pos < entry->pos) {
      title->lead.items[kept++] = packet;
    } else {
      title->lead.bytes -= (size_t)packet->size;
      av_packet_free(&packet);
    }
  }
  title->lead.count = kept;
}

static int by_pts(const void *a, const void *b) {
  int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;
  return (x > y) - (x < y);
}

/**
 * Gives the segment's pictures their decode times and lengths: their presentation times sorted,
 * less the reorder delay, ending at the next cut, from title time 0, in the picture's base.
 */
static int stamp_pictures(const TitleHls *title, int index, Packets *pictures) {
  int64_t origin = title->cuts[0];
  int64_t *order = av_malloc_array(pictures->count ? pictures->count : 1, sizeof(*order));
  if (!order) return AVERROR(ENOMEM);
  for (int i = 0; i < pictures->count; i++) order[i] = pictures->items[i]->pts;
  qsort(order, pictures->count, sizeof(*order), by_pts);
  // How far the sorted times run ahead of the packets' own: the segment's reorder delay.
  int64_t delay = 0;
  for (int i = 0; i < pictures->count; i++) {
    if (order[i] - pictures->items[i]->pts > delay) delay = order[i] - pictures->items[i]->pts;
  }
  for (int i = 0; i < pictures->count; i++) {
    AVPacket *packet = pictures->items[i];
    int64_t following = i + 1 < pictures->count ? order[i + 1] : title->cuts[index + 1];
    packet->dts = order[i] - delay - origin;
    packet->duration = following - order[i];
    packet->pts -= origin;
  }
  av_free(order);
  return 0;
}

/** Gives a segment's sound its times in `sound_base`; on a frame grid, each one frame long. */
static void stamp_sound(const TitleHls *title, const Sound *sound, Packets *packets) {
  for (int i = 0; i < packets->count; i++) {
    AVPacket *packet = packets->items[i];
    int64_t at = sound_time(title, sound, packet);
    packet->duration = sound->frame ? sound->frame
                                    : av_rescale_q(packet->duration, sound->base, sound_base(sound));
    packet->pts = packet->dts = at;
  }
}

static void forget(Made *made) {
  for (int i = 0; i < 1 + SOUNDS_MOST; i++) av_freep(&made->renditions[i].data);
  memset(made, 0, sizeof(*made));
  made->index = -1;
}

/** Makes every rendition of segment `index` into a kept slot. */
static TitleHlsResult make(TitleHls *title, int index, Made **out, char *detail,
                           size_t detail_size) {
  if (atomic_load(&title->interrupted)) return TITLE_HLS_INTERRUPTED;
  int error = 0;
  if (title->next != index) {
    title->next = -1;
    if ((error = reach(title, index, &title->ahead)) < 0) {
      say(detail, detail_size, "The file couldn't be read at this point.");
      return failure(title, error);
    }
  }
  title->next = -1;
  int64_t start = title->cuts[index], end = title->cuts[index + 1];
  int64_t late = llrint(LATE_SOUND_S / av_q2d(title->video_base));
  int last = index == title->count - 1;
  Packets pictures = {0}, later = {0}, sound[SOUNDS_MOST] = {{0}};
  Packets ahead = title->ahead;
  title->ahead = (Packets){0};
  int at = 0;
  int picture_started = 0, picture_done = 0, sounds_left = title->sound_count;
  int sound_done[SOUNDS_MOST] = {0};
  size_t bytes = 0;
  TitleHlsResult result = TITLE_HLS_OK;
  while (!(picture_done && sounds_left == 0)) {
    AVPacket *packet = NULL;
    error = next_packet(title, &ahead, &at, &packet);
    if (error == AVERROR_EOF) break;
    if (error < 0) {
      result = failure(title, error);
      say(detail, detail_size, "The file couldn't be read at this point.");
      goto end;
    }
    Packets *into = NULL;
    Sound *track = sound_of(title, packet);
    if (packet->pts == AV_NOPTS_VALUE) {
      into = NULL;
    } else if (packet->stream_index == title->video) {
      int key = packet->flags & AV_PKT_FLAG_KEY;
      if (!picture_started) {
        // A seek can land before the cut's keyframe; nothing before it belongs here.
        if (key && packet->pts == start) picture_started = 1;
        else if (key && packet->pts > start) {
          result = TITLE_HLS_UNSUPPORTED;
          say(detail, detail_size, "The file's index names a keyframe it doesn't have.");
          av_packet_free(&packet);
          goto end;
        }
      } else if (!picture_done && !last && key && packet->pts >= end) {
        if (packet->pts > end) {
          result = TITLE_HLS_UNSUPPORTED;
          say(detail, detail_size, "The file's index names a keyframe it doesn't have.");
          av_packet_free(&packet);
          goto end;
        }
        picture_done = 1;
      }
      // Sound not heard of by now has nothing in this segment.
      if (picture_done && packet->pts - end >= late) {
        for (int t = 0; t < title->sound_count; t++) {
          if (!sound_done[t]) {
            sound_done[t] = 1;
            sounds_left--;
          }
        }
      }
      into = !picture_started ? NULL : picture_done ? &later : &pictures;
    } else if (track) {
      int t = (int)(track - title->sounds);
      if (sound_before(title, track, packet, start)) into = NULL;
      else if (last || sound_before(title, track, packet, end)) into = &sound[t];
      else {
        into = &later;
        if (!sound_done[t]) {
          sound_done[t] = 1;
          sounds_left--;
        }
      }
    }
    if (!into) {
      av_packet_free(&packet);
      continue;
    }
    if ((error = push(into, packet)) < 0) {
      av_packet_free(&packet);
      result = TITLE_HLS_NO_MEMORY;
      goto end;
    }
    if (into != &later) bytes += packet->size;
    if (bytes > SEGMENT_BYTES_MOST) {
      result = TITLE_HLS_UNSUPPORTED;
      say(detail, detail_size, "A stretch of the file is too large to play from memory.");
      goto end;
    }
    if (later.count > AHEAD_PACKETS_MOST) {
      result = TITLE_HLS_UNSUPPORTED;
      say(detail, detail_size, "The file's sound lies too far from its picture.");
      goto end;
    }
  }
  if (!picture_started) {
    result = TITLE_HLS_UNSUPPORTED;
    say(detail, detail_size, "The file's index names a keyframe it doesn't have.");
    goto end;
  }
  // The rest of what was read ahead follows what this segment read past its end.
  for (; at < ahead.count; at++) {
    if ((error = push(&later, ahead.items[at])) < 0) {
      result = TITLE_HLS_NO_MEMORY;
      goto end;
    }
    ahead.items[at] = NULL;
  }
  Made *slot = &title->kept[title->kept_next];
  title->kept_next = (title->kept_next + 1) % KEPT;
  forget(slot);
  AVStream *video = title->input->streams[title->video];
  if ((error = stamp_pictures(title, index, &pictures)) < 0 ||
      (error = mux(video, title->video_base, 0, &pictures, NULL, index, &slot->renditions[0])) < 0) {
    forget(slot);
    result = failure(title, error);
    say(detail, detail_size, "This part of the file can't be written as MP4.");
    goto end;
  }
  for (int t = 0; t < title->sound_count; t++) {
    Sound *track = &title->sounds[t];
    stamp_sound(title, track, &sound[t]);
    int gap = fill(title, track, &sound[t], start, end, &bytes);
    if (bytes > SEGMENT_BYTES_MOST) {
      forget(slot);
      result = TITLE_HLS_UNSUPPORTED;
      say(detail, detail_size, "A stretch of the file is too large to play from memory.");
      goto end;
    }
    // A rendition left empty is refused when asked for: a gap it can't be played through.
    if (gap == 1 || sound[t].count == 0) error = 0;
    else if (gap < 0) error = gap;
    else if (packed(title, track)) error = pack(track, &sound[t], &slot->renditions[1 + t]);
    else
      error = mux(title->input->streams[track->stream], sound_base(track), track->frame, &sound[t],
                  NULL, index, &slot->renditions[1 + t]);
    if (error < 0) {
      forget(slot);
      result = failure(title, error);
      say(detail, detail_size, "This part of the file can't be written as MP4.");
      goto end;
    }
  }
  slot->index = index;
  *out = slot;
  title->ahead = later;
  later = (Packets){0};
  title->next = last ? -1 : index + 1;
end:
  for (int i = at; i < ahead.count; i++) av_packet_free(&ahead.items[i]);
  ahead.count = 0;
  release(&ahead);
  release(&pictures);
  release(&later);
  for (int t = 0; t < SOUNDS_MOST; t++) release(&sound[t]);
  return result;
}

/**
 * Reaches segment `index` as a seek would, then takes the first keyframe and each offered sound
 * track's first packet read: these write the initialization segments, and the first sound
 * packets anchor the grids. What was read is the start of the first segment played, kept for
 * it. A track with no packet there isn't offered.
 */
static int sample(TitleHls *title, int index) {
  int error = reach(title, index, &title->ahead);
  if (error < 0) return error;
  for (int i = 0;; i++) {
    AVPacket *packet = NULL;
    if (i < title->ahead.count) {
      packet = title->ahead.items[i];
    } else {
      // Read on only for the picture, which the sound may have come well before.
      if (title->video_sample || title->ahead.count >= AHEAD_PACKETS_MOST) break;
      if (!(packet = av_packet_alloc())) return AVERROR(ENOMEM);
      if ((error = av_read_frame(title->input, packet)) < 0 ||
          (error = push(&title->ahead, packet)) < 0) {
        av_packet_free(&packet);
        if (error == AVERROR_EOF) break;
        return error;
      }
    }
    if (packet->pts == AV_NOPTS_VALUE) continue;
    Sound *sound = sound_of(title, packet);
    if (packet->stream_index == title->video && !title->video_sample &&
        (packet->flags & AV_PKT_FLAG_KEY)) {
      if (!(title->video_sample = av_packet_clone(packet))) return AVERROR(ENOMEM);
    } else if (sound && !sound->sample) {
      if (!(sound->sample = av_packet_clone(packet))) return AVERROR(ENOMEM);
      sound->first = packet->pts;
      sound->frame = sample_frame(title->input->streams[sound->stream]->codecpar, packet);
    }
  }
  int kept = 0;
  for (int i = 0; i < title->sound_count; i++) {
    if (title->sounds[i].sample) title->sounds[kept++] = title->sounds[i];
    else title->input->streams[title->sounds[i].stream]->discard = AVDISCARD_ALL;
  }
  for (int i = kept; i < SOUNDS_MOST; i++) memset(&title->sounds[i], 0, sizeof(title->sounds[i]));
  title->sound_count = kept;
  title->next = index;
  return title->video_sample ? 0 : AVERROR_INVALIDDATA;
}

/** Picks the picture and the sound tracks to offer; the rest isn't read. */
static TitleHlsResult choose(TitleHls *title, char *detail, size_t detail_size) {
  title->video = av_find_best_stream(title->input, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
  if (title->video < 0) {
    say(detail, detail_size, "The file has no picture.");
    return TITLE_HLS_UNSUPPORTED;
  }
  AVStream *video = title->input->streams[title->video];
  enum AVCodecID codec = video->codecpar->codec_id;
  if (codec != AV_CODEC_ID_H264 && codec != AV_CODEC_ID_HEVC) {
    say(detail, detail_size, "Its picture isn't H.264 or HEVC.");
    return TITLE_HLS_UNSUPPORTED;
  }
  title->video_base = video->time_base;
  int any = 0;
  for (unsigned i = 0; i < title->input->nb_streams; i++) {
    AVStream *st = title->input->streams[i];
    int offered = 0;
    if (st->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
      any = 1;
      if (sound_playable(st->codecpar) && st->codecpar->sample_rate > 0 &&
          title->sound_count < SOUNDS_MOST) {
        Sound *sound = &title->sounds[title->sound_count++];
        sound->stream = (int)i;
        sound->base = st->time_base;
        sound->rate = st->codecpar->sample_rate;
        sound->frame = sample_frame(st->codecpar, NULL);
        offered = 1;
      }
    }
    if ((int)i != title->video && !offered) st->discard = AVDISCARD_ALL;
  }
  if (any && title->sound_count == 0) {
    say(detail, detail_size, "Its sound isn't AAC-LC, HE-AAC, AC-3, E-AC-3 or MP3.");
    return TITLE_HLS_UNSUPPORTED;
  }
  return TITLE_HLS_OK;
}

TitleHlsResult title_hls_open(const TitleHlsSource *source, double start, TitleHls **out,
                              char *detail, size_t detail_size) {
  *out = NULL;
  TitleHls *title = av_mallocz(sizeof(*title));
  if (!title) return TITLE_HLS_NO_MEMORY;
  title->source = *source;
  title->next = -1;
  title->budget = -1;
  for (int i = 0; i < KEPT; i++) title->kept[i].index = -1;
  atomic_init(&title->interrupted, 0);
  TitleHlsResult result = TITLE_HLS_NO_MEMORY;
  int error = 0;
  uint8_t *buffer = av_malloc(IO_BUFFER);
  title->input = avformat_alloc_context();
  if (!buffer || !title->input) goto fail;
  title->input->pb = avio_alloc_context(buffer, IO_BUFFER, 0, title, read_packet, NULL, seek);
  if (!title->input->pb) goto fail;
  title->io = title->input->pb;
  buffer = NULL;
  title->input->interrupt_callback = (AVIOInterruptCB){interrupted, title};
  title->input->flags |= AVFMT_FLAG_CUSTOM_IO;
  error = avformat_open_input(&title->input, NULL, NULL, NULL);
  if (error == AVERROR_INVALIDDATA && !atomic_load(&title->interrupted)) {
    // Not Matroska or MP4 after all: AVPlayer gets to try it, as it always did.
    result = TITLE_HLS_DIRECT;
    goto fail;
  }
  if (error < 0) {
    result = failure(title, error);
    say(detail, detail_size, "The file isn't in a format this reads.");
    goto fail;
  }
  if (strstr(title->input->iformat->name, "mov")) {
    result = TITLE_HLS_DIRECT;
    goto fail;
  }
  if ((result = choose(title, detail, detail_size)) != TITLE_HLS_OK) goto fail;
  if ((error = read_lead(title)) < 0) {
    result = failure(title, error);
    say(detail, detail_size, "The file couldn't be read at its start.");
    goto fail;
  }
  // Matroska reads its index on the first seek.
  title->budget = INDEX_BYTES_MOST;
  error = av_seek_frame(title->input, title->video, 0, AVSEEK_FLAG_BACKWARD);
  int over = title->budget == 0;
  title->budget = -1;
  if (over) {
    result = TITLE_HLS_UNSUPPORTED;
    say(detail, detail_size, "The file lists no keyframes to cut at.");
    goto fail;
  }
  if (error < 0 && (result = failure(title, error)) != TITLE_HLS_UNSUPPORTED) goto fail;
  if ((result = plan(title, detail, detail_size)) != TITLE_HLS_OK) goto fail;
  prune(title);
  double length = seconds(title->cuts[title->count] - title->cuts[0], title->video_base);
  title->start = start > 0 && start < length ? start : 0;
  if ((error = sample(title, segment_at(title, title->start))) < 0) {
    result = failure(title, error);
    say(detail, detail_size, "The file couldn't be read where it starts playing.");
    goto fail;
  }
  AVStream *video = title->input->streams[title->video];
  if ((error = mux(video, title->video_base, 0, NULL, title->video_sample, 0,
                   &title->video_init)) < 0)
    goto unwritable;
  for (int t = 0; t < title->sound_count; t++) {
    Sound *sound = &title->sounds[t];
    AVStream *st = title->input->streams[sound->stream];
    if ((!packed(title, sound) &&
         (error = mux(st, sound_base(sound), sound->frame, NULL, sound->sample, 0, &sound->init)) <
             0) ||
        (error = silence_of(st->codecpar, sound->sample, &sound->silence)) < 0)
      goto unwritable;
  }
  *out = title;
  return TITLE_HLS_OK;
unwritable:
  result = failure(title, error);
  say(detail, detail_size, "The file's tracks can't be written as MP4.");
fail:
  av_free(buffer);
  title_hls_close(title);
  return result;
}

/** The CODECS attribute's entry for a track, or NULL when it can't be told. */
static const char *codec_name(const AVCodecParameters *par, char *out, size_t size) {
  const uint8_t *x = par->extradata;
  switch (par->codec_id) {
    case AV_CODEC_ID_H264:
      if (par->extradata_size < 4 || x[0] != 1) return NULL;
      snprintf(out, size, "avc1.%02X%02X%02X", x[1], x[2], x[3]);
      return out;
    case AV_CODEC_ID_AAC:
      // The audio object type, in the first five bits of the AudioSpecificConfig.
      if (par->extradata_size < 1) return NULL;
      snprintf(out, size, "mp4a.40.%d", x[0] >> 3);
      return out;
    case AV_CODEC_ID_AC3:
      av_strlcpy(out, "ac-3", size);
      return out;
    case AV_CODEC_ID_EAC3:
      av_strlcpy(out, "ec-3", size);
      return out;
    case AV_CODEC_ID_MP3:
      av_strlcpy(out, "mp4a.40.34", size);
      return out;
    default:
      return NULL;
  }
}

/** An attribute value without the characters a quoted string may not hold. */
static void quoted(AVBPrint *text, const char *value) {
  for (const char *c = value; *c; c++) {
    if (*c == ',') av_bprint_chars(text, ' ', 1);
    else if (*c != '"' && *c != '\n' && *c != '\r') av_bprint_chars(text, *c, 1);
  }
}

/**
 * The sound track the master playlist makes the default, which AVPlayer plays when a stream is
 * opened: the file's default, else its first.
 */
static int default_sound(const TitleHls *title) {
  for (int t = 0; t < title->sound_count; t++) {
    if (title->input->streams[title->sounds[t].stream]->disposition & AV_DISPOSITION_DEFAULT)
      return t;
  }
  return 0;
}

static void master(TitleHls *title, AVBPrint *text) {
  av_bprintf(text, "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n");
  if (title->start > 0)
    av_bprintf(text, "#EXT-X-START:TIME-OFFSET=%.3f,PRECISE=YES\n", title->start);
  int chosen = default_sound(title);
  for (int t = 0; t < title->sound_count; t++) {
    const AVStream *st = title->input->streams[title->sounds[t].stream];
    const AVDictionaryEntry *language = av_dict_get(st->metadata, "language", NULL, 0);
    const AVDictionaryEntry *name = av_dict_get(st->metadata, "title", NULL, 0);
    int known = language && *language->value && strcmp(language->value, "und") != 0;
    // Names are unique within the group: the track's own, else its language, and its number.
    av_bprintf(text, "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"");
    if (name && *name->value) quoted(text, name->value);
    else if (known) quoted(text, language->value);
    else av_bprintf(text, "Sound");
    av_bprintf(text, " %d\"", t + 1);
    if (known) {
      av_bprintf(text, ",LANGUAGE=\"");
      quoted(text, language->value);
      av_bprintf(text, "\"");
    }
    av_bprintf(text, ",DEFAULT=%s,AUTOSELECT=YES,CHANNELS=\"%d\",URI=\"a%d.m3u8\"\n",
               t == chosen ? "YES" : "NO", st->codecpar->ch_layout.nb_channels, t);
  }
  const AVStream *video = title->input->streams[title->video];
  double length = seconds(title->cuts[title->count] - title->cuts[0], title->video_base);
  int64_t bandwidth = title->input->bit_rate;
  if (bandwidth <= 0 && title->source.size > 0 && length > 0)
    bandwidth = (int64_t)(title->source.size * 8 / length);
  if (bandwidth <= 0) bandwidth = 1000000;
  av_bprintf(text, "#EXT-X-STREAM-INF:BANDWIDTH=%lld", (long long)bandwidth);
  // Every codec of the variant, or none when one can't be named.
  char names[(1 + SOUNDS_MOST) * 24] = "", one[24];
  int named = codec_name(video->codecpar, one, sizeof(one)) != NULL;
  if (named) av_strlcat(names, one, sizeof(names));
  for (int t = 0; named && t < title->sound_count; t++) {
    const AVCodecParameters *par = title->input->streams[title->sounds[t].stream]->codecpar;
    if (!codec_name(par, one, sizeof(one))) named = 0;
    else if (!strstr(names, one)) {
      av_strlcat(names, ",", sizeof(names));
      av_strlcat(names, one, sizeof(names));
    }
  }
  if (named) av_bprintf(text, ",CODECS=\"%s\"", names);
  if (video->codecpar->width > 0)
    av_bprintf(text, ",RESOLUTION=%dx%d", video->codecpar->width, video->codecpar->height);
  if (title->sound_count) av_bprintf(text, ",AUDIO=\"audio\"");
  av_bprintf(text, "\nv.m3u8\n");
}

/**
 * A rendition's media playlist: "v" for the picture, "a<n>" for a sound track. Packed audio has
 * no initialization segment, and its segments are .mp3.
 */
static void media(TitleHls *title, const char *rendition, AVBPrint *text) {
  int track = rendition[0] == 'a' ? atoi(rendition + 1) : -1;
  int raw = track >= 0 && packed(title, &title->sounds[track]);
  double target = 0;
  for (int i = 0; i < title->count; i++) {
    double length = seconds(title->cuts[i + 1] - title->cuts[i], title->video_base);
    if (length > target) target = length;
  }
  av_bprintf(text,
             "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:%d\n#EXT-X-PLAYLIST-TYPE:VOD\n"
             "#EXT-X-INDEPENDENT-SEGMENTS\n",
             (int)ceil(target));
  if (title->start > 0)
    av_bprintf(text, "#EXT-X-START:TIME-OFFSET=%.3f,PRECISE=YES\n", title->start);
  if (!raw) av_bprintf(text, "#EXT-X-MAP:URI=\"%s.mp4\"\n", rendition);
  for (int i = 0; i < title->count; i++) {
    av_bprintf(text, "#EXTINF:%.6f,\n%s%s%d.%s\n",
               seconds(title->cuts[i + 1] - title->cuts[i], title->video_base), rendition,
               track >= 0 ? "-" : "", i, raw ? "mp3" : "m4s");
  }
  av_bprintf(text, "#EXT-X-ENDLIST\n");
}

/** Parses "<prefix><n><suffix>" exactly, such as "a2-14.m4s"; -1 when `name` isn't that. */
static int numbered(const char *name, const char *prefix, const char *suffix, const char **rest) {
  size_t length = strlen(prefix);
  if (strncmp(name, prefix, length) != 0) return -1;
  const char *digits = name + length;
  char *after = NULL;
  long value = strtol(digits, &after, 10);
  if (after == digits || value < 0 || value > SEGMENTS_MOST) return -1;
  if (rest) {
    *rest = after;
    return (int)value;
  }
  return strcmp(after, suffix) == 0 ? (int)value : -1;
}

TitleHlsResult title_hls_get(TitleHls *title, const char *name, const uint8_t **data,
                             size_t *size, const char **type, char *detail, size_t detail_size) {
  *data = NULL;
  *size = 0;
  *type = MP4;
  int track = numbered(name, "a", ".m3u8", NULL);
  if (strcmp(name, "main.m3u8") == 0 || strcmp(name, "v.m3u8") == 0 ||
      (track >= 0 && track < title->sound_count)) {
    // A playlist: written now, kept until the next request.
    AVBPrint text;
    av_bprint_init(&text, 0, AV_BPRINT_SIZE_UNLIMITED);
    if (name[0] == 'm') master(title, &text);
    else if (name[0] == 'v') media(title, "v", &text);
    else {
      char rendition[16];
      snprintf(rendition, sizeof(rendition), "a%d", track);
      media(title, rendition, &text);
    }
    av_freep(&title->text);
    if (!av_bprint_is_complete(&text) || av_bprint_finalize(&text, &title->text) < 0)
      return TITLE_HLS_NO_MEMORY;
    *data = (const uint8_t *)title->text;
    *size = strlen(title->text);
    *type = MPEGURL;
    return TITLE_HLS_OK;
  }
  if (strcmp(name, "v.mp4") == 0) {
    *data = title->video_init.data;
    *size = title->video_init.size;
    return TITLE_HLS_OK;
  }
  track = numbered(name, "a", ".mp4", NULL);
  if (track >= 0 && track < title->sound_count && !packed(title, &title->sounds[track])) {
    *data = title->sounds[track].init.data;
    *size = title->sounds[track].init.size;
    return TITLE_HLS_OK;
  }
  int rendition = -1, index = numbered(name, "v", ".m4s", NULL);
  if (index >= 0) rendition = 0;
  const char *rest = NULL;
  track = numbered(name, "a", NULL, &rest);
  if (track >= 0 && track < title->sound_count && *rest == '-') {
    int raw = packed(title, &title->sounds[track]);
    index = numbered(rest, "-", raw ? ".mp3" : ".m4s", NULL);
    if (index >= 0) rendition = 1 + track;
    if (raw) *type = MPEG_AUDIO;
  }
  if (rendition < 0 || index < 0 || index >= title->count) return TITLE_HLS_MISSING;
  Made *made = NULL;
  for (int i = 0; i < KEPT; i++) {
    if (title->kept[i].index == index) made = &title->kept[i];
  }
  if (!made) {
    TitleHlsResult result = make(title, index, &made, detail, detail_size);
    if (result != TITLE_HLS_OK) return result;
  }
  // The session fails with this; Try again opens the title anew, from where it stopped, with the
  // default sound.
  if (!made->renditions[rendition].data) {
    say(detail, detail_size,
        rendition - 1 == default_sound(title)
            ? "Its sound has a gap here that can't be played."
            : "The chosen sound has a gap here that can't be played. Try again goes on from here "
              "with the title's main sound.");
    return TITLE_HLS_UNSUPPORTED;
  }
  *data = made->renditions[rendition].data;
  *size = made->renditions[rendition].size;
  return TITLE_HLS_OK;
}

int title_hls_sound_stream(const TitleHls *title, int track) {
  return track >= 0 && track < title->sound_count ? title->sounds[track].stream : -1;
}

void title_hls_interrupt(TitleHls *title) { atomic_store(&title->interrupted, 1); }

void title_hls_close(TitleHls *title) {
  if (!title) return;
  release(&title->ahead);
  release(&title->lead);
  for (int i = 0; i < KEPT; i++) forget(&title->kept[i]);
  for (int t = 0; t < SOUNDS_MOST; t++) {
    av_packet_free(&title->sounds[t].sample);
    av_free(title->sounds[t].init.data);
    av_packet_free(&title->sounds[t].silence);
  }
  av_packet_free(&title->video_sample);
  av_free(title->video_init.data);
  av_free(title->text);
  // The input context is closed first; with custom I/O it leaves the I/O context to its owner.
  avformat_close_input(&title->input);
  if (title->io) {
    av_freep(&title->io->buffer);
    avio_context_free(&title->io);
  }
  av_free(title->cuts);
  av_free(title);
}
