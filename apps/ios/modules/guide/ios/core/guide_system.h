#ifndef MR_GUIDE_SYSTEM_H
#define MR_GUIDE_SYSTEM_H
#include <stdint.h>
/* Return 0 on complete gzip including every member/trailer, 1 invalid, 2 limit,
   3 cancelled/deadline/disk callback refusal, 4 IO. Input and output are private spools. */
typedef int (*mr_guide_check)(void *context);
int mr_guide_inflate(const char *input, const char *output, uint64_t limit,
                     mr_guide_check check, void *context);
#endif
