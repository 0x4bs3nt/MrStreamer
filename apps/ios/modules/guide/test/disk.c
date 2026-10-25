#define _POSIX_C_SOURCE 200809L
#include "guide_system.h"
#include <sqlite3.h>
#include <assert.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MIB (1024ULL * 1024ULL)
typedef struct { int mode; uint64_t temp_attempts; } Policy;
static int limits(void *raw, int flags, uint64_t used, uint64_t growth, uint64_t *total, uint64_t *available) {
  Policy *p = raw;
  if (!growth) return 0;
  if (flags & (SQLITE_OPEN_TRANSIENT_DB | SQLITE_OPEN_TEMP_DB | SQLITE_OPEN_TEMP_JOURNAL | SQLITE_OPEN_SUBJOURNAL)) p->temp_attempts++;
  if (p->mode == 1 || (p->mode == 4 && (flags & (SQLITE_OPEN_TRANSIENT_DB | SQLITE_OPEN_TEMP_DB | SQLITE_OPEN_TEMP_JOURNAL | SQLITE_OPEN_SUBJOURNAL)))) *total = used + growth - 1;
  if (p->mode == 5 && (flags & SQLITE_OPEN_MAIN_DB)) *total = used + growth - 1;
  if (p->mode == 2) *available = 256 * MIB + growth - 1;
  return p->mode == 3;
}
static int files(const char *root) {
  DIR *d = opendir(root); assert(d);
  int count = 0; struct dirent *e;
  while ((e = readdir(d))) if (e->d_name[0] != '.' || !strncmp(e->d_name, ".guide-", 7)) count++;
  closedir(d); return count;
}
static void exec_ok(sqlite3 *db, const char *sql) { assert(sqlite3_exec(db, sql, NULL, NULL, NULL) == SQLITE_OK); }
typedef struct {
  pthread_mutex_t lock;
  pthread_cond_t changed;
  unsigned finished;
  sqlite3_vfs *vfs;
} Concurrent;
typedef struct { Concurrent *gate; sqlite3_int64 size; } Writer;
static void *concurrent_write(void *raw) {
  Writer *writer = raw; Concurrent *gate = writer->gate;
  sqlite3_file *f = calloc(1, (size_t)gate->vfs->szOsFile); assert(f);
  assert(gate->vfs->xOpen(gate->vfs, NULL, f, SQLITE_OPEN_TEMP_JOURNAL | SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_DELETEONCLOSE, NULL) == SQLITE_OK);
  char data[1024]; memset(data, 't', sizeof(data));
  for (unsigned n = 0; n < 100; n++) {
    int result = f->pMethods->xWrite(f, data, sizeof(data), (sqlite3_int64)n * sizeof(data));
    if (result == SQLITE_FULL) break;
    assert(result == SQLITE_OK);
  }
  assert(f->pMethods->xFileSize(f, &writer->size) == SQLITE_OK);
  pthread_mutex_lock(&gate->lock);
  gate->finished++; pthread_cond_broadcast(&gate->changed);
  while (gate->finished < 2) pthread_cond_wait(&gate->changed, &gate->lock);
  pthread_mutex_unlock(&gate->lock);
  assert(f->pMethods->xClose(f) == SQLITE_OK); free(f); return NULL;
}
int main(int argc, char **argv) {
  assert(argc == 2);
  const char *root = argv[1]; assert(mkdir(root, 0700) == 0);
  sqlite3_vfs *default_before = sqlite3_vfs_find(NULL);
  mr_guide_disk *disk = mr_guide_disk_create(root, 256 * MIB, 256 * MIB, 32 * MIB); assert(disk);
  Policy policy = {0};
  mr_guide_vfs *registration = mr_guide_vfs_create(disk, limits, &policy); assert(registration);
  mr_guide_vfs *second = mr_guide_vfs_create(disk, NULL, NULL); assert(second);
  assert(strcmp(mr_guide_vfs_name(registration), mr_guide_vfs_name(second)));
  assert(sqlite3_vfs_find(NULL) == default_before);
  assert(mr_guide_vfs_destroy(second) == SQLITE_OK);
  sqlite3_vfs *vfs = sqlite3_vfs_find(mr_guide_vfs_name(registration)); assert(vfs);
  sqlite3_file *file = calloc(1, (size_t)vfs->szOsFile); assert(file);
  int flags = SQLITE_OPEN_TEMP_DB | SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_DELETEONCLOSE;
  assert(vfs->xOpen(vfs, NULL, file, flags, NULL) == SQLITE_OK);
  assert(mr_guide_vfs_destroy(registration) == SQLITE_BUSY);
  char bytes[1024]; memset(bytes, 'x', sizeof(bytes));
  assert(file->pMethods->xWrite(file, bytes, sizeof(bytes), 0) == SQLITE_OK);
  assert(files(root) == 1); /* Temp stays named and therefore counted while open. */
  sqlite3_int64 before = 0; assert(file->pMethods->xFileSize(file, &before) == SQLITE_OK && before == 1024);
  sqlite3_int64 hint = INT64_MAX;
  assert(file->pMethods->xFileControl(file, SQLITE_FCNTL_SIZE_HINT, &hint) == SQLITE_OK);
  sqlite3_int64 after = 0; assert(file->pMethods->xFileSize(file, &after) == SQLITE_OK && after == before);
  void *mapped = (void *)1; assert(file->pMethods->xFetch(file, 0, 512, &mapped) == SQLITE_OK && mapped == NULL);
  for (policy.mode = 1; policy.mode <= 3; policy.mode++) {
    assert(file->pMethods->xWrite(file, bytes, sizeof(bytes), 1024) != SQLITE_OK);
    assert(file->pMethods->xTruncate(file, 2048) != SQLITE_OK);
    assert(file->pMethods->xFileSize(file, &after) == SQLITE_OK && after == before);
  }
  policy.mode = 0;
  assert(file->pMethods->xWrite(file, bytes, 16, INT64_MAX - 8) == SQLITE_FULL);
  assert(file->pMethods->xTruncate(file, INT64_MAX) == SQLITE_FULL);
  assert(file->pMethods->xClose(file) == SQLITE_OK); free(file);
  assert(files(root) == 0);
  char dbpath[4096]; snprintf(dbpath, sizeof(dbpath), "%s/test.sqlite", root);
  sqlite3 *db = NULL;
  assert(sqlite3_open_v2(dbpath, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, mr_guide_vfs_name(registration)) == SQLITE_OK);
  exec_ok(db, "PRAGMA temp_store=FILE; PRAGMA cache_size=-32; PRAGMA mmap_size=0; CREATE TABLE data(n INTEGER, payload TEXT); WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<4096) INSERT INTO data SELECT n, printf('%08d',n)||hex(zeroblob(512)) FROM x;");
  uint64_t attempts_before = policy.temp_attempts;
  sqlite3_stmt *statement = NULL;
  policy.mode = 4;
  assert(sqlite3_prepare_v2(db, "SELECT payload FROM data ORDER BY payload DESC", -1, &statement, NULL) == SQLITE_OK);
  assert(sqlite3_step(statement) != SQLITE_ROW); sqlite3_finalize(statement);
  assert(policy.temp_attempts > attempts_before); /* Refusal during a real spilled SQL sort. */
  policy.mode = 0;
  assert(sqlite3_prepare_v2(db, "SELECT count(*) FROM data", -1, &statement, NULL) == SQLITE_OK);
  assert(sqlite3_step(statement) == SQLITE_ROW && sqlite3_column_int(statement, 0) == 4096); sqlite3_finalize(statement);
  char *identity = NULL;
  assert(sqlite3_file_control(db, "main", SQLITE_FCNTL_VFSNAME, &identity) == SQLITE_OK);
  assert(!strcmp(identity, mr_guide_vfs_name(registration))); sqlite3_free(identity);
  char compact_path[4096]; snprintf(compact_path, sizeof(compact_path), "%s/compact.sqlite", root);
  char *compact_sql = sqlite3_mprintf("VACUUM INTO %Q", compact_path); assert(compact_sql);
  policy.mode = 5;
  assert(sqlite3_exec(db, compact_sql, NULL, NULL, NULL) != SQLITE_OK);
  unlink(compact_path);
  policy.mode = 0;
  exec_ok(db, compact_sql); sqlite3_free(compact_sql);
  assert(sqlite3_close(db) == SQLITE_OK);
  assert(mr_guide_disk_replace(disk, compact_path, dbpath) == SQLITE_OK);
  mr_guide_disk_stats stats = mr_guide_disk_inspect(disk);
  assert(stats.open_files == 0 && stats.temp_files == 0 && stats.temp_growth > 0 && stats.refusals >= 4 && stats.peak <= 256 * MIB);
  assert(mr_guide_vfs_destroy(registration) == SQLITE_OK);
  assert(sqlite3_vfs_find(NULL) == default_before);
  char threads_root[4096]; snprintf(threads_root, sizeof(threads_root), "%s/threads", root);
  assert(mkdir(threads_root, 0700) == 0);
  mr_guide_disk *parallel = mr_guide_disk_create(threads_root, 65536, 256 * MIB, 32 * MIB); assert(parallel);
  mr_guide_vfs *parallel_vfs = mr_guide_vfs_create(parallel, NULL, NULL); assert(parallel_vfs);
  Concurrent concurrent = {PTHREAD_MUTEX_INITIALIZER, PTHREAD_COND_INITIALIZER, 0, sqlite3_vfs_find(mr_guide_vfs_name(parallel_vfs))};
  Writer writers[2] = {{&concurrent, 0}, {&concurrent, 0}};
  pthread_t threads[2];
  for (unsigned n = 0; n < 2; n++) assert(pthread_create(&threads[n], NULL, concurrent_write, &writers[n]) == 0);
  for (unsigned n = 0; n < 2; n++) assert(pthread_join(threads[n], NULL) == 0);
  assert(writers[0].size + writers[1].size == 65536);
  assert(mr_guide_disk_inspect(parallel).peak == 65536 && mr_guide_disk_inspect(parallel).open_files == 0);
  assert(mr_guide_vfs_destroy(parallel_vfs) == SQLITE_OK);
  mr_guide_disk_destroy(parallel); assert(rmdir(threads_root) == 0);
  pthread_cond_destroy(&concurrent.changed); pthread_mutex_destroy(&concurrent.lock);
  /* Zero-byte metadata and overwrite/rename/deletion must work below the growth floor. */
  mr_guide_disk *low = mr_guide_disk_create(root, 256 * MIB, UINT64_MAX / 2, 32 * MIB); assert(low);
  char marker[4096], renamed[4096];
  snprintf(marker, sizeof(marker), "%s/revoked", root);
  snprintf(renamed, sizeof(renamed), "%s/renamed", root);
  assert(mr_guide_disk_atomic(low, marker, NULL, 0) == SQLITE_OK);
  struct stat metadata; assert(stat(marker, &metadata) == 0 && metadata.st_size == 0);
  assert(mr_guide_disk_atomic(low, renamed, "x", 1) == SQLITE_FULL);
  assert(mr_guide_disk_replace(low, marker, renamed) == SQLITE_OK);
  int fd = open(dbpath, O_WRONLY); assert(fd >= 0);
  assert(mr_guide_disk_write(low, dbpath, fd, "x", 1) == SQLITE_OK); assert(close(fd) == 0);
  assert(unlink(renamed) == 0);
  assert(mr_guide_disk_atomic(low, root, NULL, 0) != SQLITE_OK); /* Real rename error remains visible. */
  mr_guide_disk_destroy(low);
  mr_guide_disk_destroy(disk);
  assert(unlink(dbpath) == 0 && files(root) == 0 && rmdir(root) == 0);
  puts("PASS production disk/VFS: default preserved, unique registrations, visible temp lifetimes, overflow, hint/mmap bypasses, before-growth total/free refusals, real spilled-sort refusal, last-good SQL and VACUUM cleanup");
  return 0;
}
