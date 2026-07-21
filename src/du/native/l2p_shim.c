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
//
// Build: clang -O2 -dynamiclib -o libl2pshim.dylib l2p_shim.c

#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <stdint.h>
#include <sys/attr.h>

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
//   36 linkcount u32 | 40 alloc off_t | 48 datalength off_t | 56 privatesize off_t
// Returns the getattrlistbulk result (entry count, 0 at end, -1 on error).
int cs_getattrbulk(int dirfd, void *buf, uint64_t bufsize) {
    struct attrlist al;
    memset(&al, 0, sizeof al);
    al.bitmapcount = ATTR_BIT_MAP_COUNT;
    al.commonattr  = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE;
    al.fileattr    = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE | ATTR_FILE_DATALENGTH;
    al.forkattr    = ATTR_CMNEXT_PRIVATESIZE;
    uint64_t opt = FSOPT_PACK_INVAL_ATTRS | FSOPT_ATTR_CMN_EXTENDED | FSOPT_NOFOLLOW;
    return getattrlistbulk(dirfd, &al, buf, (size_t)bufsize, opt);
}
