// clonesize.c — APFS clone-aware directory sizing (parallel).
//
// Measures the REAL on-disk footprint of a tree full of APFS clonefiles
// (e.g. bun's clonefile(2) node_modules shared across git worktrees), which
// plain `du` massively overcounts because every clone reports its full size
// in st_blocks even though they share physical blocks.
//
// Method: for every regular file, enumerate its physical device extents via
//   fcntl(fd, F_LOG2PHYS_EXT, &log2phys)
// collect (device_offset, length) ranges across ALL files, then dedup/merge
// overlapping ranges. The merged total is the unique physical byte count.
// Two files are clones iff their extents map to the same device offsets.
//
// Speed: the workload is almost entirely syscall/IO-bound (open+fcntl+close
// per file), so it parallelizes near-linearly across a pthread pool — the
// directory walk is single-threaded (pure readdir, no lstat via d_type) and
// the per-file extent scan is split across N worker threads.
//
// Build: clang -O2 -pthread -o clonesize clonesize.c
//   (cc is aliased to `claude` on this machine — always use clang.)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/attr.h>

// fcntl.h already provides `struct log2phys` and F_LOG2PHYS_EXT (=65).

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
static int   g_nthreads   = 0;      // 0 => auto (ncpu)
static int   g_json       = 0;      // --format json
static int   g_freeable   = 0;      // --freeable: also sum ATTR_CMNEXT_PRIVATESIZE
static size_t g_min_blocks = 0;     // skip files with st_blocks*512 < this (bytes) — 0 = keep all
static int   g_quiet      = 0;      // suppress the per-group table
static double g_clone_pct = 0.30;   // a group is "clone-flagged" if >= this frac of its bytes is cross-group shared

// ---------------------------------------------------------------------------
// Groups: each immediate child (dir or file) of the scan root is one group,
// so scanning the parent of several worktrees yields one group per worktree.
// ---------------------------------------------------------------------------
#define MAX_GROUPS 64               // bitmask width; extra groups fold into bit 63
static char    *g_group_names[MAX_GROUPS];
static int      g_ngroups = 0;
static uint64_t g_group_naive[MAX_GROUPS];   // sum of st_blocks*512 (protected by mutex during scan)
static uint64_t g_group_files[MAX_GROUPS];
static uint64_t g_group_private[MAX_GROUPS]; // ATTR_CMNEXT_PRIVATESIZE sum (only with --freeable)

// Directory subtrees to prune during the walk (e.g. detected git worktrees,
// .worktrees/). Compared against the full path built during traversal.
#define MAX_EXCLUDES 256
static const char *g_excludes[MAX_EXCLUDES];
static int g_nexcludes = 0;
static int is_excluded(const char *path) {
    for (int i = 0; i < g_nexcludes; i++)
        if (strcmp(g_excludes[i], path) == 0) return 1;
    return 0;
}

static int intern_group(const char *name) {
    for (int i = 0; i < g_ngroups; i++)
        if (strcmp(g_group_names[i], name) == 0) return i;
    if (g_ngroups >= MAX_GROUPS) return MAX_GROUPS - 1; // fold overflow into last bit
    g_group_names[g_ngroups] = strdup(name);
    return g_ngroups++;
}

// ---------------------------------------------------------------------------
// File work list (produced by the walk, consumed by the worker pool)
// ---------------------------------------------------------------------------
typedef struct { char *path; int group; } FileEnt;
static FileEnt *g_files = NULL;
static size_t   g_nfiles = 0, g_cap_files = 0;

static void push_file(const char *path, int group) {
    if (g_nfiles == g_cap_files) {
        g_cap_files = g_cap_files ? g_cap_files * 2 : 65536;
        g_files = realloc(g_files, g_cap_files * sizeof(FileEnt));
        if (!g_files) { perror("realloc files"); exit(1); }
    }
    g_files[g_nfiles].path  = strdup(path);
    g_files[g_nfiles].group = group;
    g_nfiles++;
}

// ---------------------------------------------------------------------------
// Extent record (per thread, then merged globally)
// ---------------------------------------------------------------------------
typedef struct { uint64_t dev; uint64_t len; int group; } Ext;

typedef struct {
    Ext     *exts;
    size_t   n, cap;
    uint64_t naive;                  // sum st_blocks*512 for this thread's files
    uint64_t group_naive[MAX_GROUPS];
    uint64_t group_files[MAX_GROUPS];
    uint64_t group_private[MAX_GROUPS];
    size_t   scanned;                // files actually opened+scanned
} ThreadOut;

static void ext_push(ThreadOut *t, uint64_t dev, uint64_t len, int group) {
    if (t->n == t->cap) {
        t->cap = t->cap ? t->cap * 2 : 4096;
        t->exts = realloc(t->exts, t->cap * sizeof(Ext));
        if (!t->exts) { perror("realloc exts"); exit(1); }
    }
    t->exts[t->n].dev = dev;
    t->exts[t->n].len = len;
    t->exts[t->n].group = group;
    t->n++;
}

// ---------------------------------------------------------------------------
// getattrlist buffer for ATTR_CMNEXT_PRIVATESIZE (freeable bytes, per file)
// ---------------------------------------------------------------------------
struct PrivBuf {
    uint32_t length;
    off_t    privatesize;    // ATTR_CMNEXT_PRIVATESIZE
} __attribute__((aligned(4), packed));

static uint64_t file_private_size(const char *path) {
    struct attrlist al;
    memset(&al, 0, sizeof(al));
    al.bitmapcount = ATTR_BIT_MAP_COUNT;
    al.forkattr    = ATTR_CMNEXT_PRIVATESIZE;   // extended common attrs live in forkattr
    struct PrivBuf pb;
    memset(&pb, 0, sizeof(pb));
    if (getattrlist(path, &al, &pb, sizeof(pb), FSOPT_ATTR_CMN_EXTENDED) != 0)
        return 0;
    return (uint64_t)pb.privatesize;
}

// ---------------------------------------------------------------------------
// Per-file extent scan
// ---------------------------------------------------------------------------
static void scan_file(ThreadOut *t, const char *path, int group) {
    int fd = open(path, O_RDONLY | O_NONBLOCK);
    if (fd < 0) return;
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) { close(fd); return; }

    uint64_t bytes = (uint64_t)st.st_blocks * 512ULL;
    if (bytes == 0 || bytes < g_min_blocks) { close(fd); return; } // inlined/tiny: no separate extents

    t->naive += bytes;
    t->group_naive[group] += bytes;
    t->group_files[group] += 1;
    t->scanned++;
    if (g_freeable) t->group_private[group] += file_private_size(path);

    off_t size = st.st_size, off = 0;
    while (off < size) {
        struct log2phys l2p;
        memset(&l2p, 0, sizeof(l2p));
        l2p.l2p_contigbytes = size - off; // IN: bytes to query
        l2p.l2p_devoffset   = off;        // IN: file offset
        if (fcntl(fd, F_LOG2PHYS_EXT, &l2p) < 0) break;
        off_t contig = l2p.l2p_contigbytes; // OUT: contiguous bytes at this offset
        if (contig <= 0) break;
        // sparse hole => devoffset == (off_t)-1, skip it
        if ((uint64_t)l2p.l2p_devoffset != (uint64_t)-1)
            ext_push(t, (uint64_t)l2p.l2p_devoffset, (uint64_t)contig, group);
        off += contig;
    }
    close(fd);
}

// ---------------------------------------------------------------------------
// Worker pool: static slice of the file array per thread
// ---------------------------------------------------------------------------
typedef struct { size_t start, end; ThreadOut *out; } Job;

static void *worker(void *arg) {
    Job *j = arg;
    for (size_t i = j->start; i < j->end; i++)
        scan_file(j->out, g_files[i].path, g_files[i].group);
    return NULL;
}

// ---------------------------------------------------------------------------
// Directory walk (single-threaded, pure readdir via d_type — no lstat)
// ---------------------------------------------------------------------------
static void walk(const char *dir, int group) {
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *e;
    char p[4096];
    while ((e = readdir(d))) {
        const char *n = e->d_name;
        if (n[0] == '.' && (n[1] == '\0' || (n[1] == '.' && n[2] == '\0'))) continue;
        snprintf(p, sizeof(p), "%s/%s", dir, n);
        if (g_nexcludes && is_excluded(p)) continue;
        int g = (group < 0) ? intern_group(n) : group; // first component under root = group

        unsigned char type = e->d_type;
        if (type == DT_DIR) {
            walk(p, g);
        } else if (type == DT_REG) {
            push_file(p, g);
        } else if (type == DT_UNKNOWN) {
            // Filesystem didn't fill d_type — fall back to lstat.
            struct stat st;
            if (lstat(p, &st) != 0) continue;
            if (S_ISDIR(st.st_mode)) walk(p, g);
            else if (S_ISREG(st.st_mode)) push_file(p, g);
        }
        // DT_LNK and others: skip (we don't follow symlinks; du doesn't either by default)
    }
    closedir(d);
}

// ---------------------------------------------------------------------------
// Union-find over groups (to cluster worktrees that are clones of each other)
// ---------------------------------------------------------------------------
static int g_uf[MAX_GROUPS];
static int uf_find(int x) { while (g_uf[x] != x) { g_uf[x] = g_uf[g_uf[x]]; x = g_uf[x]; } return x; }
static void uf_union(int a, int b) { a = uf_find(a); b = uf_find(b); if (a != b) g_uf[a] = b; }

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
static int cmp_ext(const void *a, const void *b) {
    const Ext *x = a, *y = b;
    if (x->dev < y->dev) return -1;
    if (x->dev > y->dev) return 1;
    return 0;
}

static void usage(const char *me) {
    fprintf(stderr,
        "usage: %s [options] <dir>\n"
        "  --format json     machine-readable JSON output\n"
        "  --threads N       worker threads (default: ncpu)\n"
        "  --freeable        also sum per-file ATTR_CMNEXT_PRIVATESIZE (freeable-if-deleted)\n"
        "  --min-bytes N     skip files whose allocated size < N bytes\n"
        "  --exclude PATH    prune this directory subtree (repeatable)\n"
        "  --quiet           omit the per-group table\n", me);
}

int main(int argc, char **argv) {
    const char *target = NULL;
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        if      (!strcmp(a, "--format") && i + 1 < argc) g_json = !strcmp(argv[++i], "json");
        else if (!strcmp(a, "--json"))                   g_json = 1;
        else if (!strcmp(a, "--threads") && i + 1 < argc) g_nthreads = atoi(argv[++i]);
        else if (!strcmp(a, "--freeable"))               g_freeable = 1;
        else if (!strcmp(a, "--min-bytes") && i + 1 < argc) g_min_blocks = strtoull(argv[++i], NULL, 10);
        else if (!strcmp(a, "--exclude") && i + 1 < argc) { if (g_nexcludes < MAX_EXCLUDES) g_excludes[g_nexcludes++] = argv[++i]; else i++; }
        else if (!strcmp(a, "--quiet"))                  g_quiet = 1;
        else if (!strcmp(a, "-h") || !strcmp(a, "--help")) { usage(argv[0]); return 0; }
        else if (a[0] == '-') { fprintf(stderr, "unknown option: %s\n", a); usage(argv[0]); return 2; }
        else target = a;
    }
    if (!target) { usage(argv[0]); return 2; }

    if (g_nthreads <= 0) {
        long n = sysconf(_SC_NPROCESSORS_ONLN);
        g_nthreads = (n > 0) ? (int)n : 4;
    }

    // 1) Walk (fast, single-threaded).
    walk(target, -1);

    // 2) Parallel extent scan.
    int nthreads = g_nthreads;
    if ((size_t)nthreads > g_nfiles && g_nfiles > 0) nthreads = (int)g_nfiles;
    if (nthreads < 1) nthreads = 1;

    ThreadOut *outs = calloc(nthreads, sizeof(ThreadOut));
    Job       *jobs = calloc(nthreads, sizeof(Job));
    pthread_t *th   = calloc(nthreads, sizeof(pthread_t));

    size_t per = (g_nfiles + nthreads - 1) / nthreads;
    for (int i = 0; i < nthreads; i++) {
        jobs[i].start = (size_t)i * per;
        jobs[i].end   = jobs[i].start + per;
        if (jobs[i].start > g_nfiles) jobs[i].start = g_nfiles;
        if (jobs[i].end   > g_nfiles) jobs[i].end   = g_nfiles;
        jobs[i].out = &outs[i];
        pthread_create(&th[i], NULL, worker, &jobs[i]);
    }
    for (int i = 0; i < nthreads; i++) pthread_join(th[i], NULL);

    // 3) Merge thread outputs.
    size_t total_exts = 0, scanned = 0;
    uint64_t naive = 0;
    for (int i = 0; i < nthreads; i++) {
        total_exts += outs[i].n;
        scanned    += outs[i].scanned;
        naive      += outs[i].naive;
        for (int g = 0; g < g_ngroups; g++) {
            g_group_naive[g]   += outs[i].group_naive[g];
            g_group_files[g]   += outs[i].group_files[g];
            g_group_private[g] += outs[i].group_private[g];
        }
    }

    Ext *all = malloc(total_exts * sizeof(Ext));
    if (!all && total_exts) { perror("malloc merge"); return 1; }
    size_t k = 0;
    for (int i = 0; i < nthreads; i++) {
        memcpy(all + k, outs[i].exts, outs[i].n * sizeof(Ext));
        k += outs[i].n;
        free(outs[i].exts);
    }

    // 4) Sort by device offset, merge overlapping clusters, track group masks.
    qsort(all, total_exts, sizeof(Ext), cmp_ext);
    for (int i = 0; i < MAX_GROUPS; i++) g_uf[i] = i;

    uint64_t unique = 0, cross_shared = 0;
    uint64_t group_shared[MAX_GROUPS]; memset(group_shared, 0, sizeof(group_shared));

    size_t i = 0;
    while (i < total_exts) {
        uint64_t cs = all[i].dev, ce = all[i].dev + all[i].len;
        uint64_t mask = (uint64_t)1 << all[i].group;
        size_t j = i + 1;
        while (j < total_exts && all[j].dev <= ce) {
            uint64_t en = all[j].dev + all[j].len;
            if (en > ce) ce = en;
            mask |= (uint64_t)1 << all[j].group;
            j++;
        }
        uint64_t clen = ce - cs;
        unique += clen;

        // popcount of mask
        int pc = __builtin_popcountll(mask);
        if (pc > 1) {
            cross_shared += clen;
            int first = -1;
            for (int g = 0; g < g_ngroups && g < MAX_GROUPS; g++) {
                if (mask & ((uint64_t)1 << g)) {
                    group_shared[g] += clen;
                    if (first < 0) first = g; else uf_union(first, g);
                }
            }
        }
        i = j;
    }

    uint64_t shared = (naive > unique) ? naive - unique : 0;
    double pct = naive ? 100.0 * (double)shared / (double)naive : 0.0;

    // ------------------------------------------------------------------ output
    if (g_json) {
        printf("{\n");
        printf("  \"path\": \"%s\",\n", target);
        printf("  \"files_scanned\": %zu,\n", scanned);
        printf("  \"files_listed\": %zu,\n", g_nfiles);
        printf("  \"extents\": %zu,\n", total_exts);
        printf("  \"threads\": %d,\n", nthreads);
        printf("  \"naive_bytes\": %llu,\n", (unsigned long long)naive);
        printf("  \"unique_bytes\": %llu,\n", (unsigned long long)unique);
        printf("  \"shared_bytes\": %llu,\n", (unsigned long long)shared);
        printf("  \"shared_pct\": %.2f,\n", pct);
        printf("  \"cross_group_shared_bytes\": %llu,\n", (unsigned long long)cross_shared);
        if (g_freeable) {
            uint64_t tot_priv = 0;
            for (int g = 0; g < g_ngroups; g++) tot_priv += g_group_private[g];
            // Sum of per-file ATTR_CMNEXT_PRIVATESIZE: bytes each file owns exclusively
            // volume-wide (shared with nothing, not even siblings). Conservative lower
            // bound on space freed by deleting files individually — NOT whole-tree freeable.
            printf("  \"private_sum_bytes\": %llu,\n", (unsigned long long)tot_priv);
        }
        printf("  \"groups\": [\n");
        for (int g = 0; g < g_ngroups; g++) {
            uint64_t gn = g_group_naive[g];
            if (gn == 0) continue;
            double gsh = gn ? 100.0 * (double)group_shared[g] / (double)gn : 0.0;
            int flagged = (group_shared[g] >= (uint64_t)(g_clone_pct * (double)gn)) && group_shared[g] > 0;
            printf("    {\"name\": \"%s\", \"naive_bytes\": %llu, \"files\": %llu, "
                   "\"cross_group_shared_bytes\": %llu, \"shared_pct\": %.2f, "
                   "\"clone_cluster\": %d, \"clone_flagged\": %s%s",
                   g_group_names[g], (unsigned long long)gn,
                   (unsigned long long)g_group_files[g],
                   (unsigned long long)group_shared[g], gsh,
                   uf_find(g), flagged ? "true" : "false",
                   g_freeable ? "" : "");
            if (g_freeable)
                printf(", \"private_bytes\": %llu", (unsigned long long)g_group_private[g]);
            // trailing comma handling
            int more = 0;
            for (int h = g + 1; h < g_ngroups; h++) if (g_group_naive[h]) { more = 1; break; }
            printf("}%s\n", more ? "," : "");
        }
        printf("  ]\n");
        printf("}\n");
    } else {
        const double MB = 1024.0 * 1024.0, GB = MB * 1024.0;
        #define HUM(b) ((b) >= (uint64_t)(GB) ? (b)/GB : (b)/MB), ((b) >= (uint64_t)(GB) ? "GB" : "MB")
        printf("Path:            %s\n", target);
        printf("Files scanned:   %zu (of %zu listed)  •  %d threads\n", scanned, g_nfiles, nthreads);
        printf("Naive (du-like): %8.1f %s   %llu bytes\n", HUM(naive), (unsigned long long)naive);
        printf("Unique physical: %8.1f %s   %llu bytes\n", HUM(unique), (unsigned long long)unique);
        printf("Shared (CoW):    %8.1f %s   (%.1f%% of naive collapses to shared blocks)\n",
               HUM(shared), pct);
        printf("Cross-worktree:  %8.1f %s   (shared across marked dirs)\n", HUM(cross_shared));
        if (g_freeable) {
            uint64_t tot_priv = 0;
            for (int g = 0; g < g_ngroups; g++) tot_priv += g_group_private[g];
            printf("Private (excl):  %8.1f %s   (Sum per-file bytes shared with nothing volume-wide)\n", HUM(tot_priv));
        }

        if (!g_quiet && g_ngroups > 0) {
            printf("\nMarked directories (immediate children — worktrees/top-level dirs):\n");
            printf("  %-32s %10s %8s %10s %7s  %s\n", "dir", "naive", "files", "xshared", "share%", "clone-cluster");
            for (int g = 0; g < g_ngroups; g++) {
                uint64_t gn = g_group_naive[g];
                if (gn == 0) continue;
                double gsh = gn ? 100.0 * (double)group_shared[g] / (double)gn : 0.0;
                int flagged = (group_shared[g] >= (uint64_t)(g_clone_pct * (double)gn)) && group_shared[g] > 0;
                char nb[32], xb[32];
                snprintf(nb, sizeof nb, "%.1f%s", HUM(gn));
                snprintf(xb, sizeof xb, "%.1f%s", HUM(group_shared[g]));
                // is this group in a multi-member cluster?
                int members = 0, root = uf_find(g);
                for (int h = 0; h < g_ngroups; h++) if (g_group_naive[h] && uf_find(h) == root) members++;
                char cl[48];
                if (members > 1) snprintf(cl, sizeof cl, "#%d (%d dirs)%s", root, members, flagged ? " ★clone" : "");
                else snprintf(cl, sizeof cl, "-");
                char nm[33];
                snprintf(nm, sizeof nm, "%.32s", g_group_names[g]);
                printf("  %-32s %10s %8llu %10s %6.1f%%  %s\n",
                       nm, nb, (unsigned long long)g_group_files[g], xb, gsh, cl);
            }
            printf("\n★clone = >=%.0f%% of this dir's bytes are shared with another marked dir (it's largely a clone).\n",
                   g_clone_pct * 100.0);
        }
    }

    free(all);
    free(outs); free(jobs); free(th);
    return 0;
}
