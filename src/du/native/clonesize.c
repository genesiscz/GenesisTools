// clonesize.c — APFS clone-aware directory sizing (parallel, getattrlistbulk).
//
// Measures the REAL on-disk footprint of a tree full of APFS clonefiles
// (e.g. bun's clonefile(2) node_modules shared across git worktrees), which
// plain `du` massively overcounts because every clone reports its full size
// in st_blocks even though they share physical blocks.
//
// Method (two facts do the heavy lifting):
//   1. A single parallel getattrlistbulk pass yields, per file and WITHOUT
//      opening it: allocated size (== st_blocks*512), logical size, and
//      ATTR_CMNEXT_PRIVATESIZE (bytes the file shares with NOTHING volume-wide).
//   2. If privatesize == allocsize the file is FULLY PRIVATE: its blocks are
//      exclusive, so its extents can never merge with any other file's — we
//      count `alloc` as unique WITHOUT opening it. Only files that share some
//      blocks (private < alloc) are opened and extent-scanned via
//      fcntl(fd, F_LOG2PHYS_EXT). On a typical tree ~60% of files are fully
//      private, so we skip ~60% of the open()+fcntl()+close() syscalls that
//      dominated the old "open every file" design.
//
// The extent scan collects (device_offset, length) ranges across the shared
// files, sorts, and merges overlapping ranges; merged total = unique physical
// bytes contributed by shared blocks. unique = private_bytes + unique_shared.
//
// Build (binary):  clang -O2 -pthread -o clonesize clonesize.c
// Build (dylib):   clang -O2 -pthread -dynamiclib -o libclonesize.dylib clonesize.c
//   (cc is aliased to `claude` on this machine — always use clang.)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/attr.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/param.h>
#include <sys/vnode.h>
#include <time.h>

// fcntl.h already provides `struct log2phys` and F_LOG2PHYS_EXT (=65).

// ---------------------------------------------------------------------------
// Config (set by main() argv or by the exported clonesize_run_json())
// ---------------------------------------------------------------------------
static int    g_nthreads   = 0;      // 0 => auto (ncpu)
static int    g_freeable   = 0;      // sum ATTR_CMNEXT_PRIVATESIZE (now always available; gates output only)
static size_t g_min_blocks = 0;      // skip files with alloc < this (bytes) — 0 = keep all
static double g_clone_pct  = 0.30;   // group "clone-flagged" if >= this frac of its bytes is cross-group shared

// --changed-within: when > 0, only files with st_mtime >= this epoch second are
// accounted (the walk still descends every directory — a fresh file can live in
// an untouched dir). 0 disables the filter.
static uint64_t g_mtime_min = 0;

// APFS allocation block. `alloc` (ATTR_FILE_ALLOCSIZE) is always a multiple of
// this, so rounding extent ranges out to it converts the mapped-byte extent scan
// into an allocated-block one (see merge_pass).
#define BLK 4096ULL

// ---------------------------------------------------------------------------
// Extent cache.
//
// Profiling says 99.8% of a scan is the walk, and inside it each shared file
// costs ~17µs of open()+fcntl(F_LOG2PHYS_EXT)+close() — 8.0s of a 13.8s
// 712k-file scan. Everything else (merge, sort, cluster) is 0.03s.
//
// So the cache stores exactly that: a file's physical extent list, keyed by
// identity that cannot change without the extents changing. A hit on
// (fileid, mtime, datalength, allocsize) means the file was not written since we
// last mapped it, so its extents still are what we recorded — and we skip the
// syscalls entirely. Anything that rewrites a file bumps its mtime; anything
// that changes its length changes dlen/alloc.
//
// Not covered: an in-place rewrite that restores the exact mtime AND size (i.e.
// deliberate `touch -m` forgery), and APFS defragmenting blocks under a file
// without touching its metadata. `--no-cache` exists for both.
// ---------------------------------------------------------------------------
#define CACHE_MAGIC     0x48434143455A4C43ULL   // "CLZECACH"
#define CACHE_VERSION   1u
#define CACHE_MAX_RECS  2000000u                // ~96 MB of records + extents

typedef struct {
    uint64_t magic;
    uint32_t version;
    uint32_t reserved;
    uint64_t fsid;
    uint64_t nrecs;
    uint64_t nexts;
} CacheHeader;

typedef struct {
    uint64_t fileid;
    uint64_t mtime_ns;
    uint64_t dlen;
    uint64_t alloc;
    uint64_t ext_off;      // index into the extent blob
    uint32_t ext_count;
    uint32_t last_seen;    // epoch seconds, for eviction when over CACHE_MAX_RECS
} CacheEnt;

typedef struct { uint64_t dev, len; } CacheExt;

static const char *g_cache_dir = NULL;   // NULL disables the cache entirely
static int         g_cache_read = 1;     // --no-cache: still WRITE, just never READ
static char        g_cache_file[4096];
static uint64_t    g_fsid = 0;

// The mmap'd previous cache (read-only, shared by every worker thread).
static void       *g_cache_map = NULL;
static size_t      g_cache_map_len = 0;
static const CacheEnt *g_cache_ents = NULL;
static const CacheExt *g_cache_exts = NULL;
static uint64_t    g_cache_nents = 0, g_cache_nexts = 0;

/**
 * True when `count` items starting at index `off` fit inside `limit` items.
 *
 * Every bounds check against the cache MUST go through this. `off` and `count`
 * are read straight out of the cache file, so the obvious `off + count > limit`
 * is wrong: the sum wraps a 64-bit unsigned and lands back under `limit`, so the
 * check passes for a range nowhere near inside the mapping. Subtracting from the
 * limit instead is exact for every input, and dividing (rather than multiplying)
 * at the call site keeps byte-sized limits safe the same way.
 */
static inline int range_within(uint64_t off, uint64_t count, uint64_t limit) {
    return off <= limit && count <= limit - off;
}

/** Per-file record of what to write back — one per accounted shared file. */
typedef struct {
    uint64_t fileid, mtime_ns, dlen, alloc;
    size_t   ext_start;    // index into the owning thread's ext array
    uint32_t ext_count;
} CacheRec;

// PROFILE: when the env var PROFILE is set (any value), phase timings go to stderr.
static int    g_profile    = 0;

// --depth N: when >= 0, build a per-directory tree (nodes[] down to depth N). -1 disables.
static int    g_maxdepth   = -1;
static int    g_freeable_tree = 0;   // --freeable-tree: per-node ATTR_CMNEXT_PRIVATESIZE

// ---------------------------------------------------------------------------
// Tree nodes (--depth): every directory from the scan root (depth 0) down to
// g_maxdepth is a node; files/dirs deeper than g_maxdepth roll into their
// depth-g_maxdepth ancestor. Each dir in the walk is visited exactly once, so
// intern_node always appends a fresh node (no dedup needed).
// ---------------------------------------------------------------------------
typedef struct {
    int      parent;      // parent node id (-1 for root)
    int      depth;       // 0 = root
    char    *name;        // basename (root uses the scan-root path)
    uint64_t naive, files, priv;   // rolled up to whole subtree in the post-pass
    uint64_t private_dlen;         // Σ dlen of fully-private files (their MAPPED unique contribution)
    uint64_t private_alloc;        // Σ alloc of fully-private files (their ALLOCATED contribution)
    uint64_t apparent;             // Σ dlen of every accounted file (sparse files count full)
    uint64_t sparse_extra;         // Σ (dlen - alloc) over files where dlen > alloc
    uint64_t sparse_files;         // count of those files
    uint64_t unique_shared;        // unique MAPPED bytes from shared extents (post-pass)
    uint64_t cross;                // mapped bytes shared with dirs OUTSIDE this subtree
    uint64_t unique_shared_alloc;  // same as unique_shared, block-aligned
    uint64_t cross_alloc;          // same as cross, block-aligned
} Node;
static Node  *g_nodes = NULL;
static int    g_nnodes = 0, g_node_cap = 0;
static pthread_mutex_t g_node_mtx = PTHREAD_MUTEX_INITIALIZER;

static int intern_node(int parent, const char *name, int depth) {
    pthread_mutex_lock(&g_node_mtx);
    if (g_nnodes == g_node_cap) {
        g_node_cap = g_node_cap ? g_node_cap * 2 : 1024;
        g_nodes = realloc(g_nodes, (size_t)g_node_cap * sizeof(Node));
        if (!g_nodes) { perror("realloc nodes"); exit(1); }
    }
    int id = g_nnodes++;
    memset(&g_nodes[id], 0, sizeof(Node));
    g_nodes[id].parent = parent;
    g_nodes[id].depth = depth;
    g_nodes[id].name = strdup(name);
    if (!g_nodes[id].name) { perror("strdup node name"); exit(1); }
    pthread_mutex_unlock(&g_node_mtx);
    return id;
}

// Per-file record emitted by the parallel scan in --depth mode; node accounting
// (naive/files/priv/private-unique/sparse) is done single-threaded in the post-pass.
typedef struct { int node; uint64_t alloc, dlen, priv; int is_private; } FileRec;

// ---------------------------------------------------------------------------
// Groups: each immediate child (dir or file) of the scan root is one group.
// ---------------------------------------------------------------------------
// Upper bound on immediate-children groups. Cross-group sharing is computed by a
// per-cluster distinct-group scan (not a 64-bit mask), so this is just the size of
// the per-thread accumulator arrays — generous enough that no realistic scan root
// (a dir with thousands of direct children is already pathological) ever folds.
#define MAX_GROUPS 4096
static char    *g_group_names[MAX_GROUPS];
static int      g_ngroups = 0;
static pthread_mutex_t g_group_mtx = PTHREAD_MUTEX_INITIALIZER;
static uint64_t g_group_naive[MAX_GROUPS];
static uint64_t g_group_files[MAX_GROUPS];
static uint64_t g_group_private[MAX_GROUPS];

// Directory subtrees to prune during the walk (detected git worktrees, etc.).
#define MAX_EXCLUDES 256
static const char *g_excludes[MAX_EXCLUDES];
static int g_nexcludes = 0;

// Mount points of OTHER filesystems inside the scan root, pruned before the walk
// can touch them (`du -x` semantics). Two reasons:
//   1. Accounting: another volume's bytes are not this volume's used space, so
//      counting them makes the volume reconcile wrong by construction.
//   2. Robustness: /System/Volumes/Data on this machine contains an autofs trigger
//      (`map auto_home` at /System/Volumes/Data/home) and an NFS export (OrbStack
//      at ~/OrbStack). Descending into either can block a worker thread in an
//      uninterruptible syscall for as long as the server takes to answer.
// Pruning by PATH from getmntinfo() — before any open() — is what keeps that
// unreachable; deciding by the child's fsid would mean stat'ing the mount point,
// which is the very call that can block.
#define MAX_FOREIGN_MOUNTS 512
static char *g_foreign_mounts[MAX_FOREIGN_MOUNTS];
static int   g_nforeign = 0;

// ---------------------------------------------------------------------------
// Cloud-provider roots (macOS File Provider): ~/Library/CloudStorage/<provider>
// and ~/Library/Mobile Documents (iCloud Drive).
//
// These are NOT mount points — they sit on the same device as everything else,
// so the mount pruning above cannot see them — but reading them goes through the
// provider's extension. Measured here: all 16 workers parked in getattrlistbulk
// inside ~/Library/CloudStorage/Tresorit-*, zero progress, for minutes.
//
// Skipping them is also the CORRECT accounting. Their contents are largely
// dataless placeholders whose bytes live on someone else's disk, and touching a
// placeholder can trigger a download — a disk-usage tool must never quietly pull
// gigabytes over the network to measure them. `--include-cloud` opts back in.
// ---------------------------------------------------------------------------
#define MAX_CLOUD_ROOTS 128
static char *g_cloud_roots[MAX_CLOUD_ROOTS];
static int   g_ncloud = 0;
static int   g_skip_cloud = 1;
static pthread_mutex_t g_cloud_mtx = PTHREAD_MUTEX_INITIALIZER;

/** True when `dirpath` is a `Library` whose child `name` is a cloud-provider root. */
static int is_cloud_root(const char *dirpath, const char *name) {
    if (!g_skip_cloud) return 0;
    if (strcmp(name, "CloudStorage") != 0 && strcmp(name, "Mobile Documents") != 0) return 0;
    size_t dl = strlen(dirpath);
    return dl >= 8 && strcmp(dirpath + dl - 8, "/Library") == 0;
}

static void note_cloud_root(const char *path) {
    pthread_mutex_lock(&g_cloud_mtx);
    if (g_ncloud < MAX_CLOUD_ROOTS) {
        char *c = strdup(path);
        if (c) g_cloud_roots[g_ncloud++] = c;
    }
    pthread_mutex_unlock(&g_cloud_mtx);
}

static int is_excluded(const char *path) {
    for (int i = 0; i < g_nexcludes; i++)
        if (strcmp(g_excludes[i], path) == 0) return 1;
    for (int i = 0; i < g_nforeign; i++)
        if (strcmp(g_foreign_mounts[i], path) == 0) return 1;
    return 0;
}

// ---------------------------------------------------------------------------
// Permission denials. A tree the scanner cannot open is a silent hole in the
// total (on this machine .DocumentRevisions-V100 / .Spotlight-V100 / .fseventsd
// hid ~132 GB), so every EACCES/EPERM is counted and the first MAX_DENIED paths
// are kept for the report.
// ---------------------------------------------------------------------------
#define MAX_DENIED 64
static char    *g_denied_paths[MAX_DENIED];
static int      g_denied_kept = 0;
static uint64_t g_denied_dirs = 0, g_denied_files = 0;
static pthread_mutex_t g_denied_mtx = PTHREAD_MUTEX_INITIALIZER;

static void note_denied(const char *path, int is_dir) {
    pthread_mutex_lock(&g_denied_mtx);
    if (is_dir) g_denied_dirs++; else g_denied_files++;
    if (g_denied_kept < MAX_DENIED) {
        char *c = strdup(path);
        if (c) g_denied_paths[g_denied_kept++] = c;
    }
    pthread_mutex_unlock(&g_denied_mtx);
}

static int intern_group(const char *name) {
    pthread_mutex_lock(&g_group_mtx);
    int r = MAX_GROUPS - 1;
    for (int i = 0; i < g_ngroups; i++) {
        if (strcmp(g_group_names[i], name) == 0) { r = i; goto out; }
    }
    if (g_ngroups < MAX_GROUPS) {
        g_group_names[g_ngroups] = strdup(name);
        if (!g_group_names[g_ngroups]) { perror("strdup group name"); exit(1); }
        r = g_ngroups++;
    }
out:
    pthread_mutex_unlock(&g_group_mtx);
    return r;
}

// ---------------------------------------------------------------------------
// Extent record (per thread, then merged globally). `node` is the file's leaf
// tree-node (its directory clamped to --depth), used only in --depth tree mode.
// ---------------------------------------------------------------------------
typedef struct { uint64_t dev; uint64_t len; int group; int node; uint32_t file; } Ext;

// ---------------------------------------------------------------------------
// Partner mode (`tools du clones`): phase 1 scans the TARGET and merges its
// extents into g_tgt_ranges; phase 2 re-walks the wider ROOT and, for every
// shared file outside the target, reports how many of its bytes land inside
// those ranges — i.e. which concrete paths the target's blocks also live at.
// ---------------------------------------------------------------------------
typedef struct { char *path; uint64_t bytes; } PartnerRec;
typedef struct { uint64_t start, end; } Range;
static Range   *g_tgt_ranges = NULL;
static size_t   g_ntgt_ranges = 0;
static int      g_partner_mode = 0;
static const char *g_partner_target = NULL;   // absolute path, no trailing slash
static size_t   g_partner_target_len = 0;

typedef struct {
    Ext     *exts;
    size_t   n, cap;
    uint64_t naive;                     // sum alloc for this thread's files
    uint64_t unique_private;            // sum dlen of fully-private (skipped) files — MAPPED
    uint64_t unique_private_alloc;      // sum alloc of the same files — ALLOCATED blocks
    uint64_t priv_sum;                  // sum of privatesize across all files
    uint64_t apparent;                  // sum dlen of accounted files (sparse count full)
    uint64_t sparse_extra;              // sum (dlen - alloc) over files where dlen > alloc
    uint64_t sparse_files;              // count of those files
    uint64_t group_naive[MAX_GROUPS];
    uint64_t group_files[MAX_GROUPS];
    uint64_t group_private[MAX_GROUPS];
    uint64_t files_listed;              // all regular files seen
    uint64_t files_accounted;           // alloc>0 && >=min  (private + shared)
    uint64_t files_opened;              // shared files actually opened+scanned
    uint64_t files_cached;              // shared files served from the extent cache
    uint64_t priv_opened;               // sum privatesize over files whose extents we collected
    int      tid;                       // thread index, for minting globally unique file ids
    uint32_t file_seq;
    FileRec *recs;                      // --depth mode: per-file node records
    size_t   nrecs, rec_cap;
    PartnerRec *partners;               // partner mode: files overlapping the target
    size_t   npartners, partner_cap;
    CacheRec *crecs;                    // cache write-back records
    size_t   ncrecs, crec_cap;
} ThreadOut;

/** Worker count of the walk in flight; the stride next_file_id mints ids on. */
static int g_walk_threads = 1;

/**
 * A globally unique id for one scanned file, minted per worker so no atomics are
 * needed: worker t hands out t, t+N, t+2N, … for N workers, so no two workers can
 * produce the same id at any thread count. (A bit-field split cannot say that: it
 * fixes a ceiling on the thread index, and --threads accepts up to 1024.) Only
 * files whose extents we actually collect get one, which is what the
 * outside-sharing detection below needs, see merge_pass's single-file clusters.
 *
 * Ids wrap after 2^32, which is unreachable: every id owns at least one 32-byte
 * Ext, so 4.3e9 files is >137 GB of extent array and the scan dies on malloc long
 * before an id repeats.
 */
static uint32_t next_file_id(ThreadOut *t) {
    return t->file_seq++ * (uint32_t)g_walk_threads + (uint32_t)t->tid;
}

static void ext_push(ThreadOut *t, uint64_t dev, uint64_t len, int group, int node, uint32_t file) {
    if (t->n == t->cap) {
        t->cap = t->cap ? t->cap * 2 : 8192;
        t->exts = realloc(t->exts, t->cap * sizeof(Ext));
        if (!t->exts) { perror("realloc exts"); exit(1); }
    }
    t->exts[t->n].dev = dev;
    t->exts[t->n].len = len;
    t->exts[t->n].group = group;
    t->exts[t->n].node = node;
    t->exts[t->n].file = file;
    t->n++;
}

static void rec_push(ThreadOut *t, int node, uint64_t alloc, uint64_t dlen, uint64_t priv, int is_private) {
    if (t->nrecs == t->rec_cap) {
        t->rec_cap = t->rec_cap ? t->rec_cap * 2 : 8192;
        t->recs = realloc(t->recs, t->rec_cap * sizeof(FileRec));
        if (!t->recs) { perror("realloc recs"); exit(1); }
    }
    t->recs[t->nrecs].node = node;
    t->recs[t->nrecs].alloc = alloc;
    t->recs[t->nrecs].dlen = dlen;
    t->recs[t->nrecs].priv = priv;
    t->recs[t->nrecs].is_private = is_private;
    t->nrecs++;
}

static void crec_push(ThreadOut *t, uint64_t fileid, uint64_t mtime_ns, uint64_t dlen, uint64_t alloc,
                      size_t ext_start, uint32_t ext_count) {
    if (t->ncrecs == t->crec_cap) {
        t->crec_cap = t->crec_cap ? t->crec_cap * 2 : 8192;
        t->crecs = realloc(t->crecs, t->crec_cap * sizeof(CacheRec));
        if (!t->crecs) { perror("realloc crecs"); exit(1); }
    }
    t->crecs[t->ncrecs].fileid = fileid;
    t->crecs[t->ncrecs].mtime_ns = mtime_ns;
    t->crecs[t->ncrecs].dlen = dlen;
    t->crecs[t->ncrecs].alloc = alloc;
    t->crecs[t->ncrecs].ext_start = ext_start;
    t->crecs[t->ncrecs].ext_count = ext_count;
    t->ncrecs++;
}

/** Binary search the mmap'd cache. Returns NULL on miss or when the identity moved. */
static const CacheEnt *cache_lookup(uint64_t fileid, uint64_t mtime_ns, uint64_t dlen, uint64_t alloc) {
    if (!g_cache_ents || g_cache_nents == 0) return NULL;
    uint64_t lo = 0, hi = g_cache_nents;
    while (lo < hi) {
        uint64_t mid = lo + (hi - lo) / 2;
        if (g_cache_ents[mid].fileid < fileid) lo = mid + 1; else hi = mid;
    }
    if (lo >= g_cache_nents || g_cache_ents[lo].fileid != fileid) return NULL;
    const CacheEnt *e = &g_cache_ents[lo];
    if (e->mtime_ns != mtime_ns || e->dlen != dlen || e->alloc != alloc) return NULL;
    if (!range_within(e->ext_off, e->ext_count, g_cache_nexts)) return NULL;   // corrupt/truncated
    return e;
}

static void partner_push(ThreadOut *t, const char *path, uint64_t bytes) {
    if (t->npartners == t->partner_cap) {
        t->partner_cap = t->partner_cap ? t->partner_cap * 2 : 256;
        t->partners = realloc(t->partners, t->partner_cap * sizeof(PartnerRec));
        if (!t->partners) { perror("realloc partners"); exit(1); }
    }
    t->partners[t->npartners].path = strdup(path);
    if (!t->partners[t->npartners].path) { perror("strdup partner path"); exit(1); }
    t->partners[t->npartners].bytes = bytes;
    t->npartners++;
}

// Bytes of [s,e) that fall inside the merged target ranges (binary search to the
// first range that can overlap, then walk forward while ranges still start before e).
static uint64_t range_overlap(uint64_t s, uint64_t e) {
    if (g_ntgt_ranges == 0 || e <= s) return 0;
    size_t lo = 0, hi = g_ntgt_ranges;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (g_tgt_ranges[mid].end <= s) lo = mid + 1; else hi = mid;
    }
    uint64_t sum = 0;
    for (size_t i = lo; i < g_ntgt_ranges && g_tgt_ranges[i].start < e; i++) {
        uint64_t a = g_tgt_ranges[i].start > s ? g_tgt_ranges[i].start : s;
        uint64_t b = g_tgt_ranges[i].end   < e ? g_tgt_ranges[i].end   : e;
        if (b > a) sum += b - a;
    }
    return sum;
}

/** True when `path` is the partner target itself or lives inside it. */
static int under_partner_target(const char *path) {
    if (!g_partner_target) return 0;
    if (strncmp(path, g_partner_target, g_partner_target_len) != 0) return 0;
    char after = path[g_partner_target_len];
    return after == '\0' || after == '/';
}

// ---------------------------------------------------------------------------
// Extent scan of ONE already-open shared file.
// ---------------------------------------------------------------------------
static void scan_shared_file(ThreadOut *t, int fd, off_t size, int group, int node, uint32_t file) {
    off_t off = 0;
    while (off < size) {
        struct log2phys l2p;
        memset(&l2p, 0, sizeof(l2p));
        l2p.l2p_contigbytes = size - off;   // IN: bytes to query
        l2p.l2p_devoffset   = off;          // IN: file offset
        if (fcntl(fd, F_LOG2PHYS_EXT, &l2p) < 0) break;
        off_t contig = l2p.l2p_contigbytes; // OUT: contiguous bytes at this offset
        if (contig <= 0) break;
        if ((uint64_t)l2p.l2p_devoffset != (uint64_t)-1) // (off_t)-1 => sparse hole, skip
            ext_push(t, (uint64_t)l2p.l2p_devoffset, (uint64_t)contig, group, node, file);
        off += contig;
    }
}

/** Partner mode: same walk, but sum the file's overlap with the target ranges. */
static uint64_t overlap_shared_file(int fd, off_t size) {
    off_t off = 0;
    uint64_t sum = 0;
    while (off < size) {
        struct log2phys l2p;
        memset(&l2p, 0, sizeof(l2p));
        l2p.l2p_contigbytes = size - off;
        l2p.l2p_devoffset   = off;
        if (fcntl(fd, F_LOG2PHYS_EXT, &l2p) < 0) break;
        off_t contig = l2p.l2p_contigbytes;
        if (contig <= 0) break;
        if ((uint64_t)l2p.l2p_devoffset != (uint64_t)-1)
            sum += range_overlap((uint64_t)l2p.l2p_devoffset, (uint64_t)l2p.l2p_devoffset + (uint64_t)contig);
        off += contig;
    }
    return sum;
}

// ---------------------------------------------------------------------------
// Directory work queue. Parallelizes both the getattrlistbulk walk AND the
// inline extent scan of shared files. `node`/`depth` carry the --depth tree
// position (node = the file's directory clamped to g_maxdepth).
// ---------------------------------------------------------------------------
typedef struct { char *path; int group; int node; int depth; } DirJob;
static DirJob *g_q = NULL;
static size_t  g_qn = 0, g_qcap = 0, g_pending = 0;
static int     g_done = 0;
static pthread_mutex_t g_qmtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  g_qcv  = PTHREAD_COND_INITIALIZER;

static void q_push(char *path, int group, int node, int depth) {
    pthread_mutex_lock(&g_qmtx);
    if (g_qn == g_qcap) {
        g_qcap = g_qcap ? g_qcap * 2 : 4096;
        g_q = realloc(g_q, g_qcap * sizeof(DirJob));
        if (!g_q) { perror("realloc dirq"); exit(1); }
    }
    g_q[g_qn].path = path;
    g_q[g_qn].group = group;
    g_q[g_qn].node = node;
    g_q[g_qn].depth = depth;
    g_qn++;
    g_pending++;
    pthread_cond_signal(&g_qcv);
    pthread_mutex_unlock(&g_qmtx);
}

// getattrlistbulk entry layout (4-byte packed, FSOPT_PACK_INVAL_ATTRS). Fields
// appear in sys/attr.h BIT order, not request order, so inserting an attribute
// shifts everything after it — verified empirically against fstatat() each time
// one was added here:
//   0  u32 length | 4 returned_attrs(20) | 24 name attrref(8) | 32 objtype(4)
//   36 modtime timespec(16) | 52 fileid u64(8) | 60 linkcount u32(4)
//   64 alloc off_t(8) | 72 datalength off_t(8) | 80 privatesize off_t(8)
static struct attrlist g_al;
static uint64_t g_alopt;

static void process_dir(ThreadOut *t, const char *dirpath, int dirgroup, int dirnode, int depth) {
    int dfd = open(dirpath, O_RDONLY | O_DIRECTORY | O_NONBLOCK);
    if (dfd < 0) {
        if (errno == EACCES || errno == EPERM) note_denied(dirpath, 1);
        return;
    }
    char buf[64 * 1024];
    for (;;) {
        int n = getattrlistbulk(dfd, &g_al, buf, sizeof buf, g_alopt);
        if (n <= 0) break;
        char *p = buf;
        for (int e = 0; e < n; e++) {
            char *entry = p;
            uint32_t len; memcpy(&len, entry, 4);
            uint32_t off = 4 + 20;
            int32_t nameoff; memcpy(&nameoff, entry + off, 4);
            const char *name = entry + off + nameoff;
            off += 8;
            uint32_t objtype; memcpy(&objtype, entry + off, 4); off += 4;
            int64_t  mtime, mnsec;
            memcpy(&mtime, entry + off, 8);
            memcpy(&mnsec, entry + off + 8, 8);
            off += 16;                                                    // timespec: sec + nsec
            uint64_t fileid;  memcpy(&fileid,  entry + off, 8); off += 8;
            uint32_t nlink;   memcpy(&nlink,   entry + off, 4); off += 4;
            off_t alloc; memcpy(&alloc, entry + off, 8); off += 8;
            off_t dlen;  memcpy(&dlen,  entry + off, 8); off += 8;
            off_t priv;  memcpy(&priv,  entry + off, 8); off += 8;
            p += len;

            if (objtype == VDIR) {
                if (name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'))) continue;
                int g = (dirgroup < 0) ? intern_group(name) : dirgroup;
                size_t pl = strlen(dirpath), nl = strlen(name);
                char *sub = malloc(pl + 1 + nl + 1);
                memcpy(sub, dirpath, pl); sub[pl] = '/'; memcpy(sub + pl + 1, name, nl + 1);
                if ((g_nexcludes || g_nforeign) && is_excluded(sub)) { free(sub); continue; }
                if (is_cloud_root(dirpath, name)) { note_cloud_root(sub); free(sub); continue; }
                // --depth: a child at depth<=maxdepth is its own node; deeper dirs
                // inherit their depth-maxdepth ancestor's node.
                int childnode = dirnode;
                if (g_maxdepth >= 0 && depth + 1 <= g_maxdepth) childnode = intern_node(dirnode, name, depth + 1);
                q_push(sub, g, childnode, depth + 1);
                continue;
            }
            if (objtype != VREG) continue; // symlinks/others: skip (du doesn't follow either)

            int g = (dirgroup < 0) ? intern_group(name) : dirgroup;
            t->files_listed++;
            // --changed-within: attribute only files touched inside the window.
            // Directories are still descended — a fresh file can sit in an old dir.
            if (g_mtime_min && (uint64_t)mtime < g_mtime_min) continue;
            t->priv_sum += (uint64_t)priv;
            if (alloc == 0 || (size_t)alloc < g_min_blocks) continue;

            uint64_t a = (uint64_t)alloc;
            t->naive += a;
            t->group_naive[g] += a;
            t->group_files[g] += 1;
            t->group_private[g] += (uint64_t)priv;
            t->files_accounted++;
            t->apparent += (uint64_t)dlen;
            if ((uint64_t)dlen > a) {
                t->sparse_extra += (uint64_t)dlen - a;
                t->sparse_files++;
            }

            // Partner mode: only shared files can host another file's blocks, so
            // the private-file skip below doubles as the partner-mode filter.
            if (g_partner_mode) {
                if ((uint64_t)priv >= a && nlink <= 1 && a >= (uint64_t)dlen) continue;
                size_t pl = strlen(dirpath), nl = strlen(name);
                char *full = malloc(pl + 1 + nl + 1);
                if (!full) { perror("malloc partner path"); exit(1); }
                memcpy(full, dirpath, pl); full[pl] = '/'; memcpy(full + pl + 1, name, nl + 1);
                if (under_partner_target(full)) { free(full); continue; }
                int pfd = openat(dfd, name, O_RDONLY | O_NONBLOCK);
                if (pfd < 0) {
                    if (errno == EACCES || errno == EPERM) note_denied(full, 0);
                    free(full);
                    continue;
                }
                t->files_opened++;
                uint64_t ov = overlap_shared_file(pfd, dlen);
                close(pfd);
                if (ov > 0) partner_push(t, full, ov);
                free(full);
                continue;
            }

            // NOSKIP=1 (env) disables the skip optimization below — every file is
            // opened + extent-scanned, matching the pre-skip engine. Intentional
            // cross-check escape hatch: the skip must produce byte-identical output
            // to NOSKIP, so it's the harness for proving the optimization exact.
            static int noskip = -1;
            if (noskip < 0) noskip = getenv("NOSKIP") ? 1 : 0;
            // Skip the open ONLY when the file shares nothing (priv==alloc), is not
            // hardlinked, and is not sparse. Then its unique contribution equals the
            // scan's result WITHOUT opening it: the mapped-extent bytes == datalength
            // (the extent scan sums logical/mapped bytes, block-slack excluded — so we
            // add dlen, NOT alloc). Guards:
            //  - nlink>1: a hardlinked inode reports priv==alloc on every dentry
            //    (privatesize is per-inode) but all dentries map to the same extents,
            //    which the merge must dedup — so scan them.
            //  - alloc<dlen: sparse file (holes); its mapped bytes < dlen, so scan it.
            if (!noskip && (uint64_t)priv >= a && nlink <= 1 && a >= (uint64_t)dlen) {
                t->unique_private += (uint64_t)dlen;
                t->unique_private_alloc += a;
                if (g_maxdepth >= 0) rec_push(t, dirnode, a, (uint64_t)dlen, (uint64_t)priv, 1);
                continue;
            }
            // Shares some blocks. Its extent map is the expensive part (~17µs of
            // open+fcntl+close), so try the cache before paying for it.
            uint64_t mtime_ns = (uint64_t)mtime * 1000000000ULL + (uint64_t)mnsec;
            size_t ext_start = t->n;
            if (g_cache_read) {
                const CacheEnt *hit = cache_lookup(fileid, mtime_ns, (uint64_t)dlen, a);
                if (hit) {
                    uint32_t fid = next_file_id(t);
                    for (uint32_t x = 0; x < hit->ext_count; x++) {
                        const CacheExt *ce = &g_cache_exts[hit->ext_off + x];
                        ext_push(t, ce->dev, ce->len, g, g_maxdepth >= 0 ? dirnode : -1, fid);
                    }
                    t->priv_opened += (uint64_t)priv;
                    t->files_cached++;
                    if (g_cache_dir) {
                        crec_push(t, fileid, mtime_ns, (uint64_t)dlen, a, ext_start, hit->ext_count);
                    }
                    if (g_maxdepth >= 0) rec_push(t, dirnode, a, (uint64_t)dlen, (uint64_t)priv, 0);
                    continue;
                }
            }

            // Open by leaf (dfd is the parent) and extent-scan.
            int ffd = openat(dfd, name, O_RDONLY | O_NONBLOCK);
            if (ffd < 0) {
                if (errno == EACCES || errno == EPERM) {
                    size_t pl = strlen(dirpath), nl = strlen(name);
                    char *full = malloc(pl + 1 + nl + 1);
                    if (full) {
                        memcpy(full, dirpath, pl); full[pl] = '/'; memcpy(full + pl + 1, name, nl + 1);
                        note_denied(full, 0);
                        free(full);
                    }
                }
                continue;
            }
            t->files_opened++;
            scan_shared_file(t, ffd, dlen, g, g_maxdepth >= 0 ? dirnode : -1, next_file_id(t));
            t->priv_opened += (uint64_t)priv;
            close(ffd);
            if (g_cache_dir) {
                crec_push(t, fileid, mtime_ns, (uint64_t)dlen, a, ext_start, (uint32_t)(t->n - ext_start));
            }
            if (g_maxdepth >= 0) rec_push(t, dirnode, a, (uint64_t)dlen, (uint64_t)priv, 0);
        }
    }
    close(dfd);
}

static ThreadOut *g_outs = NULL;
static void *worker(void *arg) {
    ThreadOut *t = arg;
    for (;;) {
        pthread_mutex_lock(&g_qmtx);
        while (g_qn == 0 && !g_done) pthread_cond_wait(&g_qcv, &g_qmtx);
        if (g_qn == 0 && g_done) { pthread_mutex_unlock(&g_qmtx); break; }
        DirJob job = g_q[--g_qn];
        pthread_mutex_unlock(&g_qmtx);

        process_dir(t, job.path, job.group, job.node, job.depth);
        free(job.path);

        pthread_mutex_lock(&g_qmtx);
        if (--g_pending == 0) { g_done = 1; pthread_cond_broadcast(&g_qcv); }
        pthread_mutex_unlock(&g_qmtx);
    }
    return NULL;
}

// ---------------------------------------------------------------------------
// Union-find over groups (cluster worktrees that clone each other)
// ---------------------------------------------------------------------------
static int g_uf[MAX_GROUPS];
static int uf_find(int x) { while (g_uf[x] != x) { g_uf[x] = g_uf[g_uf[x]]; x = g_uf[x]; } return x; }
static void uf_union(int a, int b) { a = uf_find(a); b = uf_find(b); if (a != b) g_uf[a] = b; }

static int cmp_ext(const void *a, const void *b) {
    const Ext *x = a, *y = b;
    if (x->dev < y->dev) return -1;
    if (x->dev > y->dev) return 1;
    return 0;
}

// ---------------------------------------------------------------------------
// Cluster merge over the sorted extent array.
//
// Run TWICE over the same sorted array:
//   align=0 — raw ranges. The extent scan stops at datalength, so this sums the
//             MAPPED bytes: exact against the extents, but short of what the
//             volume actually spends by each file's sub-block tail slack.
//   align=1 — every range rounded out to an APFS allocation block. That tail
//             slack is recovered, so the total is the ALLOCATED bytes, which is
//             what `du`, `diskutil` and the free-space counter agree on.
// Aligning starts DOWN preserves the sort order, so one qsort feeds both passes.
// ---------------------------------------------------------------------------
typedef struct {
    uint64_t unique_shared, cross_shared;
    /**
     * Bytes in clusters touched by exactly ONE scanned file. Such a block was
     * collected because the file shares with something (fully private files are
     * never opened), yet nothing else inside the scan references it — so the
     * sharing partner lies OUTSIDE the scan root. Subtracting the private bytes
     * of those same files turns this into the outside-shared figure.
     */
    uint64_t single_file;
    uint64_t group_shared[MAX_GROUPS];
} MergeOut;

static int merge_pass(const Ext *all, size_t total_exts, int align, int do_groups, MergeOut *M) {
    memset(M, 0, sizeof *M);

    int gcap = g_ngroups > 0 ? g_ngroups : 1;
    int *seen_epoch = malloc((size_t)gcap * sizeof(int));
    int *dg = malloc((size_t)gcap * sizeof(int));
    if (!seen_epoch || !dg) { perror("malloc groups"); free(seen_epoch); free(dg); return 1; }
    for (int g = 0; g < gcap; g++) seen_epoch[g] = -1;

    // --depth node accounting scratch (epoch-marked, no reset between clusters).
    int   ncap = g_nnodes > 0 ? g_nnodes : 1;
    int  *leaf_seen = NULL, *cov_epoch = NULL, *cov_count = NULL, *leaves = NULL, *touched = NULL;
    if (g_maxdepth >= 0) {
        leaf_seen = malloc((size_t)ncap * sizeof(int));
        cov_epoch = malloc((size_t)ncap * sizeof(int));
        cov_count = malloc((size_t)ncap * sizeof(int));
        leaves    = malloc((size_t)ncap * sizeof(int));
        touched   = malloc((size_t)ncap * sizeof(int));
        if (!leaf_seen || !cov_epoch || !cov_count || !leaves || !touched) { perror("malloc nodes"); return 1; }
        for (int a = 0; a < ncap; a++) { leaf_seen[a] = -1; cov_epoch[a] = -1; }
    }

    #define RSTART(x) (align ? ((x).dev & ~(BLK - 1)) : (x).dev)
    #define REND(x)   (align ? (((x).dev + (x).len + BLK - 1) & ~(BLK - 1)) : (x).dev + (x).len)

    size_t i = 0;
    int epoch = 0;
    while (i < total_exts) {
        uint64_t cs = RSTART(all[i]), ce = REND(all[i]);
        size_t j = i + 1;
        while (j < total_exts && RSTART(all[j]) < ce) {
            uint64_t en = REND(all[j]);
            if (en > ce) ce = en;
            j++;
        }
        uint64_t clen = ce - cs;
        M->unique_shared += clen;

        uint32_t f0 = all[i].file;
        int single_file = 1;
        for (size_t k = i + 1; k < j; k++) {
            if (all[k].file != f0) { single_file = 0; break; }
        }
        if (single_file) M->single_file += clen;

        // Distinct groups touching this cluster, in first-appearance order.
        int ndg = 0;
        for (size_t k = i; k < j; k++) {
            int g = all[k].group;
            if (g >= 0 && g < g_ngroups && seen_epoch[g] != epoch) {
                seen_epoch[g] = epoch;
                dg[ndg++] = g;
            }
        }
        if (ndg > 1) {
            // Ascending order → stable clone-cluster ids (parity with the old mask).
            for (int a = 1; a < ndg; a++) {
                int v = dg[a], b = a - 1;
                while (b >= 0 && dg[b] > v) { dg[b + 1] = dg[b]; b--; }
                dg[b + 1] = v;
            }
            M->cross_shared += clen;
            int first = dg[0];
            for (int m = 0; m < ndg; m++) {
                M->group_shared[dg[m]] += clen;
                if (m > 0 && do_groups) uf_union(first, dg[m]);
            }
        }

        // --depth: credit clen to every tree node whose subtree touches this cluster.
        // A node is "cross" if only SOME (not all) distinct leaves are under it.
        if (g_maxdepth >= 0) {
            int nleaf = 0, ntouch = 0;
            for (size_t k = i; k < j; k++) {
                int nd = all[k].node;
                if (nd >= 0 && nd < g_nnodes && leaf_seen[nd] != epoch) {
                    leaf_seen[nd] = epoch;
                    leaves[nleaf++] = nd;
                }
            }
            for (int li = 0; li < nleaf; li++) {
                for (int a = leaves[li]; a >= 0; a = g_nodes[a].parent) {
                    if (cov_epoch[a] != epoch) { cov_epoch[a] = epoch; cov_count[a] = 0; touched[ntouch++] = a; }
                    cov_count[a]++;
                }
            }
            for (int ti = 0; ti < ntouch; ti++) {
                int a = touched[ti];
                if (align) {
                    g_nodes[a].unique_shared_alloc += clen;
                    if (cov_count[a] < nleaf) g_nodes[a].cross_alloc += clen;
                } else {
                    g_nodes[a].unique_shared += clen;
                    if (cov_count[a] < nleaf) g_nodes[a].cross += clen;
                }
            }
        }
        epoch++;
        i = j;
    }

    #undef RSTART
    #undef REND

    free(seen_epoch);
    free(dg);
    if (g_maxdepth >= 0) { free(leaf_seen); free(cov_epoch); free(cov_count); free(leaves); free(touched); }
    return 0;
}

// ---------------------------------------------------------------------------
// Computed result
// ---------------------------------------------------------------------------
typedef struct {
    uint64_t naive, unique, shared, cross_shared, priv_sum;
    uint64_t unique_alloc;                  // same dedup, block-aligned (what the disk loses)
    uint64_t outside_shared;                // blocks also referenced by files OUTSIDE the scan root
    uint64_t apparent, sparse_extra, sparse_files;
    uint64_t files_listed, files_accounted, files_opened, files_cached, extents;
    int      threads;
    double   pct;
    uint64_t group_shared[MAX_GROUPS];
} Result;

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

/**
 * Collect every mount point inside `target` that belongs to a DIFFERENT
 * filesystem, so the walk can prune them by path without ever opening them.
 */
static void collect_foreign_mounts(const char *target) {
    for (int i = 0; i < g_nforeign; i++) { free(g_foreign_mounts[i]); g_foreign_mounts[i] = NULL; }
    g_nforeign = 0;

    struct statfs root;
    if (statfs(target, &root) < 0) return;

    struct statfs *mnts = NULL;
    int n = getmntinfo(&mnts, MNT_NOWAIT);
    size_t tlen = strlen(target);
    while (tlen > 1 && target[tlen - 1] == '/') tlen--;

    // Only a scan rooted at (or inside) the Data volume sees firmlinked mount paths.
    const char *DATA = "/System/Volumes/Data";
    size_t dlen_ = strlen(DATA);
    int firmlink_root = strncmp(target, DATA, dlen_) == 0 && (target[dlen_] == '\0' || target[dlen_] == '/');

    for (int i = 0; i < n && g_nforeign < MAX_FOREIGN_MOUNTS; i++) {
        const char *mp = mnts[i].f_mntonname;
        if (mnts[i].f_fsid.val[0] == root.f_fsid.val[0] &&
            mnts[i].f_fsid.val[1] == root.f_fsid.val[1]) continue;   // same filesystem

        // Spelling 1: the mount path as reported, when it sits inside the scan root.
        int inside = strncmp(mp, target, tlen) == 0 && mp[tlen] == '/';
        if (inside) {
            char *c = strdup(mp);
            if (c) g_foreign_mounts[g_nforeign++] = c;
        }

        // Spelling 2: <target><mp>, but ONLY under the Data volume. macOS firmlinks
        // /Users, /Library, /private … from /System/Volumes/Data, so the mount table
        // records OrbStack's NFS export as /Users/Martin/OrbStack while a scan rooted
        // at /System/Volumes/Data reaches the very same directory as
        // /System/Volumes/Data/Users/Martin/OrbStack. Spelling 1 never matches that,
        // so without this the whole-volume scan walks straight into the NFS export.
        if (!inside && firmlink_root && strcmp(mp, "/") != 0 && mp[0] == '/' &&
            g_nforeign < MAX_FOREIGN_MOUNTS) {
            size_t mlen = strlen(mp);
            char *c = malloc(tlen + mlen + 1);
            if (c) {
                memcpy(c, target, tlen);
                memcpy(c + tlen, mp, mlen + 1);
                g_foreign_mounts[g_nforeign++] = c;
            }
        }
    }
}

/** The attribute set every getattrlistbulk call requests. See the layout note above. */
static void setup_attrlist(void) {
    memset(&g_al, 0, sizeof g_al);
    g_al.bitmapcount = ATTR_BIT_MAP_COUNT;
    g_al.commonattr  = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE |
                       ATTR_CMN_MODTIME | ATTR_CMN_FILEID;
    g_al.fileattr    = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE | ATTR_FILE_DATALENGTH;
    g_al.forkattr    = ATTR_CMNEXT_PRIVATESIZE;
    g_alopt = FSOPT_PACK_INVAL_ATTRS | FSOPT_ATTR_CMN_EXTENDED | FSOPT_NOFOLLOW;
}

/** Fused parallel walk + inline extent scan. Leaves g_outs for the caller to drain. */
static void spawn_walk(const char *target, int nthreads, int rootnode) {
    setup_attrlist();
    collect_foreign_mounts(target);
    g_walk_threads = nthreads > 0 ? nthreads : 1;
    g_outs = calloc(nthreads, sizeof(ThreadOut));
    pthread_t *th = calloc(nthreads, sizeof(pthread_t));
    if (!g_outs || !th) { perror("calloc walk"); exit(1); }
    for (int i = 0; i < nthreads; i++) g_outs[i].tid = i;
    q_push(strdup(target), -1, rootnode, 0);
    for (int i = 0; i < nthreads; i++) pthread_create(&th[i], NULL, worker, &g_outs[i]);
    for (int i = 0; i < nthreads; i++) pthread_join(th[i], NULL);
    free(th);
}

// ---------------------------------------------------------------------------
// Extent cache I/O. One file per volume under the caller-supplied directory, so
// a single cache serves every scan root on that volume (fileids are volume-wide).
// ---------------------------------------------------------------------------
static void cache_open(const char *target) {
    g_cache_map = NULL; g_cache_map_len = 0;
    g_cache_ents = NULL; g_cache_exts = NULL;
    g_cache_nents = 0; g_cache_nexts = 0;
    if (!g_cache_dir) return;

    struct statfs sfs;
    if (statfs(target, &sfs) < 0) { g_cache_dir = NULL; return; }
    g_fsid = ((uint64_t)(uint32_t)sfs.f_fsid.val[0] << 32) | (uint32_t)sfs.f_fsid.val[1];
    snprintf(g_cache_file, sizeof g_cache_file, "%s/extents-%016llx.bin",
             g_cache_dir, (unsigned long long)g_fsid);

    if (!g_cache_read) return;

    int fd = open(g_cache_file, O_RDONLY);
    if (fd < 0) return;
    struct stat st;
    if (fstat(fd, &st) < 0 || (size_t)st.st_size < sizeof(CacheHeader)) { close(fd); return; }

    void *map = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (map == MAP_FAILED) return;

    const CacheHeader *h = map;

    // Bound each count against the space that is actually there, DIVIDING the
    // available bytes into elements rather than multiplying the counts out.
    // Multiplying first wraps a 64-bit size_t — nrecs = 2^60 makes
    // nrecs * sizeof(CacheEnt) exactly 0, so a "total > st_size" test passes and
    // cache_lookup then binary-searches 2^60 entries across a 280-byte mapping
    // (verified: SIGSEGV, exit 139). Division cannot overflow.
    size_t avail = (size_t)st.st_size - sizeof(CacheHeader);
    if (h->magic != CACHE_MAGIC || h->version != CACHE_VERSION || h->fsid != g_fsid ||
        !range_within(0, h->nrecs, avail / sizeof(CacheEnt))) {
        munmap(map, (size_t)st.st_size);
        return;
    }

    // Safe to scale now: nrecs is known to fit, so this cannot wrap or underflow.
    size_t after_ents = avail - (size_t)h->nrecs * sizeof(CacheEnt);
    if (!range_within(0, h->nexts, after_ents / sizeof(CacheExt))) {
        munmap(map, (size_t)st.st_size);
        return;
    }

    g_cache_map = map;
    g_cache_map_len = (size_t)st.st_size;
    g_cache_ents = (const CacheEnt *)((const char *)map + sizeof(CacheHeader));
    g_cache_exts = (const CacheExt *)(g_cache_ents + h->nrecs);
    g_cache_nents = h->nrecs;
    g_cache_nexts = h->nexts;
}

static void cache_close(void) {
    if (g_cache_map) munmap(g_cache_map, g_cache_map_len);
    g_cache_map = NULL; g_cache_map_len = 0;
    g_cache_ents = NULL; g_cache_exts = NULL;
    g_cache_nents = 0; g_cache_nexts = 0;
}

// A record staged for the new cache file. Its extents live either in one of this
// run's thread arrays (stride sizeof(Ext)) or in the previous mmap'd cache
// (stride sizeof(CacheExt)) — exactly one of the two pointers is set.
typedef struct {
    CacheEnt        ent;
    const Ext      *from_scan;
    const CacheExt *from_old;
} PendEnt;

static int cmp_pend(const void *a, const void *b) {
    const PendEnt *x = a, *y = b;
    if (x->ent.fileid < y->ent.fileid) return -1;
    if (x->ent.fileid > y->ent.fileid) return 1;
    return 0;
}

static int cmp_pend_recency(const void *a, const void *b) {
    const PendEnt *x = a, *y = b;
    if (x->ent.last_seen > y->ent.last_seen) return -1;   // newest first
    if (x->ent.last_seen < y->ent.last_seen) return 1;
    return 0;
}

/**
 * Merge this run's records with whatever the previous cache still holds and
 * rewrite the file. Written to a temp path then rename(2)'d, so a killed scan
 * can never leave a half-written cache behind.
 *
 * Must run BEFORE the thread extent arrays are freed — the records point into them.
 */
static void cache_write(int nthreads) {
    if (!g_cache_dir || g_cache_file[0] == '\0') return;

    size_t nnew = 0, opened = 0;
    for (int i = 0; i < nthreads; i++) {
        nnew += g_outs[i].ncrecs;
        opened += g_outs[i].files_opened;
    }

    // A miss always leads to an open(), so zero opens means every record we would
    // write is already on disk byte-for-byte. Skip the rewrite: on a fully warm
    // repeat scan this saves rewriting tens of MB to learn nothing. The cost is
    // that `last_seen` is not refreshed, which only matters once the cache is over
    // CACHE_MAX_RECS and eviction starts caring about recency.
    if (opened == 0 && g_cache_nents > 0) return;

    size_t cap = nnew + (size_t)g_cache_nents;
    PendEnt *pend = malloc((cap ? cap : 1) * sizeof(PendEnt));
    if (!pend) return;

    uint32_t now = (uint32_t)time(NULL);
    size_t n = 0;
    for (int i = 0; i < nthreads; i++) {
        for (size_t r = 0; r < g_outs[i].ncrecs; r++) {
            const CacheRec *cr = &g_outs[i].crecs[r];
            pend[n].ent.fileid    = cr->fileid;
            pend[n].ent.mtime_ns  = cr->mtime_ns;
            pend[n].ent.dlen      = cr->dlen;
            pend[n].ent.alloc     = cr->alloc;
            pend[n].ent.ext_off   = 0;
            pend[n].ent.ext_count = cr->ext_count;
            pend[n].ent.last_seen = now;
            pend[n].from_scan     = g_outs[i].exts + cr->ext_start;
            pend[n].from_old      = NULL;
            n++;
        }
    }

    // Sort by fileid and collapse hardlink duplicates (one inode, many dentries).
    qsort(pend, n, sizeof(PendEnt), cmp_pend);
    size_t uniq = 0;
    for (size_t i = 0; i < n; i++) {
        if (uniq > 0 && pend[uniq - 1].ent.fileid == pend[i].ent.fileid) continue;
        pend[uniq++] = pend[i];
    }
    n = uniq;

    // Carry over previous entries this run never saw — they belong to scan roots
    // outside this one, and dropping them would make the cache root-scoped.
    size_t oi = 0, ni = 0, merged = n;
    while (oi < g_cache_nents) {
        uint64_t fid = g_cache_ents[oi].fileid;
        while (ni < n && pend[ni].ent.fileid < fid) ni++;
        if (ni < n && pend[ni].ent.fileid == fid) { oi++; continue; }
        // Carrying a record over means reading its extents back out of the old
        // mapping, so it needs the same bound cache_lookup applies. Nothing had
        // checked this one: a forged ext_off reached the fwrite loop below and
        // read outside the mapping even when the header itself was consistent.
        if (!range_within(g_cache_ents[oi].ext_off, g_cache_ents[oi].ext_count, g_cache_nexts)) { oi++; continue; }

        pend[merged].ent = g_cache_ents[oi];
        pend[merged].ent.ext_off = 0;
        pend[merged].from_scan = NULL;
        pend[merged].from_old = &g_cache_exts[g_cache_ents[oi].ext_off];
        merged++;
        oi++;
    }
    n = merged;

    // Over the cap, keep the most recently seen records (this run's are all `now`).
    if (n > CACHE_MAX_RECS) {
        qsort(pend, n, sizeof(PendEnt), cmp_pend_recency);
        n = CACHE_MAX_RECS;
    }
    qsort(pend, n, sizeof(PendEnt), cmp_pend);

    uint64_t total_exts = 0;
    for (size_t i = 0; i < n; i++) {
        pend[i].ent.ext_off = total_exts;
        total_exts += pend[i].ent.ext_count;
    }

    char tmp[4200];
    snprintf(tmp, sizeof tmp, "%s.tmp.%d", g_cache_file, (int)getpid());
    FILE *f = fopen(tmp, "wb");
    if (!f) { free(pend); return; }

    CacheHeader h = { CACHE_MAGIC, CACHE_VERSION, 0, g_fsid, (uint64_t)n, total_exts };
    int ok = fwrite(&h, sizeof h, 1, f) == 1;
    for (size_t i = 0; i < n && ok; i++) ok = fwrite(&pend[i].ent, sizeof(CacheEnt), 1, f) == 1;
    for (size_t i = 0; i < n && ok; i++) {
        for (uint32_t x = 0; x < pend[i].ent.ext_count && ok; x++) {
            CacheExt ce;
            if (pend[i].from_scan) {
                ce.dev = pend[i].from_scan[x].dev;
                ce.len = pend[i].from_scan[x].len;
            } else {
                ce = pend[i].from_old[x];
            }
            ok = fwrite(&ce, sizeof ce, 1, f) == 1;
        }
    }
    int closed = fclose(f) == 0;
    if (ok && closed) {
        rename(tmp, g_cache_file);
    } else {
        unlink(tmp);
        fprintf(stderr, "clonesize: failed to write extent cache %s\n", g_cache_file);
    }
    free(pend);
}

static int resolve_threads(void) {
    if (g_nthreads > 0) return g_nthreads;
    long nc = sysconf(_SC_NPROCESSORS_ONLN);
    return (nc > 0) ? (int)nc : 4;
}

// Runs the full scan; fills *R. Returns 0 on success.
static int run_scan(const char *target, Result *R) {
    memset(R, 0, sizeof *R);

    int nthreads = resolve_threads();

    double t0 = now_s();

    cache_open(target);

    // --depth: root is node 0 (depth 0). Files loose in the root belong to it.
    int rootnode = (g_maxdepth >= 0) ? intern_node(-1, target, 0) : -1;
    spawn_walk(target, nthreads, rootnode);

    double t1 = now_s();

    // Before the merge frees the thread extent arrays the records point into.
    cache_write(nthreads);
    cache_close();

    // Merge thread outputs.
    size_t total_exts = 0;
    uint64_t naive = 0, unique_private = 0, unique_private_alloc = 0, priv_sum = 0;
    uint64_t apparent = 0, sparse_extra = 0, sparse_files = 0;
    uint64_t files_listed = 0, files_accounted = 0, files_opened = 0, files_cached = 0, priv_opened = 0;
    for (int i = 0; i < nthreads; i++) {
        total_exts           += g_outs[i].n;
        files_cached         += g_outs[i].files_cached;
        priv_opened          += g_outs[i].priv_opened;
        free(g_outs[i].crecs);
        naive                += g_outs[i].naive;
        unique_private       += g_outs[i].unique_private;
        unique_private_alloc += g_outs[i].unique_private_alloc;
        priv_sum             += g_outs[i].priv_sum;
        apparent             += g_outs[i].apparent;
        sparse_extra         += g_outs[i].sparse_extra;
        sparse_files         += g_outs[i].sparse_files;
        files_listed         += g_outs[i].files_listed;
        files_accounted      += g_outs[i].files_accounted;
        files_opened         += g_outs[i].files_opened;
        for (int g = 0; g < g_ngroups; g++) {
            g_group_naive[g]   += g_outs[i].group_naive[g];
            g_group_files[g]   += g_outs[i].group_files[g];
            g_group_private[g] += g_outs[i].group_private[g];
        }
        // --depth: accumulate per-leaf-node naive/files/priv/private-unique/sparse.
        for (size_t r = 0; r < g_outs[i].nrecs; r++) {
            FileRec *fr = &g_outs[i].recs[r];
            Node *nd = &g_nodes[fr->node];
            nd->naive    += fr->alloc;
            nd->files    += 1;
            nd->priv     += fr->priv;
            nd->apparent += fr->dlen;
            if (fr->dlen > fr->alloc) {
                nd->sparse_extra += fr->dlen - fr->alloc;
                nd->sparse_files++;
            }
            if (fr->is_private) {
                nd->private_dlen  += fr->dlen;
                nd->private_alloc += fr->alloc;
            }
        }
        free(g_outs[i].recs);
    }

    Ext *all = malloc((total_exts ? total_exts : 1) * sizeof(Ext));
    if (!all) { perror("malloc merge"); return 1; }
    size_t k = 0;
    for (int i = 0; i < nthreads; i++) {
        if (g_outs[i].n) memcpy(all + k, g_outs[i].exts, g_outs[i].n * sizeof(Ext));
        k += g_outs[i].n;
        free(g_outs[i].exts);
    }
    free(g_outs); g_outs = NULL;

    double t2 = now_s();

    // Sort by device offset, merge overlapping clusters. For each merged cluster,
    // collect its DISTINCT groups by scanning the cluster's own extents. This
    // replaces the old uint64 group bitmask (which capped groups at 64 and made a
    // scan root with >64 immediate children fold everything past the 63rd into one
    // bogus overflow bucket) — there is no 64-group limit here.
    qsort(all, total_exts, sizeof(Ext), cmp_ext);
    for (int i = 0; i < MAX_GROUPS; i++) g_uf[i] = i;

    MergeOut mapped, alloced;
    if (merge_pass(all, total_exts, 0, 1, &mapped) != 0) { free(all); return 1; }
    if (merge_pass(all, total_exts, 1, 0, &alloced) != 0) { free(all); return 1; }
    free(all);

    // --depth: roll naive/files/priv/private-unique/apparent up to ancestors (child
    // id > parent id, since a parent interns its children — descending id = children first).
    if (g_maxdepth >= 0) {
        for (int a = g_nnodes - 1; a > 0; a--) {
            int par = g_nodes[a].parent;
            if (par < 0) continue;
            g_nodes[par].naive         += g_nodes[a].naive;
            g_nodes[par].files         += g_nodes[a].files;
            g_nodes[par].priv          += g_nodes[a].priv;
            g_nodes[par].private_dlen  += g_nodes[a].private_dlen;
            g_nodes[par].private_alloc += g_nodes[a].private_alloc;
            g_nodes[par].apparent      += g_nodes[a].apparent;
            g_nodes[par].sparse_extra  += g_nodes[a].sparse_extra;
            g_nodes[par].sparse_files  += g_nodes[a].sparse_files;
        }
    }

    double t3 = now_s();

    uint64_t unique = unique_private + mapped.unique_shared;
    uint64_t shared = (naive > unique) ? naive - unique : 0;

    R->naive = naive;
    R->unique = unique;
    R->unique_alloc = unique_private_alloc + alloced.unique_shared;
    // Single-file clusters hold both the file's own private blocks and the blocks
    // it shares with something outside the scan; privatesize separates the two.
    R->outside_shared = alloced.single_file > priv_opened ? alloced.single_file - priv_opened : 0;
    R->apparent = apparent;
    R->sparse_extra = sparse_extra;
    R->sparse_files = sparse_files;
    R->shared = shared;
    R->cross_shared = mapped.cross_shared;
    R->priv_sum = priv_sum;
    R->files_listed = files_listed;
    R->files_accounted = files_accounted;
    R->files_opened = files_opened;
    R->files_cached = files_cached;
    R->extents = total_exts;
    R->threads = nthreads;
    R->pct = naive ? 100.0 * (double)shared / (double)naive : 0.0;
    memcpy(R->group_shared, mapped.group_shared, sizeof mapped.group_shared);

    if (g_profile) {
        fprintf(stderr,
            "[profile] walk+scan %.3fs · merge %.3fs · sort+cluster %.3fs · total %.3fs "
            "(opened %llu/%llu files, %llu extents)\n",
            t1 - t0, t2 - t1, t3 - t2, t3 - t0,
            (unsigned long long)files_opened, (unsigned long long)files_accounted,
            (unsigned long long)total_exts);
    }
    return 0;
}

// Build a node's full path (root name + basenames of the ancestor chain) into buf.
static void node_path(int a, char *buf, size_t cap) {
    int chain[4096]; int n = 0;
    for (int x = a; x >= 0 && n < 4096; x = g_nodes[x].parent) chain[n++] = x;
    size_t len = 0;
    for (int k = n - 1; k >= 0; k--) {
        const char *nm = g_nodes[chain[k]].name;
        int need = snprintf(buf + len, len < cap ? cap - len : 0,
                            "%s%s", (k == n - 1) ? "" : "/", nm);
        if (need > 0) len += (size_t)need;
    }
}

// ---------------------------------------------------------------------------
// JSON output (used by the CLI --format json AND the bun:ffi dylib entry)
// ---------------------------------------------------------------------------

// Escape a filesystem string into a JSON string body (no surrounding quotes).
// Returns a malloc'd buffer the caller frees. macOS names may contain any byte
// except '/' and NUL, so '"' / '\\' / control chars must be escaped or the
// emitted JSON is invalid and SafeJSON.parse aborts the whole scan.
static char *json_escape(const char *s) {
    size_t n = strlen(s);
    char *o = malloc(n * 6 + 1);   // worst case \u00XX per byte
    if (!o) { perror("malloc json_escape"); exit(1); }
    size_t k = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  o[k++] = '\\'; o[k++] = '"';  break;
            case '\\': o[k++] = '\\'; o[k++] = '\\'; break;
            case '\n': o[k++] = '\\'; o[k++] = 'n';  break;
            case '\r': o[k++] = '\\'; o[k++] = 'r';  break;
            case '\t': o[k++] = '\\'; o[k++] = 't';  break;
            default:
                if (c < 0x20) { k += (size_t)snprintf(o + k, 7, "\\u%04x", c); }
                else          { o[k++] = (char)c; }
        }
    }
    o[k] = '\0';
    return o;
}

static char *format_json(const char *target, const Result *R) {
    size_t cap = 8192 + (size_t)g_ngroups * 256 + (size_t)g_nnodes * 640;
    char *out = malloc(cap);
    size_t len = 0;
    #define EMIT(...) do { \
        int need = snprintf(out + len, cap - len, __VA_ARGS__); \
        if (need < 0) return out; \
        if ((size_t)need >= cap - len) { cap = (cap + need) * 2; out = realloc(out, cap); \
            need = snprintf(out + len, cap - len, __VA_ARGS__); } \
        len += need; \
    } while (0)

    EMIT("{\n");
    char *tesc = json_escape(target);
    EMIT("  \"path\": \"%s\",\n", tesc);
    free(tesc);
    EMIT("  \"files_scanned\": %llu,\n", (unsigned long long)R->files_accounted);
    EMIT("  \"files_listed\": %llu,\n", (unsigned long long)R->files_listed);
    EMIT("  \"files_opened\": %llu,\n", (unsigned long long)R->files_opened);
    EMIT("  \"files_cached\": %llu,\n", (unsigned long long)R->files_cached);
    EMIT("  \"extents\": %llu,\n", (unsigned long long)R->extents);
    EMIT("  \"threads\": %d,\n", R->threads);
    EMIT("  \"naive_bytes\": %llu,\n", (unsigned long long)R->naive);
    EMIT("  \"unique_bytes\": %llu,\n", (unsigned long long)R->unique);
    EMIT("  \"unique_allocated_bytes\": %llu,\n", (unsigned long long)R->unique_alloc);
    EMIT("  \"outside_shared_bytes\": %llu,\n", (unsigned long long)R->outside_shared);
    EMIT("  \"apparent_bytes\": %llu,\n", (unsigned long long)R->apparent);
    EMIT("  \"sparse_bytes\": %llu,\n", (unsigned long long)R->sparse_extra);
    EMIT("  \"sparse_files\": %llu,\n", (unsigned long long)R->sparse_files);
    EMIT("  \"shared_bytes\": %llu,\n", (unsigned long long)R->shared);
    EMIT("  \"shared_pct\": %.2f,\n", R->pct);
    EMIT("  \"cross_group_shared_bytes\": %llu,\n", (unsigned long long)R->cross_shared);
    EMIT("  \"private_sum_bytes\": %llu,\n", (unsigned long long)R->priv_sum);
    EMIT("  \"denied_dirs\": %llu,\n", (unsigned long long)g_denied_dirs);
    EMIT("  \"denied_files\": %llu,\n", (unsigned long long)g_denied_files);
    EMIT("  \"skipped_cloud\": [");
    for (int c = 0; c < g_ncloud; c++) {
        char *cesc = json_escape(g_cloud_roots[c]);
        EMIT("%s\"%s\"", c ? ", " : "", cesc);
        free(cesc);
    }
    EMIT("],\n");
    EMIT("  \"skipped_mounts\": [");
    for (int m = 0; m < g_nforeign; m++) {
        char *mesc = json_escape(g_foreign_mounts[m]);
        EMIT("%s\"%s\"", m ? ", " : "", mesc);
        free(mesc);
    }
    EMIT("],\n");
    EMIT("  \"denied_paths\": [");
    for (int d = 0; d < g_denied_kept; d++) {
        char *desc = json_escape(g_denied_paths[d]);
        EMIT("%s\"%s\"", d ? ", " : "", desc);
        free(desc);
    }
    EMIT("],\n");
    if (g_mtime_min)
        EMIT("  \"changed_since\": %llu,\n", (unsigned long long)g_mtime_min);
    EMIT("  \"groups\": [\n");
    int emitted = 0;
    for (int g = 0; g < g_ngroups; g++) {
        uint64_t gn = g_group_naive[g];
        if (gn == 0) continue;
        int more = 0;
        for (int h = g + 1; h < g_ngroups; h++) if (g_group_naive[h]) { more = 1; break; }
        double gsh = 100.0 * (double)R->group_shared[g] / (double)gn;
        int flagged = (R->group_shared[g] >= (uint64_t)(g_clone_pct * (double)gn)) && R->group_shared[g] > 0;
        char *gesc = json_escape(g_group_names[g]);
        EMIT("    {\"name\": \"%s\", \"naive_bytes\": %llu, \"files\": %llu, "
             "\"cross_group_shared_bytes\": %llu, \"shared_pct\": %.2f, "
             "\"clone_cluster\": %d, \"clone_flagged\": %s",
             gesc, (unsigned long long)gn,
             (unsigned long long)g_group_files[g],
             (unsigned long long)R->group_shared[g], gsh,
             uf_find(g), flagged ? "true" : "false");
        free(gesc);
        EMIT(", \"private_bytes\": %llu", (unsigned long long)g_group_private[g]);
        EMIT("}%s\n", more ? "," : "");
        emitted++;
    }
    (void)emitted;
    EMIT("  ]");

    // --depth: flat nodes[] tree (each dir to depth N). unique = shared-extent
    // unique + rolled-up private bytes; cross = bytes shared OUTSIDE the subtree.
    if (g_maxdepth >= 0) {
        EMIT(",\n  \"depth\": %d,\n  \"nodes\": [\n", g_maxdepth);
        char pbuf[8192];
        int nfirst = 1;
        for (int a = 0; a < g_nnodes; a++) {
            Node *nd = &g_nodes[a];
            if (nd->naive < g_min_blocks) continue;
            uint64_t u = nd->unique_shared + nd->private_dlen;
            uint64_t ua = nd->unique_shared_alloc + nd->private_alloc;
            // Deleting the subtree frees at least Σ per-file private bytes (blocks
            // exclusive volume-wide) and at most its allocated unique minus what it
            // shares with dirs outside itself.
            uint64_t ceil_free = ua > nd->cross_alloc ? ua - nd->cross_alloc : 0;
            double xpct = nd->naive ? 100.0 * (double)nd->cross / (double)nd->naive : 0.0;
            int flagged = (nd->cross >= (uint64_t)(g_clone_pct * (double)nd->naive)) && nd->cross > 0;
            node_path(a, pbuf, sizeof pbuf);
            char *pesc = json_escape(pbuf);
            EMIT("%s    {\"path\": \"%s\", \"depth\": %d, \"parent\": %d, \"naive_bytes\": %llu, "
                 "\"unique_bytes\": %llu, \"unique_allocated_bytes\": %llu, \"cross_shared_bytes\": %llu, "
                 "\"cross_shared_allocated_bytes\": %llu, \"shared_pct\": %.2f, "
                 "\"files\": %llu, \"clone_flagged\": %s, \"private_bytes\": %llu, "
                 "\"freeable_floor_bytes\": %llu, \"freeable_ceiling_bytes\": %llu, "
                 "\"apparent_bytes\": %llu, \"sparse_bytes\": %llu, \"sparse_files\": %llu",
                 nfirst ? "" : ",\n", pesc, nd->depth, nd->parent, (unsigned long long)nd->naive,
                 (unsigned long long)u, (unsigned long long)ua, (unsigned long long)nd->cross,
                 (unsigned long long)nd->cross_alloc, xpct,
                 (unsigned long long)nd->files, flagged ? "true" : "false",
                 (unsigned long long)nd->priv,
                 (unsigned long long)nd->priv, (unsigned long long)ceil_free,
                 (unsigned long long)nd->apparent, (unsigned long long)nd->sparse_extra,
                 (unsigned long long)nd->sparse_files);
            free(pesc);
            EMIT("}");
            nfirst = 0;
        }
        EMIT("\n  ]");
    }
    EMIT("\n}\n");
    #undef EMIT
    return out;
}

// ---------------------------------------------------------------------------
// Human output (CLI only)
// ---------------------------------------------------------------------------
static void print_human(const char *target, const Result *R, int quiet) {
    const double MB = 1024.0 * 1024.0, GB = MB * 1024.0;
    #define HUM(b) ((b) >= (uint64_t)(GB) ? (b)/GB : (b)/MB), ((b) >= (uint64_t)(GB) ? "GB" : "MB")
    printf("Path:            %s\n", target);
    printf("Files scanned:   %llu (of %llu listed, %llu opened, %llu cached)  •  %d threads\n",
           (unsigned long long)R->files_accounted, (unsigned long long)R->files_listed,
           (unsigned long long)R->files_opened, (unsigned long long)R->files_cached, R->threads);
    printf("Naive (du-like): %8.1f %s   %llu bytes\n", HUM(R->naive), (unsigned long long)R->naive);
    printf("Unique mapped:   %8.1f %s   %llu bytes\n", HUM(R->unique), (unsigned long long)R->unique);
    printf("Unique on disk:  %8.1f %s   %llu bytes (allocated blocks)\n",
           HUM(R->unique_alloc), (unsigned long long)R->unique_alloc);
    printf("Shared (CoW):    %8.1f %s   (%.1f%% of naive collapses to shared blocks)\n",
           HUM(R->shared), R->pct);
    printf("Cross-worktree:  %8.1f %s   (shared across marked dirs)\n", HUM(R->cross_shared));
    printf("Deleting frees:  %8.1f %s   (>= this — per-file blocks private volume-wide)\n",
           HUM(R->priv_sum));
    if (R->outside_shared)
        printf("Shared OUTSIDE:  %8.1f %s   (blocks also referenced by files outside this scan root)\n",
               HUM(R->outside_shared));
    if (R->sparse_files)
        printf("Sparse:          %8.1f %s   apparent in %llu sparse file(s) never written to disk\n",
               HUM(R->sparse_extra), (unsigned long long)R->sparse_files);
    if (g_ncloud)
        printf("Cloud skipped:   %d provider root(s) not walked (placeholders, and reading them can download)\n",
               g_ncloud);
    if (g_denied_dirs || g_denied_files)
        printf("UNREADABLE:      %llu dir(s), %llu file(s) skipped — totals above are INCOMPLETE\n",
               (unsigned long long)g_denied_dirs, (unsigned long long)g_denied_files);

    if (!quiet && g_ngroups > 0) {
        printf("\nMarked directories (immediate children — worktrees/top-level dirs):\n");
        printf("  %-32s %10s %8s %10s %7s  %s\n", "dir", "naive", "files", "xshared", "share%", "clone-cluster");
        for (int g = 0; g < g_ngroups; g++) {
            uint64_t gn = g_group_naive[g];
            if (gn == 0) continue;
            double gsh = 100.0 * (double)R->group_shared[g] / (double)gn;
            int flagged = (R->group_shared[g] >= (uint64_t)(g_clone_pct * (double)gn)) && R->group_shared[g] > 0;
            char nb[32], xb[32];
            snprintf(nb, sizeof nb, "%.1f%s", HUM(gn));
            snprintf(xb, sizeof xb, "%.1f%s", HUM(R->group_shared[g]));
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

    if (g_denied_kept > 0) {
        printf("\nUnreadable (permission denied) — re-run these as root to close the gap:\n");
        for (int d = 0; d < g_denied_kept; d++) printf("  %s\n", g_denied_paths[d]);
        if ((uint64_t)g_denied_kept < g_denied_dirs + g_denied_files)
            printf("  ... and %llu more\n",
                   (unsigned long long)(g_denied_dirs + g_denied_files - (uint64_t)g_denied_kept));
    }
    #undef HUM
}

// ---------------------------------------------------------------------------
// bun:ffi entry point — one-shot scan, returns a malloc'd JSON string.
// Caller must clonesize_free() it. Not reentrant (uses process globals).
// ---------------------------------------------------------------------------
// Reset every accumulating global — the dylib lives across calls under bun:ffi,
// so anything left over from the previous scan would be double-counted.
static void reset_state(void) {
    for (int i = 0; i < g_ngroups; i++) { free(g_group_names[i]); g_group_names[i] = NULL; }
    g_ngroups = 0;
    memset(g_group_naive, 0, sizeof g_group_naive);
    memset(g_group_files, 0, sizeof g_group_files);
    memset(g_group_private, 0, sizeof g_group_private);
    for (int i = 0; i < g_nnodes; i++) free(g_nodes[i].name);
    free(g_nodes); g_nodes = NULL; g_nnodes = 0; g_node_cap = 0;
    for (int i = 0; i < g_denied_kept; i++) { free(g_denied_paths[i]); g_denied_paths[i] = NULL; }
    g_denied_kept = 0; g_denied_dirs = 0; g_denied_files = 0;
    for (int i = 0; i < g_ncloud; i++) { free(g_cloud_roots[i]); g_cloud_roots[i] = NULL; }
    g_ncloud = 0;
    g_qn = 0; g_pending = 0; g_done = 0;
}

__attribute__((visibility("default")))
char *clonesize_run_json(const char *path, int threads, int freeable,
                         unsigned long long min_bytes,
                         const char *const *excludes, int nexcludes,
                         int depth, int freeable_tree,
                         unsigned long long changed_since,
                         const char *cache_dir, int cache_read, int include_cloud) {
    g_nthreads = threads;
    g_freeable = freeable;
    g_min_blocks = (size_t)min_bytes;
    g_maxdepth = depth;                 // < 0 disables the tree
    g_freeable_tree = freeable_tree;
    g_mtime_min = changed_since;
    g_partner_mode = 0;
    g_cache_dir = (cache_dir && cache_dir[0]) ? cache_dir : NULL;
    g_cache_read = cache_read;
    g_skip_cloud = include_cloud ? 0 : 1;
    if (g_freeable_tree && g_maxdepth < 0) g_maxdepth = 1;
    g_profile = getenv("PROFILE") ? 1 : 0;
    g_nexcludes = 0;
    for (int i = 0; i < nexcludes && i < MAX_EXCLUDES; i++) g_excludes[g_nexcludes++] = excludes[i];

    reset_state();
    Result R;
    if (run_scan(path, &R) != 0) return NULL;
    return format_json(path, &R);
}

// ---------------------------------------------------------------------------
// Volume reconcile: the authoritative used-bytes for a mount, straight from the
// APFS layer. ATTR_VOL_SPACEUSED is the same number `diskutil info <mount>`
// prints as "Volume Used Space" (verified byte-for-byte on this machine), so a
// scan that lands under it has a hole — unreadable subtrees, most likely.
// Attributes come back in sys/attr.h bit order: SIZE, SPACEFREE, SPACEAVAIL,
// then SPACEUSED (0x00800000, far later than the rest).
// ---------------------------------------------------------------------------
__attribute__((visibility("default")))
char *clonesize_volume_json(const char *mount) {
    struct attrlist al;
    memset(&al, 0, sizeof al);
    al.bitmapcount = ATTR_BIT_MAP_COUNT;
    al.commonattr  = ATTR_CMN_RETURNED_ATTRS;
    al.volattr     = ATTR_VOL_INFO | ATTR_VOL_SIZE | ATTR_VOL_SPACEFREE |
                     ATTR_VOL_SPACEAVAIL | ATTR_VOL_SPACEUSED;

    struct {
        uint32_t        length;
        attribute_set_t returned;
        off_t           size, spacefree, spaceavail, spaceused;
    } __attribute__((aligned(4), packed)) vb;
    memset(&vb, 0, sizeof vb);

    if (getattrlist(mount, &al, &vb, sizeof vb, FSOPT_PACK_INVAL_ATTRS) < 0) return NULL;

    char *out = malloc(1024);
    if (!out) return NULL;
    char *mesc = json_escape(mount);
    snprintf(out, 1024,
             "{\n  \"mount\": \"%s\",\n  \"size_bytes\": %llu,\n  \"used_bytes\": %llu,\n"
             "  \"free_bytes\": %llu,\n  \"available_bytes\": %llu\n}\n",
             mesc, (unsigned long long)vb.size, (unsigned long long)vb.spaceused,
             (unsigned long long)vb.spacefree, (unsigned long long)vb.spaceavail);
    free(mesc);
    return out;
}

// ---------------------------------------------------------------------------
// Clone-partner query: "the target shares N bytes with something — WHERE?"
//
// Phase 1 walks the TARGET and merges its shared-file extents into g_tgt_ranges.
// Phase 2 walks the wider ROOT and, for every shared file outside the target,
// measures how many of its bytes land inside those ranges. A file that overlaps
// is literally holding the same physical blocks, which is the only honest answer
// to "is this cache safe to delete".
// ---------------------------------------------------------------------------
static int cmp_partner_bytes(const void *a, const void *b) {
    const PartnerRec *x = a, *y = b;
    if (x->bytes > y->bytes) return -1;
    if (x->bytes < y->bytes) return 1;
    return strcmp(x->path, y->path);
}

static int cmp_partner_path(const void *a, const void *b) {
    const PartnerRec *x = a, *y = b;
    return strcmp(x->path, y->path);
}

/** Sorts + merges every collected extent into g_tgt_ranges. Drains g_outs. */
static void build_target_ranges(int nthreads) {
    size_t total = 0;
    for (int i = 0; i < nthreads; i++) total += g_outs[i].n;

    Ext *all = malloc((total ? total : 1) * sizeof(Ext));
    if (!all) { perror("malloc target exts"); exit(1); }
    size_t k = 0;
    for (int i = 0; i < nthreads; i++) {
        if (g_outs[i].n) memcpy(all + k, g_outs[i].exts, g_outs[i].n * sizeof(Ext));
        k += g_outs[i].n;
        free(g_outs[i].exts);
        free(g_outs[i].recs);
    }
    free(g_outs); g_outs = NULL;

    qsort(all, total, sizeof(Ext), cmp_ext);
    free(g_tgt_ranges);
    g_tgt_ranges = malloc((total ? total : 1) * sizeof(Range));
    if (!g_tgt_ranges) { perror("malloc target ranges"); exit(1); }
    g_ntgt_ranges = 0;
    size_t i = 0;
    while (i < total) {
        uint64_t cs = all[i].dev, ce = all[i].dev + all[i].len;
        size_t j = i + 1;
        while (j < total && all[j].dev < ce) {
            uint64_t en = all[j].dev + all[j].len;
            if (en > ce) ce = en;
            j++;
        }
        g_tgt_ranges[g_ntgt_ranges].start = cs;
        g_tgt_ranges[g_ntgt_ranges].end = ce;
        g_ntgt_ranges++;
        i = j;
    }
    free(all);
}

__attribute__((visibility("default")))
char *clonesize_partners_json(const char *target, const char *root, int threads, int topn) {
    g_nthreads = threads;
    g_maxdepth = -1;
    g_freeable_tree = 0;
    g_min_blocks = 0;
    g_mtime_min = 0;
    g_nexcludes = 0;
    g_cache_dir = NULL;
    g_profile = getenv("PROFILE") ? 1 : 0;
    int nthreads = resolve_threads();
    if (topn <= 0) topn = 30;

    // Phase 1 — the target's own shared blocks.
    g_partner_mode = 0;
    g_partner_target = NULL;
    reset_state();
    spawn_walk(target, nthreads, -1);
    build_target_ranges(nthreads);

    uint64_t target_shared = 0;
    for (size_t r = 0; r < g_ntgt_ranges; r++) target_shared += g_tgt_ranges[r].end - g_tgt_ranges[r].start;

    // Phase 2 — who else holds them.
    g_partner_mode = 1;
    g_partner_target = target;
    g_partner_target_len = strlen(target);
    reset_state();
    spawn_walk(root, nthreads, -1);

    size_t np = 0;
    uint64_t opened = 0;
    for (int i = 0; i < nthreads; i++) { np += g_outs[i].npartners; opened += g_outs[i].files_opened; }
    PartnerRec *parts = malloc((np ? np : 1) * sizeof(PartnerRec));
    if (!parts) { perror("malloc partners"); exit(1); }
    size_t k = 0;
    for (int i = 0; i < nthreads; i++) {
        for (size_t j = 0; j < g_outs[i].npartners; j++) parts[k++] = g_outs[i].partners[j];
        free(g_outs[i].partners);
        free(g_outs[i].exts);
        free(g_outs[i].recs);
    }
    free(g_outs); g_outs = NULL;
    g_partner_mode = 0;
    g_partner_target = NULL;

    // Aggregate by parent directory before the top-N cut, so a cache split across
    // hundreds of files still shows up as one honest directory-level number.
    qsort(parts, np, sizeof(PartnerRec), cmp_partner_path);
    PartnerRec *dirs = malloc((np ? np : 1) * sizeof(PartnerRec));
    uint64_t *dir_files = malloc((np ? np : 1) * sizeof(uint64_t));
    if (!dirs || !dir_files) { perror("malloc partner dirs"); exit(1); }
    size_t ndirs = 0;
    for (size_t i = 0; i < np; i++) {
        const char *slash = strrchr(parts[i].path, '/');
        size_t dlen = slash ? (size_t)(slash - parts[i].path) : strlen(parts[i].path);
        if (ndirs > 0 && strlen(dirs[ndirs - 1].path) == dlen &&
            strncmp(dirs[ndirs - 1].path, parts[i].path, dlen) == 0) {
            dirs[ndirs - 1].bytes += parts[i].bytes;
            dir_files[ndirs - 1]++;
            continue;
        }
        char *d = malloc(dlen + 1);
        if (!d) { perror("malloc dir"); exit(1); }
        memcpy(d, parts[i].path, dlen); d[dlen] = '\0';
        dirs[ndirs].path = d;
        dirs[ndirs].bytes = parts[i].bytes;
        dir_files[ndirs] = 1;
        ndirs++;
    }

    qsort(parts, np, sizeof(PartnerRec), cmp_partner_bytes);
    // Insertion sort of the dir aggregates by bytes desc, carrying dir_files along
    // (a qsort would need the count packed into the record).
    for (size_t a = 1; a < ndirs; a++) {
        PartnerRec pv = dirs[a];
        uint64_t fv = dir_files[a];
        size_t b = a;
        while (b > 0 && dirs[b - 1].bytes < pv.bytes) {
            dirs[b] = dirs[b - 1];
            dir_files[b] = dir_files[b - 1];
            b--;
        }
        dirs[b] = pv;
        dir_files[b] = fv;
    }

    size_t cap = 8192 + (size_t)(np < (size_t)topn ? np : (size_t)topn) * 1024 +
                 (size_t)(ndirs < (size_t)topn ? ndirs : (size_t)topn) * 1024;
    char *out = malloc(cap);
    if (!out) { perror("malloc partners json"); exit(1); }
    size_t len = 0;
    #define PEMIT(...) do { \
        int need = snprintf(out + len, cap - len, __VA_ARGS__); \
        if (need < 0) break; \
        if ((size_t)need >= cap - len) { cap = (cap + need) * 2; out = realloc(out, cap); \
            need = snprintf(out + len, cap - len, __VA_ARGS__); } \
        len += need; \
    } while (0)

    uint64_t partner_total = 0;
    for (size_t i = 0; i < np; i++) partner_total += parts[i].bytes;

    char *tesc = json_escape(target), *resc = json_escape(root);
    PEMIT("{\n  \"target\": \"%s\",\n  \"root\": \"%s\",\n", tesc, resc);
    free(tesc); free(resc);
    PEMIT("  \"target_shared_bytes\": %llu,\n", (unsigned long long)target_shared);
    PEMIT("  \"partner_bytes\": %llu,\n", (unsigned long long)partner_total);
    PEMIT("  \"partner_files_total\": %llu,\n", (unsigned long long)np);
    PEMIT("  \"files_opened\": %llu,\n", (unsigned long long)opened);
    PEMIT("  \"denied_dirs\": %llu,\n", (unsigned long long)g_denied_dirs);
    PEMIT("  \"denied_files\": %llu,\n", (unsigned long long)g_denied_files);
    PEMIT("  \"partner_dirs\": [");
    for (size_t i = 0; i < ndirs && i < (size_t)topn; i++) {
        char *pesc = json_escape(dirs[i].path);
        PEMIT("%s\n    {\"path\": \"%s\", \"shared_bytes\": %llu, \"files\": %llu}",
              i ? "," : "", pesc, (unsigned long long)dirs[i].bytes, (unsigned long long)dir_files[i]);
        free(pesc);
    }
    PEMIT("%s],\n", ndirs ? "\n  " : "");
    PEMIT("  \"partner_files\": [");
    for (size_t i = 0; i < np && i < (size_t)topn; i++) {
        char *pesc = json_escape(parts[i].path);
        PEMIT("%s\n    {\"path\": \"%s\", \"shared_bytes\": %llu}",
              i ? "," : "", pesc, (unsigned long long)parts[i].bytes);
        free(pesc);
    }
    PEMIT("%s]\n}\n", np ? "\n  " : "");
    #undef PEMIT

    for (size_t i = 0; i < np; i++) free(parts[i].path);
    for (size_t i = 0; i < ndirs; i++) free(dirs[i].path);
    free(parts); free(dirs); free(dir_files);
    free(g_tgt_ranges); g_tgt_ranges = NULL; g_ntgt_ranges = 0;
    return out;
}

__attribute__((visibility("default")))
void clonesize_free(char *p) { free(p); }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Big-file listing (--bigfiles): every regular file at or above a size floor,
// across many roots, from ONE parallel getattrlistbulk pass that never opens a
// file and never asks for PRIVATESIZE. Dedupe wants the ~0.1% of files that
// are large enough to matter, and PRIVATESIZE doubles the per-entry kernel
// cost (measured: 12 s vs 6 s system time over 379k files), so this pass has
// its own attribute list. Directories named in --prune-name are not entered.
// Progress goes to stderr as one JSON line per BIG_PROGRESS_EVERY files, so a
// caller reading the pipe can drive a spinner while the walk runs.
// ---------------------------------------------------------------------------
typedef struct { char *path; uint64_t dlen, alloc, fileid, mtime_ns; uint32_t nlink; } BigRec;
typedef struct { BigRec *recs; size_t n, cap; uint64_t files, dirs; } BigOut;

#define BIG_PROGRESS_EVERY 200000ULL
#define MAX_PRUNE_NAMES 64
static struct attrlist g_big_al;
static uint64_t g_big_alopt;
static uint64_t g_big_min;
static const char *g_prune_names[MAX_PRUNE_NAMES];
static int g_nprune = 0;
static BigOut *g_big_outs = NULL;
static uint64_t g_big_progress = 0;   // files listed so far, all workers (atomic adds)

static void big_setup_attrlist(void) {
    memset(&g_big_al, 0, sizeof g_big_al);
    g_big_al.bitmapcount = ATTR_BIT_MAP_COUNT;
    g_big_al.commonattr  = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE |
                           ATTR_CMN_MODTIME | ATTR_CMN_FILEID;
    g_big_al.fileattr    = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE | ATTR_FILE_DATALENGTH;
    g_big_alopt = FSOPT_PACK_INVAL_ATTRS | FSOPT_NOFOLLOW;
}

static int is_pruned_name(const char *name) {
    for (int i = 0; i < g_nprune; i++) {
        if (strcmp(g_prune_names[i], name) == 0) return 1;
    }
    return 0;
}

static void big_push(BigOut *o, char *path, uint64_t dlen, uint64_t alloc, uint64_t fileid,
                     uint64_t mtime_ns, uint32_t nlink) {
    if (o->n == o->cap) {
        o->cap = o->cap ? o->cap * 2 : 256;
        o->recs = realloc(o->recs, o->cap * sizeof(BigRec));
        if (!o->recs) { perror("realloc bigrecs"); exit(1); }
    }
    BigRec *r = &o->recs[o->n++];
    r->path = path; r->dlen = dlen; r->alloc = alloc; r->fileid = fileid; r->mtime_ns = mtime_ns; r->nlink = nlink;
}

// Entry layout without the fork attr (same order as process_dir's, minus
// privatesize at the tail):
//   0 u32 length | 4 returned_attrs(20) | 24 name attrref(8) | 32 objtype(4)
//   36 modtime timespec(16) | 52 fileid u64(8) | 60 linkcount u32(4)
//   64 alloc off_t(8) | 72 datalength off_t(8)
static void big_process_dir(BigOut *o, const char *dirpath) {
    int dfd = open(dirpath, O_RDONLY | O_DIRECTORY | O_NONBLOCK);
    if (dfd < 0) {
        if (errno == EACCES || errno == EPERM) note_denied(dirpath, 1);
        return;
    }
    o->dirs++;
    char buf[64 * 1024];
    for (;;) {
        int n = getattrlistbulk(dfd, &g_big_al, buf, sizeof buf, g_big_alopt);
        if (n <= 0) break;
        char *p = buf;
        for (int e = 0; e < n; e++) {
            char *entry = p;
            uint32_t len; memcpy(&len, entry, 4);
            uint32_t off = 4 + 20;
            int32_t nameoff; memcpy(&nameoff, entry + off, 4);
            const char *name = entry + off + nameoff;
            off += 8;
            uint32_t objtype; memcpy(&objtype, entry + off, 4); off += 4;
            int64_t mtime, mnsec;
            memcpy(&mtime, entry + off, 8);
            memcpy(&mnsec, entry + off + 8, 8);
            off += 16;
            uint64_t fileid; memcpy(&fileid, entry + off, 8); off += 8;
            uint32_t nlink;  memcpy(&nlink,  entry + off, 4); off += 4;
            off_t alloc; memcpy(&alloc, entry + off, 8); off += 8;
            off_t dlen;  memcpy(&dlen,  entry + off, 8); off += 8;
            p += len;

            if (objtype == VDIR) {
                if (name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'))) continue;
                if (g_nprune && is_pruned_name(name)) continue;
                if (is_cloud_root(dirpath, name)) continue;
                size_t pl = strlen(dirpath), nl = strlen(name);
                char *sub = malloc(pl + 1 + nl + 1);
                if (!sub) { perror("malloc bigdir"); exit(1); }
                memcpy(sub, dirpath, pl); sub[pl] = '/'; memcpy(sub + pl + 1, name, nl + 1);
                q_push(sub, -1, -1, 0);
                continue;
            }
            if (objtype != VREG) continue;

            o->files++;
            uint64_t seen = __atomic_add_fetch(&g_big_progress, 1, __ATOMIC_RELAXED);
            if (seen % BIG_PROGRESS_EVERY == 0) {
                char *desc = json_escape(dirpath);
                fprintf(stderr, "{\"progress\":true,\"files\":%llu,\"dir\":\"%s\"}\n",
                        (unsigned long long)seen, desc);
                free(desc);
            }
            if ((uint64_t)dlen < g_big_min) continue;

            size_t pl = strlen(dirpath), nl = strlen(name);
            char *full = malloc(pl + 1 + nl + 1);
            if (!full) { perror("malloc bigpath"); exit(1); }
            memcpy(full, dirpath, pl); full[pl] = '/'; memcpy(full + pl + 1, name, nl + 1);
            uint64_t mtime_ns = (uint64_t)mtime * 1000000000ULL + (uint64_t)mnsec;
            big_push(o, full, (uint64_t)dlen, (uint64_t)alloc, fileid, mtime_ns, nlink);
        }
    }
    close(dfd);
}

static void *big_worker(void *arg) {
    BigOut *o = arg;
    for (;;) {
        pthread_mutex_lock(&g_qmtx);
        while (g_qn == 0 && !g_done) pthread_cond_wait(&g_qcv, &g_qmtx);
        if (g_qn == 0 && g_done) { pthread_mutex_unlock(&g_qmtx); break; }
        DirJob job = g_q[--g_qn];
        pthread_mutex_unlock(&g_qmtx);

        big_process_dir(o, job.path);
        free(job.path);

        pthread_mutex_lock(&g_qmtx);
        if (--g_pending == 0) { g_done = 1; pthread_cond_broadcast(&g_qcv); }
        pthread_mutex_unlock(&g_qmtx);
    }
    return NULL;
}

static int cmp_bigrec_path(const void *a, const void *b) {
    return strcmp(((const BigRec *)a)->path, ((const BigRec *)b)->path);
}

__attribute__((visibility("default")))
char *clonesize_bigfiles_json(const char *const *roots, int nroots, int threads,
                              unsigned long long min_bytes,
                              const char *const *prune_names, int nprune) {
    g_nthreads = threads;
    g_big_min = min_bytes;
    g_nprune = 0;
    for (int i = 0; i < nprune && i < MAX_PRUNE_NAMES; i++) g_prune_names[g_nprune++] = prune_names[i];
    g_profile = getenv("PROFILE") ? 1 : 0;
    int nthreads = resolve_threads();

    reset_state();
    big_setup_attrlist();
    g_big_progress = 0;
    double t0 = now_s();
    g_big_outs = calloc(nthreads, sizeof(BigOut));
    pthread_t *th = calloc(nthreads, sizeof(pthread_t));
    if (!g_big_outs || !th) { perror("calloc bigwalk"); exit(1); }
    for (int i = 0; i < nroots; i++) q_push(strdup(roots[i]), -1, -1, 0);
    if (nroots == 0) g_done = 1;
    for (int i = 0; i < nthreads; i++) pthread_create(&th[i], NULL, big_worker, &g_big_outs[i]);
    for (int i = 0; i < nthreads; i++) pthread_join(th[i], NULL);
    free(th);

    size_t total = 0;
    uint64_t files = 0, dirs = 0;
    for (int i = 0; i < nthreads; i++) { total += g_big_outs[i].n; files += g_big_outs[i].files; dirs += g_big_outs[i].dirs; }
    BigRec *all = malloc((total ? total : 1) * sizeof(BigRec));
    if (!all) { perror("malloc bigall"); exit(1); }
    size_t k = 0;
    for (int i = 0; i < nthreads; i++) {
        for (size_t j = 0; j < g_big_outs[i].n; j++) all[k++] = g_big_outs[i].recs[j];
        free(g_big_outs[i].recs);
    }
    free(g_big_outs); g_big_outs = NULL;
    // Worker interleaving is nondeterministic; a sorted list keeps the output
    // stable for callers that diff or cache it.
    qsort(all, total, sizeof(BigRec), cmp_bigrec_path);
    double walk_s = now_s() - t0;
    if (g_profile) fprintf(stderr, "[bigfiles] walk %.2fs files=%llu dirs=%llu big=%zu threads=%d\n",
                           walk_s, (unsigned long long)files, (unsigned long long)dirs, total, nthreads);

    size_t cap = 4096 + total * 256;
    char *out = malloc(cap);
    if (!out) { perror("malloc bigjson"); exit(1); }
    size_t len = 0;
    #define BEMIT(...) do { \
        int need = snprintf(out + len, cap - len, __VA_ARGS__); \
        if (need < 0) return out; \
        if ((size_t)need >= cap - len) { cap = (cap + need) * 2; out = realloc(out, cap); \
            if (!out) { perror("realloc bigjson"); exit(1); } \
            need = snprintf(out + len, cap - len, __VA_ARGS__); } \
        len += need; \
    } while (0)
    BEMIT("{\"files_listed\":%llu,\"dirs\":%llu,\"min_bytes\":%llu,\"threads\":%d,\"walk_ms\":%llu,",
          (unsigned long long)files, (unsigned long long)dirs, (unsigned long long)min_bytes, nthreads,
          (unsigned long long)(walk_s * 1000.0));
    BEMIT("\"denied_dirs\":%llu,\"files\":[", (unsigned long long)g_denied_dirs);
    for (size_t i = 0; i < total; i++) {
        char *pesc = json_escape(all[i].path);
        // mtime_ns is emitted as a string: it is past 2^53 and a JSON number would lose precision.
        BEMIT("%s{\"path\":\"%s\",\"size\":%llu,\"alloc\":%llu,\"fileid\":%llu,\"mtime_ns\":\"%llu\",\"nlink\":%u}",
              i ? "," : "", pesc, (unsigned long long)all[i].dlen, (unsigned long long)all[i].alloc,
              (unsigned long long)all[i].fileid, (unsigned long long)all[i].mtime_ns, all[i].nlink);
        free(pesc);
        free(all[i].path);
    }
    BEMIT("]}\n");
    #undef BEMIT
    free(all);
    return out;
}

static void usage(const char *me) {
    fprintf(stderr,
        "usage: %s [options] <dir>\n"
        "  --format json        machine-readable JSON output\n"
        "  --threads N          worker threads (default: ncpu)\n"
        "  --freeable           also report Σ per-file ATTR_CMNEXT_PRIVATESIZE\n"
        "  --min-bytes N        skip files whose allocated size < N bytes\n"
        "  --changed-since EPOCH  only account files with mtime >= EPOCH seconds\n"
        "  --exclude PATH       prune this directory subtree (repeatable)\n"
        "  --partners-of PATH   list files sharing blocks with PATH (dir = scan root)\n"
        "  --top N              partner rows to print (default 30)\n"
        "  --volume             print the volume's authoritative used/free bytes\n"
        "  --bigfiles           list every regular file >= --min-bytes under ALL given dirs (JSON)\n"
        "  --prune-name NAME    with --bigfiles: never enter a directory with this name (repeatable)\n"
        "  --cache-dir DIR      extent-cache directory (omit to disable the cache)\n"
        "  --no-cache           ignore the cache when reading (still writes it)\n"
        "  --include-cloud      walk ~/Library/CloudStorage and iCloud Drive (slow; may download)\n"
        "  --quiet              omit the per-group table\n"
        "  (env PROFILE=1       print phase timings to stderr)\n", me);
}

int main(int argc, char **argv) {
    const char *target = NULL, *partners_of = NULL;
    int json = 0, quiet = 0, volume = 0, topn = 30, bigfiles = 0;
    const char *roots[4096];
    int nroots = 0;
    const char *prune[MAX_PRUNE_NAMES];
    int nprune = 0;
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        if      (!strcmp(a, "--format") && i + 1 < argc) json = !strcmp(argv[++i], "json");
        else if (!strcmp(a, "--json"))                   json = 1;
        else if (!strcmp(a, "--threads") && i + 1 < argc) g_nthreads = atoi(argv[++i]);
        else if (!strcmp(a, "--freeable"))               g_freeable = 1;
        else if (!strcmp(a, "--depth") && i + 1 < argc)  g_maxdepth = atoi(argv[++i]);
        else if (!strcmp(a, "--freeable-tree"))          { g_freeable_tree = 1; if (g_maxdepth < 0) g_maxdepth = 1; }
        else if (!strcmp(a, "--min-bytes") && i + 1 < argc) g_min_blocks = strtoull(argv[++i], NULL, 10);
        else if (!strcmp(a, "--changed-since") && i + 1 < argc) g_mtime_min = strtoull(argv[++i], NULL, 10);
        else if (!strcmp(a, "--exclude") && i + 1 < argc) { if (g_nexcludes < MAX_EXCLUDES) g_excludes[g_nexcludes++] = argv[++i]; else i++; }
        else if (!strcmp(a, "--partners-of") && i + 1 < argc) partners_of = argv[++i];
        else if (!strcmp(a, "--top") && i + 1 < argc)    topn = atoi(argv[++i]);
        else if (!strcmp(a, "--volume"))                 volume = 1;
        else if (!strcmp(a, "--bigfiles"))               bigfiles = 1;
        else if (!strcmp(a, "--prune-name") && i + 1 < argc) { if (nprune < MAX_PRUNE_NAMES) prune[nprune++] = argv[++i]; else i++; }
        else if (!strcmp(a, "--cache-dir") && i + 1 < argc) g_cache_dir = argv[++i];
        else if (!strcmp(a, "--no-cache"))               g_cache_read = 0;
        else if (!strcmp(a, "--include-cloud"))          g_skip_cloud = 0;
        else if (!strcmp(a, "--quiet"))                  quiet = 1;
        else if (!strcmp(a, "-h") || !strcmp(a, "--help")) { usage(argv[0]); return 0; }
        else if (a[0] == '-') { fprintf(stderr, "unknown option: %s\n", a); usage(argv[0]); return 2; }
        else { target = a; if (nroots < 4096) roots[nroots++] = a; }
    }
    if (!target) { usage(argv[0]); return 2; }

    if (bigfiles) {
        char *b = clonesize_bigfiles_json(roots, nroots, g_nthreads, (unsigned long long)g_min_blocks, prune, nprune);
        if (!b) return 1;
        fputs(b, stdout);
        free(b);
        return 0;
    }
    g_profile = getenv("PROFILE") ? 1 : 0;

    if (volume) {
        char *v = clonesize_volume_json(target);
        if (!v) { perror("getattrlist (volume)"); return 1; }
        fputs(v, stdout);
        free(v);
        return 0;
    }

    if (partners_of) {
        char *p = clonesize_partners_json(partners_of, target, g_nthreads, topn);
        if (!p) return 1;
        fputs(p, stdout);
        free(p);
        return 0;
    }

    Result R;
    if (run_scan(target, &R) != 0) return 1;

    if (json) {
        char *j = format_json(target, &R);
        fputs(j, stdout);
        free(j);
    } else {
        print_human(target, &R, quiet);
    }
    return 0;
}
