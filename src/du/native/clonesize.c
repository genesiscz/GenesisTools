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
    uint64_t private_dlen;         // Σ dlen of fully-private files (their unique contribution)
    uint64_t unique_shared;        // unique bytes from shared extents (post-pass)
    uint64_t cross;                // bytes shared with dirs OUTSIDE this subtree
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
    pthread_mutex_unlock(&g_node_mtx);
    return id;
}

// Per-file record emitted by the parallel scan in --depth mode; node accounting
// (naive/files/priv/private-unique) is done single-threaded in the post-pass.
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
static int is_excluded(const char *path) {
    for (int i = 0; i < g_nexcludes; i++)
        if (strcmp(g_excludes[i], path) == 0) return 1;
    return 0;
}

static int intern_group(const char *name) {
    pthread_mutex_lock(&g_group_mtx);
    int r = MAX_GROUPS - 1;
    for (int i = 0; i < g_ngroups; i++) {
        if (strcmp(g_group_names[i], name) == 0) { r = i; goto out; }
    }
    if (g_ngroups < MAX_GROUPS) {
        g_group_names[g_ngroups] = strdup(name);
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
typedef struct { uint64_t dev; uint64_t len; int group; int node; } Ext;

typedef struct {
    Ext     *exts;
    size_t   n, cap;
    uint64_t naive;                     // sum alloc for this thread's files
    uint64_t unique_private;            // sum alloc of fully-private (skipped) files
    uint64_t priv_sum;                  // sum of privatesize across all files
    uint64_t group_naive[MAX_GROUPS];
    uint64_t group_files[MAX_GROUPS];
    uint64_t group_private[MAX_GROUPS];
    uint64_t files_listed;              // all regular files seen
    uint64_t files_accounted;           // alloc>0 && >=min  (private + shared)
    uint64_t files_opened;              // shared files actually opened+scanned
    FileRec *recs;                      // --depth mode: per-file node records
    size_t   nrecs, rec_cap;
} ThreadOut;

static void ext_push(ThreadOut *t, uint64_t dev, uint64_t len, int group, int node) {
    if (t->n == t->cap) {
        t->cap = t->cap ? t->cap * 2 : 8192;
        t->exts = realloc(t->exts, t->cap * sizeof(Ext));
        if (!t->exts) { perror("realloc exts"); exit(1); }
    }
    t->exts[t->n].dev = dev;
    t->exts[t->n].len = len;
    t->exts[t->n].group = group;
    t->exts[t->n].node = node;
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

// ---------------------------------------------------------------------------
// Extent scan of ONE already-open shared file.
// ---------------------------------------------------------------------------
static void scan_shared_file(ThreadOut *t, int fd, off_t size, int group, int node) {
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
            ext_push(t, (uint64_t)l2p.l2p_devoffset, (uint64_t)contig, group, node);
        off += contig;
    }
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

// getattrlistbulk entry layout (4-byte packed, FSOPT_PACK_INVAL_ATTRS):
//   0  u32 length | 4 returned_attrs(20) | 24 name attrref(8) | 32 objtype(4)
//   36 linkcount u32(4) | 40 alloc off_t(8) | 48 datalength off_t(8) | 56 privatesize off_t(8)
static struct attrlist g_al;
static uint64_t g_alopt;

static void process_dir(ThreadOut *t, const char *dirpath, int dirgroup, int dirnode, int depth) {
    int dfd = open(dirpath, O_RDONLY | O_DIRECTORY | O_NONBLOCK);
    if (dfd < 0) return;
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
                if (g_nexcludes && is_excluded(sub)) { free(sub); continue; }
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
            t->priv_sum += (uint64_t)priv;
            if (alloc == 0 || (size_t)alloc < g_min_blocks) continue;

            uint64_t a = (uint64_t)alloc;
            t->naive += a;
            t->group_naive[g] += a;
            t->group_files[g] += 1;
            t->group_private[g] += (uint64_t)priv;
            t->files_accounted++;

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
                if (g_maxdepth >= 0) rec_push(t, dirnode, a, (uint64_t)dlen, (uint64_t)priv, 1);
                continue;
            }
            // Shares some blocks — open by leaf (dfd is the parent) and extent-scan.
            int ffd = openat(dfd, name, O_RDONLY | O_NONBLOCK);
            if (ffd < 0) continue;
            t->files_opened++;
            scan_shared_file(t, ffd, dlen, g, g_maxdepth >= 0 ? dirnode : -1);
            if (g_maxdepth >= 0) rec_push(t, dirnode, a, (uint64_t)dlen, (uint64_t)priv, 0);
            close(ffd);
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
// Computed result
// ---------------------------------------------------------------------------
typedef struct {
    uint64_t naive, unique, shared, cross_shared, priv_sum;
    uint64_t files_listed, files_accounted, files_opened, extents;
    int      threads;
    double   pct;
    uint64_t group_shared[MAX_GROUPS];
} Result;

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

// Runs the full scan; fills *R. Returns 0 on success.
static int run_scan(const char *target, Result *R) {
    memset(R, 0, sizeof *R);

    // Set up the shared attrlist for every getattrlistbulk call.
    memset(&g_al, 0, sizeof g_al);
    g_al.bitmapcount = ATTR_BIT_MAP_COUNT;
    g_al.commonattr  = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE;
    g_al.fileattr    = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE | ATTR_FILE_DATALENGTH;
    g_al.forkattr    = ATTR_CMNEXT_PRIVATESIZE;
    g_alopt = FSOPT_PACK_INVAL_ATTRS | FSOPT_ATTR_CMN_EXTENDED | FSOPT_NOFOLLOW;

    int nthreads = g_nthreads;
    if (nthreads <= 0) {
        long nc = sysconf(_SC_NPROCESSORS_ONLN);
        nthreads = (nc > 0) ? (int)nc : 4;
    }

    double t0 = now_s();

    // Fused parallel walk + shared-file extent scan.
    g_outs = calloc(nthreads, sizeof(ThreadOut));
    pthread_t *th = calloc(nthreads, sizeof(pthread_t));
    // --depth: root is node 0 (depth 0). Files loose in the root belong to it.
    int rootnode = (g_maxdepth >= 0) ? intern_node(-1, target, 0) : -1;
    q_push(strdup(target), -1, rootnode, 0);
    for (int i = 0; i < nthreads; i++) pthread_create(&th[i], NULL, worker, &g_outs[i]);
    for (int i = 0; i < nthreads; i++) pthread_join(th[i], NULL);

    double t1 = now_s();

    // Merge thread outputs.
    size_t total_exts = 0;
    uint64_t naive = 0, unique_private = 0, priv_sum = 0;
    uint64_t files_listed = 0, files_accounted = 0, files_opened = 0;
    for (int i = 0; i < nthreads; i++) {
        total_exts      += g_outs[i].n;
        naive           += g_outs[i].naive;
        unique_private  += g_outs[i].unique_private;
        priv_sum        += g_outs[i].priv_sum;
        files_listed    += g_outs[i].files_listed;
        files_accounted += g_outs[i].files_accounted;
        files_opened    += g_outs[i].files_opened;
        for (int g = 0; g < g_ngroups; g++) {
            g_group_naive[g]   += g_outs[i].group_naive[g];
            g_group_files[g]   += g_outs[i].group_files[g];
            g_group_private[g] += g_outs[i].group_private[g];
        }
        // --depth: accumulate per-leaf-node naive/files/priv/private-unique.
        for (size_t r = 0; r < g_outs[i].nrecs; r++) {
            FileRec *fr = &g_outs[i].recs[r];
            Node *nd = &g_nodes[fr->node];
            nd->naive += fr->alloc;
            nd->files += 1;
            nd->priv  += fr->priv;
            if (fr->is_private) nd->private_dlen += fr->dlen;
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
    free(th);

    double t2 = now_s();

    // Sort by device offset, merge overlapping clusters. For each merged cluster,
    // collect its DISTINCT groups by scanning the cluster's own extents. This
    // replaces the old uint64 group bitmask (which capped groups at 64 and made a
    // scan root with >64 immediate children fold everything past the 63rd into one
    // bogus overflow bucket) — there is no 64-group limit here.
    qsort(all, total_exts, sizeof(Ext), cmp_ext);
    for (int i = 0; i < MAX_GROUPS; i++) g_uf[i] = i;

    uint64_t unique_shared = 0, cross_shared = 0;
    uint64_t group_shared[MAX_GROUPS]; memset(group_shared, 0, sizeof group_shared);

    // Per-cluster distinct-group dedup via epoch marks (O(cluster size), no reset).
    int gcap = g_ngroups > 0 ? g_ngroups : 1;
    int *seen_epoch = malloc((size_t)gcap * sizeof(int));
    int *dg = malloc((size_t)gcap * sizeof(int));
    if (!seen_epoch || !dg) { perror("malloc groups"); return 1; }
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

    size_t i = 0;
    int epoch = 0;
    while (i < total_exts) {
        uint64_t cs = all[i].dev, ce = all[i].dev + all[i].len;
        size_t j = i + 1;
        while (j < total_exts && all[j].dev <= ce) {
            uint64_t en = all[j].dev + all[j].len;
            if (en > ce) ce = en;
            j++;
        }
        uint64_t clen = ce - cs;
        unique_shared += clen;

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
            cross_shared += clen;
            int first = dg[0];
            for (int m = 0; m < ndg; m++) {
                group_shared[dg[m]] += clen;
                if (m > 0) uf_union(first, dg[m]);
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
                g_nodes[a].unique_shared += clen;
                if (cov_count[a] < nleaf) g_nodes[a].cross += clen;
            }
        }
        epoch++;
        i = j;
    }
    free(seen_epoch);
    free(dg);
    if (g_maxdepth >= 0) { free(leaf_seen); free(cov_epoch); free(cov_count); free(leaves); free(touched); }
    free(all);

    // --depth: roll naive/files/priv/private-unique up to ancestors (child id > parent
    // id, since a parent interns its children — so descending id = children first).
    if (g_maxdepth >= 0) {
        for (int a = g_nnodes - 1; a > 0; a--) {
            int par = g_nodes[a].parent;
            if (par < 0) continue;
            g_nodes[par].naive        += g_nodes[a].naive;
            g_nodes[par].files        += g_nodes[a].files;
            g_nodes[par].priv         += g_nodes[a].priv;
            g_nodes[par].private_dlen += g_nodes[a].private_dlen;
        }
    }

    double t3 = now_s();

    uint64_t unique = unique_private + unique_shared;
    uint64_t shared = (naive > unique) ? naive - unique : 0;

    R->naive = naive;
    R->unique = unique;
    R->shared = shared;
    R->cross_shared = cross_shared;
    R->priv_sum = priv_sum;
    R->files_listed = files_listed;
    R->files_accounted = files_accounted;
    R->files_opened = files_opened;
    R->extents = total_exts;
    R->threads = nthreads;
    R->pct = naive ? 100.0 * (double)shared / (double)naive : 0.0;
    memcpy(R->group_shared, group_shared, sizeof group_shared);

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
static char *format_json(const char *target, const Result *R) {
    size_t cap = 4096 + (size_t)g_ngroups * 256 + (size_t)g_nnodes * 320;
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
    EMIT("  \"path\": \"%s\",\n", target);
    EMIT("  \"files_scanned\": %llu,\n", (unsigned long long)R->files_accounted);
    EMIT("  \"files_listed\": %llu,\n", (unsigned long long)R->files_listed);
    EMIT("  \"files_opened\": %llu,\n", (unsigned long long)R->files_opened);
    EMIT("  \"extents\": %llu,\n", (unsigned long long)R->extents);
    EMIT("  \"threads\": %d,\n", R->threads);
    EMIT("  \"naive_bytes\": %llu,\n", (unsigned long long)R->naive);
    EMIT("  \"unique_bytes\": %llu,\n", (unsigned long long)R->unique);
    EMIT("  \"shared_bytes\": %llu,\n", (unsigned long long)R->shared);
    EMIT("  \"shared_pct\": %.2f,\n", R->pct);
    EMIT("  \"cross_group_shared_bytes\": %llu,\n", (unsigned long long)R->cross_shared);
    if (g_freeable)
        EMIT("  \"private_sum_bytes\": %llu,\n", (unsigned long long)R->priv_sum);
    EMIT("  \"groups\": [\n");
    int emitted = 0;
    for (int g = 0; g < g_ngroups; g++) {
        uint64_t gn = g_group_naive[g];
        if (gn == 0) continue;
        int more = 0;
        for (int h = g + 1; h < g_ngroups; h++) if (g_group_naive[h]) { more = 1; break; }
        double gsh = 100.0 * (double)R->group_shared[g] / (double)gn;
        int flagged = (R->group_shared[g] >= (uint64_t)(g_clone_pct * (double)gn)) && R->group_shared[g] > 0;
        EMIT("    {\"name\": \"%s\", \"naive_bytes\": %llu, \"files\": %llu, "
             "\"cross_group_shared_bytes\": %llu, \"shared_pct\": %.2f, "
             "\"clone_cluster\": %d, \"clone_flagged\": %s",
             g_group_names[g], (unsigned long long)gn,
             (unsigned long long)g_group_files[g],
             (unsigned long long)R->group_shared[g], gsh,
             uf_find(g), flagged ? "true" : "false");
        if (g_freeable)
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
            double xpct = nd->naive ? 100.0 * (double)nd->cross / (double)nd->naive : 0.0;
            int flagged = (nd->cross >= (uint64_t)(g_clone_pct * (double)nd->naive)) && nd->cross > 0;
            node_path(a, pbuf, sizeof pbuf);
            EMIT("%s    {\"path\": \"%s\", \"depth\": %d, \"parent\": %d, \"naive_bytes\": %llu, "
                 "\"unique_bytes\": %llu, \"cross_shared_bytes\": %llu, \"shared_pct\": %.2f, "
                 "\"files\": %llu, \"clone_flagged\": %s",
                 nfirst ? "" : ",\n", pbuf, nd->depth, nd->parent, (unsigned long long)nd->naive,
                 (unsigned long long)u, (unsigned long long)nd->cross, xpct,
                 (unsigned long long)nd->files, flagged ? "true" : "false");
            if (g_freeable_tree)
                EMIT(", \"private_bytes\": %llu", (unsigned long long)nd->priv);
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
    printf("Files scanned:   %llu (of %llu listed, %llu opened)  •  %d threads\n",
           (unsigned long long)R->files_accounted, (unsigned long long)R->files_listed,
           (unsigned long long)R->files_opened, R->threads);
    printf("Naive (du-like): %8.1f %s   %llu bytes\n", HUM(R->naive), (unsigned long long)R->naive);
    printf("Unique physical: %8.1f %s   %llu bytes\n", HUM(R->unique), (unsigned long long)R->unique);
    printf("Shared (CoW):    %8.1f %s   (%.1f%% of naive collapses to shared blocks)\n",
           HUM(R->shared), R->pct);
    printf("Cross-worktree:  %8.1f %s   (shared across marked dirs)\n", HUM(R->cross_shared));
    if (g_freeable)
        printf("Private (excl):  %8.1f %s   (Sum per-file bytes shared with nothing volume-wide)\n",
               HUM(R->priv_sum));

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
    #undef HUM
}

// ---------------------------------------------------------------------------
// bun:ffi entry point — one-shot scan, returns a malloc'd JSON string.
// Caller must clonesize_free() it. Not reentrant (uses process globals).
// ---------------------------------------------------------------------------
__attribute__((visibility("default")))
char *clonesize_run_json(const char *path, int threads, int freeable,
                         unsigned long long min_bytes,
                         const char *const *excludes, int nexcludes,
                         int depth, int freeable_tree) {
    g_nthreads = threads;
    g_freeable = freeable;
    g_min_blocks = (size_t)min_bytes;
    g_maxdepth = depth;                 // < 0 disables the tree
    g_freeable_tree = freeable_tree;
    if (g_freeable_tree && g_maxdepth < 0) g_maxdepth = 1;
    g_profile = getenv("PROFILE") ? 1 : 0;
    g_nexcludes = 0;
    for (int i = 0; i < nexcludes && i < MAX_EXCLUDES; i++) g_excludes[g_nexcludes++] = excludes[i];

    // Reset accumulating globals — the dylib lives across calls under bun:ffi.
    for (int i = 0; i < g_ngroups; i++) { free(g_group_names[i]); g_group_names[i] = NULL; }
    g_ngroups = 0;
    memset(g_group_naive, 0, sizeof g_group_naive);
    memset(g_group_files, 0, sizeof g_group_files);
    memset(g_group_private, 0, sizeof g_group_private);
    for (int i = 0; i < g_nnodes; i++) free(g_nodes[i].name);
    free(g_nodes); g_nodes = NULL; g_nnodes = 0; g_node_cap = 0;
    g_qn = 0; g_pending = 0; g_done = 0;
    Result R;
    if (run_scan(path, &R) != 0) return NULL;
    return format_json(path, &R);
}

__attribute__((visibility("default")))
void clonesize_free(char *p) { free(p); }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
static void usage(const char *me) {
    fprintf(stderr,
        "usage: %s [options] <dir>\n"
        "  --format json     machine-readable JSON output\n"
        "  --threads N       worker threads (default: ncpu)\n"
        "  --freeable        also report Σ per-file ATTR_CMNEXT_PRIVATESIZE\n"
        "  --min-bytes N     skip files whose allocated size < N bytes\n"
        "  --exclude PATH    prune this directory subtree (repeatable)\n"
        "  --quiet           omit the per-group table\n"
        "  (env PROFILE=1    print phase timings to stderr)\n", me);
}

int main(int argc, char **argv) {
    const char *target = NULL;
    int json = 0, quiet = 0;
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        if      (!strcmp(a, "--format") && i + 1 < argc) json = !strcmp(argv[++i], "json");
        else if (!strcmp(a, "--json"))                   json = 1;
        else if (!strcmp(a, "--threads") && i + 1 < argc) g_nthreads = atoi(argv[++i]);
        else if (!strcmp(a, "--freeable"))               g_freeable = 1;
        else if (!strcmp(a, "--depth") && i + 1 < argc)  g_maxdepth = atoi(argv[++i]);
        else if (!strcmp(a, "--freeable-tree"))          { g_freeable_tree = 1; if (g_maxdepth < 0) g_maxdepth = 1; }
        else if (!strcmp(a, "--min-bytes") && i + 1 < argc) g_min_blocks = strtoull(argv[++i], NULL, 10);
        else if (!strcmp(a, "--exclude") && i + 1 < argc) { if (g_nexcludes < MAX_EXCLUDES) g_excludes[g_nexcludes++] = argv[++i]; else i++; }
        else if (!strcmp(a, "--quiet"))                  quiet = 1;
        else if (!strcmp(a, "-h") || !strcmp(a, "--help")) { usage(argv[0]); return 0; }
        else if (a[0] == '-') { fprintf(stderr, "unknown option: %s\n", a); usage(argv[0]); return 2; }
        else target = a;
    }
    if (!target) { usage(argv[0]); return 2; }
    g_profile = getenv("PROFILE") ? 1 : 0;

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
