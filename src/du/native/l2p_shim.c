// Non-variadic wrapper around fcntl(F_LOG2PHYS_EXT) so bun:ffi can call it
// safely on Apple arm64 (where variadic args must go on the stack).
#include <fcntl.h>
struct log2phys; // opaque to caller
int l2p_ext(int fd, void *arg) {
    return fcntl(fd, F_LOG2PHYS_EXT, arg);
}
