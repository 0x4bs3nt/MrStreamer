#include "guide_system.h"
#include <stdio.h>
#include <string.h>
#include <zlib.h>

int mr_guide_inflate(const char *input, const char *output, uint64_t limit,
                     mr_guide_check check, void *context) {
  FILE *in = fopen(input, "rb"), *out = NULL;
  if (!in) return 4;
  out = fopen(output, "wb");
  if (!out) { fclose(in); return 4; }
  unsigned char src[65536], dst[65536];
  z_stream stream;
  memset(&stream, 0, sizeof(stream));
  int result = 1, complete = 0;
  uint64_t total = 0;
  if (inflateInit2(&stream, MAX_WBITS + 16) != Z_OK) goto files;
  for (;;) {
    if (check && check(context)) { result = 3; break; }
    if (!stream.avail_in) {
      size_t count = fread(src, 1, sizeof(src), in);
      if (!count) { result = ferror(in) ? 4 : (complete ? 0 : 1); break; }
      stream.next_in = src;
      stream.avail_in = (uInt)count;
    }
    if (complete) {
      if (inflateReset2(&stream, MAX_WBITS + 16) != Z_OK) break;
      complete = 0;
    }
    stream.next_out = dst;
    stream.avail_out = sizeof(dst);
    int code = inflate(&stream, Z_NO_FLUSH);
    size_t wrote = sizeof(dst) - stream.avail_out;
    total += wrote;
    if (total > limit) { result = 2; break; }
    if (fwrite(dst, 1, wrote, out) != wrote) { result = 4; break; }
    if (code == Z_STREAM_END) complete = 1;
    else if (code != Z_OK || (!wrote && !stream.avail_in && feof(in))) break;
  }
  inflateEnd(&stream);
files:
  if (fclose(out) != 0 && result == 0) result = 4;
  fclose(in);
  if (result) remove(output);
  return result;
}
