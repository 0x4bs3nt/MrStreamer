#ifndef MR_GUIDE_SYSTEM_H
#define MR_GUIDE_SYSTEM_H
#include <stdint.h>
#include <stddef.h>
typedef struct mr_guide_disk mr_guide_disk;
/* Return 0 on complete gzip including every member/trailer, 1 invalid, 2 limit,
   3 cancelled/deadline/disk callback refusal, 4 IO. Input and output are private spools. */
typedef int (*mr_guide_check)(void *context);
int mr_guide_inflate(const char *input, const char *output, uint64_t limit, mr_guide_disk *disk,
                     mr_guide_check check, void *context);

/* Guide-private IO. A disk gate is shared by all connections and spools of one owner.
   The VFS is registered under a unique name, never as SQLite's process default. */
typedef struct mr_guide_vfs mr_guide_vfs;
/* Called before IO under the disk mutex. Limits may only be lowered. Returning nonzero
   aborts the IO. The callback must not reenter this disk gate. No paths cross it. */
typedef int (*mr_guide_io_check)(void *, int flags, uint64_t used, uint64_t growth,
                               uint64_t *total_limit, uint64_t *available);
typedef struct {
  uint64_t checks, sql_growth, temp_growth, refusals, peak;
  uint64_t open_files, temp_files;
} mr_guide_disk_stats;
mr_guide_disk *mr_guide_disk_create(const char *root, uint64_t total,
                                  uint64_t floor, uint64_t database);
void mr_guide_disk_destroy(mr_guide_disk *);
int mr_guide_disk_check(mr_guide_disk *);
int mr_guide_disk_open(mr_guide_disk *, const char *path);
int mr_guide_disk_write(mr_guide_disk *, const char *path, int fd,
                        const void *, size_t);
int mr_guide_disk_atomic(mr_guide_disk *, const char *path, const void *, size_t);
int mr_guide_disk_replace(mr_guide_disk *, const char *source, const char *target);
mr_guide_disk_stats mr_guide_disk_inspect(mr_guide_disk *);
mr_guide_vfs *mr_guide_vfs_create(mr_guide_disk *, mr_guide_io_check, void *);
const char *mr_guide_vfs_name(mr_guide_vfs *);
/* Call only after every statement/connection using it is closed. Returns SQLITE_BUSY
   and retains the registration if files remain, rather than freeing live IO state. */
int mr_guide_vfs_destroy(mr_guide_vfs *);
#endif
