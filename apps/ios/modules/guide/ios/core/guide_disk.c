#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700
#include "guide_system.h"
#include <sqlite3.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

struct mr_guide_disk {
  pthread_mutex_t lock;
  char *root;
  uint64_t total, floor, database;
  unsigned references;
  mr_guide_disk_stats stats;
};
struct mr_guide_vfs {
  sqlite3_vfs base;
  sqlite3_vfs *original;
  mr_guide_disk *disk;
  mr_guide_io_check check;
  void *context;
  unsigned open;
  char name[64];
};
typedef struct {
  sqlite3_file base;
  sqlite3_file *original; /* calloc has native malloc alignment, independent of szOsFile. */
  mr_guide_vfs *vfs;
  char *path;
  sqlite3_filename generated;
  int flags, remove_on_close;
} GuideFile;

/* Root scanning sees every file, including temps: DELETEONCLOSE is implemented by this
   wrapper so the underlying Unix VFS cannot unlink a still-growing temp on open. */
static int scan(const char *root, uint64_t *bytes, unsigned depth, unsigned *entries) {
  if (depth > 16) return SQLITE_FULL;
  DIR *dir = opendir(root);
  if (!dir) return SQLITE_IOERR_ACCESS;
  int result = SQLITE_OK;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(dir))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++*entries > 20000) { result = SQLITE_FULL; break; }
    char path[PATH_MAX];
    int n = snprintf(path, sizeof(path), "%s/%s", root, entry->d_name);
    if (n < 0 || (size_t)n >= sizeof(path)) { result = SQLITE_CANTOPEN; break; }
    struct stat st;
    if (lstat(path, &st)) {
      if (errno == ENOENT) { errno = 0; continue; } /* An old unpinned generation was pruned. */
      result = SQLITE_IOERR_FSTAT; break;
    }
    if (S_ISDIR(st.st_mode)) result = scan(path, bytes, depth + 1, entries);
    else if (!S_ISREG(st.st_mode) || st.st_size < 0 || UINT64_MAX - *bytes < (uint64_t)st.st_size) result = SQLITE_IOERR_ACCESS;
    else *bytes += (uint64_t)st.st_size;
    if (result != SQLITE_OK) break;
    errno = 0;
  }
  if (!entry && errno && result == SQLITE_OK) result = SQLITE_IOERR_READ;
  closedir(dir);
  return result;
}
static int owned(mr_guide_disk *disk, const char *path) {
  if (!path || path[0] != '/' || strlen(path) >= PATH_MAX) return 0;
  char parent[PATH_MAX], resolved[PATH_MAX];
  strcpy(parent, path);
  char *slash = strrchr(parent, '/');
  if (!slash || !slash[1] || !strcmp(slash + 1, ".") || !strcmp(slash + 1, "..")) return 0;
  *slash = 0;
  if (!realpath(parent, resolved)) return 0;
  size_t n = strlen(disk->root);
  if (strncmp(resolved, disk->root, n) || (resolved[n] && resolved[n] != '/')) return 0;
  struct stat st;
  if (lstat(path, &st) == 0) return S_ISREG(st.st_mode);
  return errno == ENOENT;
}
static int capacity(mr_guide_disk *disk, uint64_t growth, int flags,
                    mr_guide_io_check check, void *context) {
  if (!growth) {
    // Metadata, overwrite and rename do not consume the guide growth reserve. A cancelled
    // SQLite job still gets its guard; the underlying operation reports real OS IO failures.
    uint64_t total = disk->total, available = UINT64_MAX;
    disk->stats.checks++;
    return check && check(context, flags, 0, 0, &total, &available) ? SQLITE_IOERR_WRITE : SQLITE_OK;
  }
  uint64_t used = 0;
  unsigned entries = 0;
  int code = scan(disk->root, &used, 0, &entries);
  if (code != SQLITE_OK) return code;
  struct statvfs fs;
  if (statvfs(disk->root, &fs)) return SQLITE_IOERR_FSTAT;
  uint64_t unit = fs.f_frsize ? (uint64_t)fs.f_frsize : (uint64_t)fs.f_bsize;
  if (!unit || (uint64_t)fs.f_bavail > UINT64_MAX / unit) return SQLITE_FULL;
  uint64_t available = (uint64_t)fs.f_bavail * unit;
  uint64_t total = disk->total, proposed_available = available, proposed_total = total;
  disk->stats.checks++;
  if (check && check(context, flags, used, growth, &proposed_total, &proposed_available)) return SQLITE_IOERR_WRITE;
  if (proposed_total < total) total = proposed_total;
  if (proposed_available < available) available = proposed_available;
  /* Reserve the rounded allocation plus 64 KiB for filesystem metadata/COW overhead.
     Other apps can consume physical space concurrently; this is a before-growth refusal. */
  if (growth > UINT64_MAX - (unit - 1)) return SQLITE_FULL;
  uint64_t reserve = ((growth + unit - 1) / unit) * unit;
  if (reserve > UINT64_MAX - 65536) return SQLITE_FULL;
  reserve += 65536;
  if (used > total || growth > total - used || available < disk->floor || reserve > available - disk->floor) {
    disk->stats.refusals++; return SQLITE_FULL;
  }
  if (used + growth > disk->stats.peak) disk->stats.peak = used + growth;
  if (growth && flags) disk->stats.sql_growth++;
  if (growth && (flags & (SQLITE_OPEN_TEMP_DB | SQLITE_OPEN_TRANSIENT_DB | SQLITE_OPEN_TEMP_JOURNAL | SQLITE_OPEN_SUBJOURNAL))) disk->stats.temp_growth++;
  return SQLITE_OK;
}
mr_guide_disk *mr_guide_disk_create(const char *root, uint64_t total, uint64_t floor, uint64_t database) {
  if (!root || !total || !database) return NULL;
  char resolved[PATH_MAX];
  if (!realpath(root, resolved)) return NULL;
  mr_guide_disk *disk = calloc(1, sizeof(*disk));
  if (!disk) return NULL;
  disk->root = strdup(resolved);
  if (!disk->root || pthread_mutex_init(&disk->lock, NULL)) { free(disk->root); free(disk); return NULL; }
  disk->total = total; disk->floor = floor; disk->database = database; disk->references = 1;
  return disk;
}
void mr_guide_disk_destroy(mr_guide_disk *disk) {
  if (!disk) return;
  pthread_mutex_lock(&disk->lock);
  unsigned remaining = --disk->references;
  pthread_mutex_unlock(&disk->lock);
  if (!remaining) { pthread_mutex_destroy(&disk->lock); free(disk->root); free(disk); }
}
int mr_guide_disk_check(mr_guide_disk *disk) {
  pthread_mutex_lock(&disk->lock);
  int code = capacity(disk, 0, 0, NULL, NULL);
  pthread_mutex_unlock(&disk->lock); return code;
}
mr_guide_disk_stats mr_guide_disk_inspect(mr_guide_disk *disk) {
  pthread_mutex_lock(&disk->lock); mr_guide_disk_stats stats = disk->stats;
  pthread_mutex_unlock(&disk->lock); return stats;
}
static int write_all(int fd, const void *data, size_t count) {
  const unsigned char *bytes = data;
  while (count) {
    ssize_t wrote = write(fd, bytes, count);
    if (wrote < 0 && errno == EINTR) continue;
    if (wrote <= 0) return SQLITE_IOERR_WRITE;
    bytes += wrote; count -= (size_t)wrote;
  }
  return SQLITE_OK;
}
int mr_guide_disk_write(mr_guide_disk *disk, const char *path, int fd, const void *data, size_t count) {
  pthread_mutex_lock(&disk->lock);
  int code = SQLITE_IOERR_WRITE;
  struct stat opened, named;
  off_t offset = lseek(fd, 0, SEEK_CUR);
  if (owned(disk, path) && !fstat(fd, &opened) && !lstat(path, &named) && opened.st_dev == named.st_dev && opened.st_ino == named.st_ino && offset >= 0 && opened.st_size >= 0 && count <= (uint64_t)INT64_MAX - (uint64_t)offset) {
    uint64_t end = (uint64_t)offset + count;
    uint64_t growth = end > (uint64_t)opened.st_size ? end - (uint64_t)opened.st_size : 0;
    code = capacity(disk, growth, 0, NULL, NULL);
    if (code == SQLITE_OK) code = write_all(fd, data, count);
  }
  pthread_mutex_unlock(&disk->lock); return code;
}
int mr_guide_disk_open(mr_guide_disk *disk, const char *path) {
  pthread_mutex_lock(&disk->lock);
  int fd = -1;
  if (owned(disk, path) && capacity(disk, 0, 0, NULL, NULL) == SQLITE_OK) fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0600);
  pthread_mutex_unlock(&disk->lock);
  return fd;
}
static char *temporary(mr_guide_disk *disk) {
  unsigned char random[16]; sqlite3_randomness(sizeof(random), random);
  char hex[33];
  for (unsigned i = 0; i < sizeof(random); i++) snprintf(hex + i * 2, 3, "%02x", random[i]);
  return sqlite3_mprintf("%s/.guide-%s.tmp", disk->root, hex);
}
int mr_guide_disk_atomic(mr_guide_disk *disk, const char *path, const void *data, size_t count) {
  pthread_mutex_lock(&disk->lock);
  int code = SQLITE_CANTOPEN;
  char *tmp = NULL;
  int fd = -1;
  if (!owned(disk, path)) goto end;
  code = capacity(disk, count, 0, NULL, NULL);
  if (code != SQLITE_OK) goto end;
  tmp = temporary(disk);
  if (!tmp) { code = SQLITE_NOMEM; goto end; }
  fd = open(tmp, O_CREAT | O_EXCL | O_WRONLY, 0600);
  if (fd < 0) { code = SQLITE_IOERR_WRITE; goto end; }
  code = write_all(fd, data, count);
  if (code == SQLITE_OK && fsync(fd)) code = SQLITE_IOERR_FSYNC;
  if (close(fd) && code == SQLITE_OK) code = SQLITE_IOERR_CLOSE;
  fd = -1;
  if (code == SQLITE_OK && rename(tmp, path)) code = SQLITE_IOERR_WRITE;
end:
  if (fd >= 0) close(fd);
  if (tmp) { unlink(tmp); sqlite3_free(tmp); }
  pthread_mutex_unlock(&disk->lock); return code;
}

int mr_guide_disk_replace(mr_guide_disk *disk, const char *source, const char *target) {
  pthread_mutex_lock(&disk->lock);
  int code = SQLITE_CANTOPEN;
  if (owned(disk, source) && owned(disk, target)) {
    code = capacity(disk, 0, 0, NULL, NULL);
    if (code == SQLITE_OK && rename(source, target)) code = SQLITE_IOERR_WRITE;
  }
  pthread_mutex_unlock(&disk->lock); return code;
}

static const sqlite3_io_methods io;
static int close_file(sqlite3_file *base) {
  GuideFile *file = (GuideFile *)base;
  mr_guide_vfs *vfs = file->vfs;
  pthread_mutex_lock(&vfs->disk->lock);
  int code = file->original->pMethods->xClose(file->original);
  if (file->remove_on_close) {
    int removed = vfs->original->xDelete(vfs->original, file->path, 0);
    if (removed != SQLITE_OK && code == SQLITE_OK) code = removed;
    vfs->disk->stats.temp_files--;
  }
  vfs->open--; vfs->disk->stats.open_files--;
  pthread_mutex_unlock(&vfs->disk->lock);
  free(file->original); free(file->path); sqlite3_free_filename(file->generated);
  base->pMethods = NULL;
  return code;
}
static int read_file(sqlite3_file *base, void *data, int count, sqlite3_int64 offset) {
  GuideFile *f = (GuideFile *)base; return f->original->pMethods->xRead(f->original, data, count, offset);
}
static int write_file(sqlite3_file *base, const void *data, int count, sqlite3_int64 offset) {
  GuideFile *f = (GuideFile *)base; mr_guide_vfs *v = f->vfs;
  if (count < 0 || offset < 0 || offset > INT64_MAX - count) return SQLITE_FULL;
  pthread_mutex_lock(&v->disk->lock);
  sqlite3_int64 size = 0;
  int code = f->original->pMethods->xFileSize(f->original, &size);
  sqlite3_int64 end = offset + count;
  if (code == SQLITE_OK && size < 0) code = SQLITE_IOERR_FSTAT;
  if (code == SQLITE_OK && (f->flags & (SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_TEMP_DB)) && (uint64_t)end > v->disk->database) code = SQLITE_FULL;
  if (code == SQLITE_OK) code = capacity(v->disk, end > size ? (uint64_t)(end - size) : 0, f->flags, v->check, v->context);
  if (code == SQLITE_OK) code = f->original->pMethods->xWrite(f->original, data, count, offset);
  pthread_mutex_unlock(&v->disk->lock); return code;
}
static int truncate_file(sqlite3_file *base, sqlite3_int64 size) {
  GuideFile *f = (GuideFile *)base; mr_guide_vfs *v = f->vfs;
  if (size < 0) return SQLITE_FULL;
  pthread_mutex_lock(&v->disk->lock);
  sqlite3_int64 before = 0;
  int code = f->original->pMethods->xFileSize(f->original, &before);
  if (code == SQLITE_OK && size > before) {
    if ((f->flags & (SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_TEMP_DB)) && (uint64_t)size > v->disk->database) code = SQLITE_FULL;
    else code = capacity(v->disk, (uint64_t)(size - before), f->flags, v->check, v->context);
  }
  if (code == SQLITE_OK) code = f->original->pMethods->xTruncate(f->original, size);
  pthread_mutex_unlock(&v->disk->lock); return code;
}
static int sync_file(sqlite3_file *b, int flags) { GuideFile *f = (GuideFile *)b; return f->original->pMethods->xSync(f->original, flags); }
static int size_file(sqlite3_file *b, sqlite3_int64 *size) { GuideFile *f = (GuideFile *)b; return f->original->pMethods->xFileSize(f->original, size); }
static int lock_file(sqlite3_file *b, int kind) { GuideFile *f = (GuideFile *)b; return f->original->pMethods->xLock(f->original, kind); }
static int unlock_file(sqlite3_file *b, int kind) { GuideFile *f = (GuideFile *)b; return f->original->pMethods->xUnlock(f->original, kind); }
static int reserved(sqlite3_file *b, int *result) { GuideFile *f = (GuideFile *)b; return f->original->pMethods->xCheckReservedLock(f->original, result); }
static int sector(sqlite3_file *b) { GuideFile *f = (GuideFile *)b; return f->original->pMethods->xSectorSize(f->original); }
static int characteristics(sqlite3_file *b) {
  GuideFile *f = (GuideFile *)b;
  int capabilities = f->original->pMethods->xDeviceCharacteristics(f->original);
  return capabilities & ~(SQLITE_IOCAP_ATOMIC | SQLITE_IOCAP_ATOMIC512 | SQLITE_IOCAP_ATOMIC1K | SQLITE_IOCAP_ATOMIC2K | SQLITE_IOCAP_ATOMIC4K | SQLITE_IOCAP_ATOMIC8K | SQLITE_IOCAP_ATOMIC16K | SQLITE_IOCAP_ATOMIC32K | SQLITE_IOCAP_ATOMIC64K | SQLITE_IOCAP_BATCH_ATOMIC);
}
static int control(sqlite3_file *base, int op, void *arg) {
  GuideFile *f = (GuideFile *)base;
  /* Hints may allocate without xWrite/xTruncate. All actual growth must pass this gate. */
  if (op == SQLITE_FCNTL_SIZE_HINT || op == SQLITE_FCNTL_CHUNK_SIZE) return SQLITE_OK;
  if (op == SQLITE_FCNTL_MMAP_SIZE) { *(sqlite3_int64 *)arg = 0; return SQLITE_OK; }
  if (op == SQLITE_FCNTL_VFSNAME) {
    *(char **)arg = sqlite3_mprintf("%s", f->vfs->name);
    return *(char **)arg ? SQLITE_OK : SQLITE_NOMEM;
  }
  if (op == SQLITE_FCNTL_VFS_POINTER) { *(sqlite3_vfs **)arg = &f->vfs->base; return SQLITE_OK; }
  if (op == SQLITE_FCNTL_TEMPFILENAME) {
    *(char **)arg = temporary(f->vfs->disk);
    return *(char **)arg ? SQLITE_OK : SQLITE_NOMEM;
  }
  return f->original->pMethods->xFileControl(f->original, op, arg);
}
/* Guides use rollback journals. Refuse WAL shared-memory and mmap bypasses rather than
   allowing unmetered writes through mapped pages. SQLite falls back to xRead for xFetch. */
static int shm_map(sqlite3_file *b, int page, int size, int extend, void volatile **out) { (void)b; (void)page; (void)size; (void)extend; *out = NULL; return SQLITE_IOERR_SHMMAP; }
static int shm_lock(sqlite3_file *b, int offset, int count, int flags) { (void)b; (void)offset; (void)count; (void)flags; return SQLITE_IOERR_SHMLOCK; }
static void shm_barrier(sqlite3_file *b) { (void)b; }
static int shm_unmap(sqlite3_file *b, int remove) { (void)b; (void)remove; return SQLITE_OK; }
static int fetch_file(sqlite3_file *b, sqlite3_int64 off, int count, void **out) { (void)b; (void)off; (void)count; *out = NULL; return SQLITE_OK; }
static int unfetch_file(sqlite3_file *b, sqlite3_int64 off, void *p) { (void)b; (void)off; (void)p; return SQLITE_OK; }
static const sqlite3_io_methods io = {3, close_file, read_file, write_file, truncate_file, sync_file, size_file, lock_file, unlock_file, reserved, control, sector, characteristics, shm_map, shm_lock, shm_barrier, shm_unmap, fetch_file, unfetch_file};

static int open_file(sqlite3_vfs *base, sqlite3_filename name, sqlite3_file *result, int flags, int *out_flags) {
  mr_guide_vfs *vfs = base->pAppData;
  GuideFile *file = (GuideFile *)result;
  memset(file, 0, sizeof(*file)); file->vfs = vfs; file->flags = flags;
  char *tmp = NULL;
  pthread_mutex_lock(&vfs->disk->lock);
  int code = SQLITE_CANTOPEN;
  if (!name || !*name) {
    tmp = temporary(vfs->disk);
    if (!tmp) { code = SQLITE_NOMEM; goto end; }
    file->generated = sqlite3_create_filename(tmp, "", "", 0, NULL);
    if (!file->generated) { code = SQLITE_NOMEM; goto end; }
    name = file->generated; file->remove_on_close = 1;
  }
  if (!owned(vfs->disk, name)) goto end;
  file->path = strdup(name);
  file->original = calloc(1, (size_t)vfs->original->szOsFile);
  if (!file->path || !file->original) { code = SQLITE_NOMEM; goto end; }
  file->remove_on_close |= !!(flags & SQLITE_OPEN_DELETEONCLOSE);
  /* A read open consumes no growth reserve, but still observes its job cancellation/deadline. */
  code = capacity(vfs->disk, 0, flags, vfs->check, vfs->context);
  if (code != SQLITE_OK) goto end;
  code = vfs->original->xOpen(vfs->original, name, file->original, flags & ~SQLITE_OPEN_DELETEONCLOSE, out_flags);
  if (code == SQLITE_OK) {
    result->pMethods = &io;
    vfs->open++; vfs->disk->stats.open_files++;
    if (file->remove_on_close) vfs->disk->stats.temp_files++;
  } else if (file->original->pMethods) file->original->pMethods->xClose(file->original);
end:
  if (code != SQLITE_OK) {
    if (file->remove_on_close && file->path) vfs->original->xDelete(vfs->original, file->path, 0);
    free(file->path); free(file->original); sqlite3_free_filename(file->generated);
    memset(file, 0, sizeof(*file));
  }
  sqlite3_free(tmp); pthread_mutex_unlock(&vfs->disk->lock); return code;
}
static int delete_file(sqlite3_vfs *b, const char *name, int sync) {
  mr_guide_vfs *v = b->pAppData;
  if (!owned(v->disk, name)) return SQLITE_IOERR_DELETE;
  pthread_mutex_lock(&v->disk->lock);
  int code = v->original->xDelete(v->original, name, sync);
  pthread_mutex_unlock(&v->disk->lock); return code;
}
static int access_file(sqlite3_vfs *b, const char *name, int flags, int *out) {
  mr_guide_vfs *v = b->pAppData;
  if (!owned(v->disk, name)) { *out = 0; return SQLITE_OK; }
  return v->original->xAccess(v->original, name, flags, out);
}
static int full_path(sqlite3_vfs *b, const char *name, int size, char *out) { mr_guide_vfs *v = b->pAppData; return v->original->xFullPathname(v->original, name, size, out); }
static void *dl_open(sqlite3_vfs *b, const char *name) { mr_guide_vfs *v = b->pAppData; return v->original->xDlOpen(v->original, name); }
static void dl_error(sqlite3_vfs *b, int n, char *out) { mr_guide_vfs *v = b->pAppData; v->original->xDlError(v->original, n, out); }
static void (*dl_sym(sqlite3_vfs *b, void *handle, const char *name))(void) { mr_guide_vfs *v = b->pAppData; return v->original->xDlSym(v->original, handle, name); }
static void dl_close(sqlite3_vfs *b, void *handle) { mr_guide_vfs *v = b->pAppData; v->original->xDlClose(v->original, handle); }
static int random_bytes(sqlite3_vfs *b, int n, char *out) { mr_guide_vfs *v = b->pAppData; return v->original->xRandomness(v->original, n, out); }
static int sleep_for(sqlite3_vfs *b, int n) { mr_guide_vfs *v = b->pAppData; return v->original->xSleep(v->original, n); }
static int time_now(sqlite3_vfs *b, double *out) { mr_guide_vfs *v = b->pAppData; return v->original->xCurrentTime(v->original, out); }
static int last_error(sqlite3_vfs *b, int n, char *out) { mr_guide_vfs *v = b->pAppData; return v->original->xGetLastError ? v->original->xGetLastError(v->original, n, out) : 0; }
static int time_int(sqlite3_vfs *b, sqlite3_int64 *out) { mr_guide_vfs *v = b->pAppData; return v->original->xCurrentTimeInt64(v->original, out); }
static int set_call(sqlite3_vfs *b, const char *name, sqlite3_syscall_ptr call) { (void)b; (void)name; (void)call; return SQLITE_NOTFOUND; }
static sqlite3_syscall_ptr get_call(sqlite3_vfs *b, const char *name) { mr_guide_vfs *v = b->pAppData; return v->original->xGetSystemCall ? v->original->xGetSystemCall(v->original, name) : NULL; }
static const char *next_call(sqlite3_vfs *b, const char *name) { mr_guide_vfs *v = b->pAppData; return v->original->xNextSystemCall ? v->original->xNextSystemCall(v->original, name) : NULL; }
mr_guide_vfs *mr_guide_vfs_create(mr_guide_disk *disk, mr_guide_io_check check, void *context) {
  sqlite3_vfs *original = sqlite3_vfs_find(NULL);
  if (!disk || !original || original->iVersion < 2) return NULL;
  mr_guide_vfs *v = calloc(1, sizeof(*v));
  if (!v) return NULL;
  unsigned char random[16]; sqlite3_randomness(sizeof(random), random);
  strcpy(v->name, "mr-guide-");
  for (unsigned i = 0; i < sizeof(random); i++) snprintf(v->name + 9 + i * 2, 3, "%02x", random[i]);
  v->original = original; v->disk = disk; v->check = check; v->context = context;
  v->base = (sqlite3_vfs){3, sizeof(GuideFile), original->mxPathname, NULL, v->name, v, open_file, delete_file, access_file, full_path, dl_open, dl_error, dl_sym, dl_close, random_bytes, sleep_for, time_now, last_error, time_int, set_call, get_call, next_call};
  if (sqlite3_vfs_register(&v->base, 0) != SQLITE_OK) { free(v); return NULL; }
  pthread_mutex_lock(&disk->lock); disk->references++; pthread_mutex_unlock(&disk->lock);
  return v;
}
const char *mr_guide_vfs_name(mr_guide_vfs *vfs) { return vfs ? vfs->name : NULL; }
int mr_guide_vfs_destroy(mr_guide_vfs *vfs) {
  if (!vfs) return SQLITE_OK;
  pthread_mutex_lock(&vfs->disk->lock);
  unsigned open = vfs->open;
  pthread_mutex_unlock(&vfs->disk->lock);
  if (open) return SQLITE_BUSY;
  int code = sqlite3_vfs_unregister(&vfs->base);
  if (code == SQLITE_OK) { mr_guide_disk *disk = vfs->disk; free(vfs); mr_guide_disk_destroy(disk); }
  return code;
}
