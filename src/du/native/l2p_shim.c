// bun:ffi native helpers for the Bun engine.
//
// 1. l2p_ext        — non-variadic wrapper around fcntl(F_LOG2PHYS_EXT) so bun:ffi
//                     can call it safely on Apple arm64 (variadic args must go on
//                     the stack; bun:ffi mis-passes them in a register).
// 2. cs_opendir_fd  — open(path, O_RDONLY|O_DIRECTORY) — a dir fd for getattrlistbulk.
// 3. cs_openat_file — openat(dirfd, name, O_RDONLY|O_NONBLOCK) — cheap by-leaf open.
// 4. cs_getattrbulk — one getattrlistbulk pass on a dir fd, requesting exactly the
//                     attrs the Bun engine parses (see native/clonesize.c for the
//                     packed entry layout). Keeps the attrlist ABI in C so bun only
//                     deals with the raw byte buffer.
// 5. cs_close       — close(fd).
// 6. cs_fp_domain   — the File Provider provider id of a domain root (xattr), or -1.
// 7. cs_is_dataless — lstat st_flags has SF_DATALESS (a cloud placeholder).
// 8. cs_materialize_guard / cs_materialize_restore — the calling thread's
//                     IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES policy, so a
//                     placeholder fails to open instead of downloading.
//
// Build: clang -O2 -dynamiclib -o libl2pshim.dylib l2p_shim.c

#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <stdint.h>
#include <sys/attr.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/xattr.h>

struct log2phys; // opaque to caller
int l2p_ext(int fd, void *arg) {
    return fcntl(fd, F_LOG2PHYS_EXT, arg);
}

int cs_opendir_fd(const char *path) {
    return open(path, O_RDONLY | O_DIRECTORY | O_NONBLOCK);
}

int cs_openat_file(int dirfd, const char *name) {
    return openat(dirfd, name, O_RDONLY | O_NONBLOCK);
}

int cs_close(int fd) {
    return close(fd);
}

// Fills buf with getattrlistbulk output for `dirfd`. Requested attrs (packed,
// FSOPT_PACK_INVAL_ATTRS) per entry, offsets relative to the entry start:
//   0  u32 length | 4 returned_attrs(20) | 24 name attrref(8) | 32 objtype u32
//   36 flags u32 | 40 linkcount u32 | 44 alloc off_t | 52 datalength off_t | 60 privatesize off_t
// Returns the getattrlistbulk result (entry count, 0 at end, -1 on error).
int cs_getattrbulk(int dirfd, void *buf, uint64_t bufsize) {
    struct attrlist al;
    memset(&al, 0, sizeof al);
    al.bitmapcount = ATTR_BIT_MAP_COUNT;
    al.commonattr  = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE | ATTR_CMN_FLAGS;
    al.fileattr    = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE | ATTR_FILE_DATALENGTH;
    al.forkattr    = ATTR_CMNEXT_PRIVATESIZE;
    uint64_t opt = FSOPT_PACK_INVAL_ATTRS | FSOPT_ATTR_CMN_EXTENDED | FSOPT_NOFOLLOW;
    return getattrlistbulk(dirfd, &al, buf, (size_t)bufsize, opt);
}

// Copies the provider id (the domain-id xattr up to its first '/') into buf.
// Returns its length, or -1 when `path` is not a File Provider domain root.
int cs_fp_domain(const char *path, char *buf, int cap) {
    char val[512];
    ssize_t n = getxattr(path, "com.apple.file-provider-domain-id", val, sizeof val - 1, 0, XATTR_NOFOLLOW);
    if (n < 0 || cap < 1) return -1;
    val[n] = '\0';
    char *slash = strchr(val, '/');
    if (slash) *slash = '\0';
    size_t len = strlen(val);
    if (len >= (size_t)cap) len = (size_t)cap - 1;
    memcpy(buf, val, len);
    buf[len] = '\0';
    return (int)len;
}

int cs_is_dataless(const char *path) {
    struct stat st;
    if (lstat(path, &st) != 0) return 0;
    return (st.st_flags & SF_DATALESS) != 0;
}

// Sets the calling thread's policy to OFF and returns the previous one (-1 on failure).
int cs_materialize_guard(void) {
    int prev = getiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_THREAD);
    if (setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_THREAD,
                       IOPOL_MATERIALIZE_DATALESS_FILES_OFF) != 0) return -1;
    return prev;
}

int cs_materialize_restore(int prev) {
    if (prev < 0) return -1;
    return setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_THREAD, prev);
}
