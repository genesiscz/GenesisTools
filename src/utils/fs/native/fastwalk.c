// fastwalk.c: walk directory trees in one native call on macOS, with getattrlistbulk.
//
// One getattrlistbulk call returns the name, type, mtime and size of many entries of a directory, so a walk
// costs one open, a few bulk reads and one close per directory, and no stat per file. The JS side calls
// fw_walk once for all roots (bun:ffi) and parses the text it returns; fast-walk.ts holds the contract.
//
// Output: one line per entry, "<kind>\t<mtime ms>\t<size>\t<path>\n". kind is f (file), d (directory),
// l (symbolic link, not followed) or e (a directory that could not be read; the size field holds errno).
// Root depth is 0; a directory deeper than max_depth is not entered (max_depth < 0: no limit).

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/vnode.h>
#include <unistd.h>

typedef struct {
    char *p;
    size_t len, cap;
} Buf;

static int buf_add(Buf *b, const char *s, size_t n) {
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 1 << 16;
        while (b->len + n + 1 > cap) cap *= 2;
        char *grown = realloc(b->p, cap);
        if (!grown) return -1;
        b->p = grown;
        b->cap = cap;
    }
    memcpy(b->p + b->len, s, n);
    b->len += n;
    b->p[b->len] = '\0';
    return 0;
}

static int emit(Buf *out, char kind, double mtime_ms, long long size, const char *path) {
    char head[64];
    int n = snprintf(head, sizeof head, "%c\t%.3f\t%lld\t", kind, mtime_ms, size);
    if (buf_add(out, head, (size_t)n) < 0) return -1;
    if (buf_add(out, path, strlen(path)) < 0) return -1;
    return buf_add(out, "\n", 1);
}

typedef struct {
    char *path;
    int depth;
} Dir;

typedef struct {
    Dir *items;
    size_t len, cap;
} Stack;

static int push(Stack *s, char *path, int depth) {
    if (s->len == s->cap) {
        size_t cap = s->cap ? s->cap * 2 : 256;
        Dir *grown = realloc(s->items, cap * sizeof(Dir));
        if (!grown) return -1;
        s->items = grown;
        s->cap = cap;
    }
    s->items[s->len].path = path;
    s->items[s->len].depth = depth;
    s->len++;
    return 0;
}

/** Newline-separated patterns: an exact name, or "*suffix". No patterns: every file matches. */
static int matches(const char *name, char **patterns, int count) {
    if (count == 0) return 1;
    size_t nl = strlen(name);
    for (int i = 0; i < count; i++) {
        const char *p = patterns[i];
        if (p[0] == '*') {
            size_t sl = strlen(p + 1);
            if (nl >= sl && memcmp(name + nl - sl, p + 1, sl) == 0) return 1;
        } else if (strcmp(name, p) == 0) {
            return 1;
        }
    }
    return 0;
}

static int split_lines(char *text, char ***out) {
    int count = 0, cap = 8;
    char **items = malloc(cap * sizeof(char *));
    if (!items) return -1;
    for (char *line = strtok(text, "\n"); line; line = strtok(NULL, "\n")) {
        if (count == cap) {
            cap *= 2;
            char **grown = realloc(items, cap * sizeof(char *));
            if (!grown) {
                free(items);
                return -1;
            }
            items = grown;
        }
        items[count++] = line;
    }
    *out = items;
    return count;
}

// Entry layout (FSOPT_PACK_INVAL_ATTRS, fields in sys/attr.h bit order, 4-byte packed):
//   0 u32 length | 4 returned attrs (20) | 24 name attrreference (8) | 32 objtype u32 (4)
//   36 modtime timespec (16) | 52 data length off_t (8)
static void walk_dir(Buf *out, Stack *stack, const char *dir, int depth, int max_depth, char **patterns,
                     int npatterns, int emit_dirs, struct attrlist *al, char *buf, size_t bufsize) {
    int fd = open(dir, O_RDONLY | O_DIRECTORY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        emit(out, 'e', 0, errno, dir);
        return;
    }
    size_t dl = strlen(dir);
    for (;;) {
        int n = getattrlistbulk(fd, al, buf, bufsize, FSOPT_PACK_INVAL_ATTRS | FSOPT_NOFOLLOW);
        if (n < 0) {
            emit(out, 'e', 0, errno, dir);
            break;
        }
        if (n == 0) break;
        char *p = buf;
        for (int i = 0; i < n; i++) {
            char *entry = p;
            uint32_t len;
            memcpy(&len, entry, 4);
            int32_t nameoff;
            memcpy(&nameoff, entry + 24, 4);
            const char *name = entry + 24 + nameoff;
            uint32_t objtype;
            memcpy(&objtype, entry + 32, 4);
            int64_t sec, nsec;
            memcpy(&sec, entry + 36, 8);
            memcpy(&nsec, entry + 44, 8);
            off_t size;
            memcpy(&size, entry + 52, 8);
            p += len;
            if (name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'))) continue;

            int descend = objtype == VDIR && (max_depth < 0 || depth + 1 <= max_depth);
            int wanted = (objtype == VDIR && emit_dirs) || objtype == VLNK ||
                         (objtype == VREG && matches(name, patterns, npatterns));
            if (!descend && !wanted) continue;

            size_t nl = strlen(name);
            char *path = malloc(dl + 1 + nl + 1);
            if (!path) continue;
            memcpy(path, dir, dl);
            path[dl] = '/';
            memcpy(path + dl + 1, name, nl + 1);
            double mtime_ms = (double)sec * 1000.0 + (double)nsec / 1e6;

            if (wanted) {
                char kind = objtype == VDIR ? 'd' : objtype == VLNK ? 'l' : 'f';
                emit(out, kind, mtime_ms, objtype == VREG ? (long long)size : 0, path);
            }
            if (descend && push(stack, path, depth + 1) == 0) continue;
            free(path);
        }
    }
    close(fd);
}

/**
 * Walks every root (newline-separated, absolute, already resolved) and returns the entry lines described at
 * the top of this file, NUL-terminated, with their byte length in *out_len. Free the result with fw_free.
 */
char *fw_walk(const char *roots, int max_depth, const char *patterns_text, int emit_dirs, uint64_t *out_len) {
    Buf out = {0};
    Stack stack = {0};
    char *roots_copy = strdup(roots ? roots : "");
    char *patterns_copy = strdup(patterns_text ? patterns_text : "");
    char **root_list = NULL, **patterns = NULL;
    int nroots = split_lines(roots_copy, &root_list);
    int npatterns = split_lines(patterns_copy, &patterns);

    struct attrlist al;
    memset(&al, 0, sizeof al);
    al.bitmapcount = ATTR_BIT_MAP_COUNT;
    al.commonattr = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE | ATTR_CMN_MODTIME;
    al.fileattr = ATTR_FILE_DATALENGTH;
    size_t bufsize = 256 * 1024;
    char *buf = malloc(bufsize);

    buf_add(&out, "", 0);
    for (int r = 0; buf && r < nroots; r++) {
        push(&stack, strdup(root_list[r]), 0);
        while (stack.len > 0) {
            Dir next = stack.items[--stack.len];
            walk_dir(&out, &stack, next.path, next.depth, max_depth, patterns, npatterns < 0 ? 0 : npatterns,
                     emit_dirs, &al, buf, bufsize);
            free(next.path);
        }
    }

    free(buf);
    free(stack.items);
    free(root_list);
    free(patterns);
    free(roots_copy);
    free(patterns_copy);
    *out_len = out.len;
    return out.p;
}

void fw_free(char *p) {
    free(p);
}
