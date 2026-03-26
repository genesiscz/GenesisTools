# SocratiCode Indexing Stats

## ReservineBack — 2026-03-25

| Metric | Value |
|--------|-------|
| **Project** | `Projects/ReservineBack` |
| **Collection** | `codebase_2a95f22a6c59` |
| **Files indexed** | 2,459 |
| **Chunks** | 6,293 |
| **Extra extensions** | `.blade.php` |
| **Total indexing time** | ~242.5s (~4 min) |
| **Embedding batches** | 50 |
| **Code graph nodes** | 2,294 files |
| **Code graph edges** | 7,102 |
| **File watcher** | Active (auto-updating) |

### Infrastructure

| Component | Status |
|-----------|--------|
| Qdrant mode | `managed` (Docker) |
| Qdrant container | Running |
| Embedding provider | `ollama` (external, native) |
| Embedding model | `nomic-embed-text` |
| Ollama endpoint | `http://localhost:11434` |

### Progress Timeline

| Elapsed | Phase | Progress |
|---------|-------|----------|
| 9s | Embedding batch 2/50 | 236/6,293 (4%) |
| 14s | Embedding batch 2/50 | 364/6,293 (6%) |
| 88s | Embedding batch 7/50 | 1,513/6,293 (24%) |
| 164s | Embedding batch 25/50 | 3,625/6,293 (58%) |
| 242.5s | Complete | 6,293/6,293 (100%) |

### Notes

- Graph auto-built after indexing completed (2,294 files, 7,102 edges)
- File watcher auto-started after indexing
- Embedding throughput: ~26 chunks/sec average

### Code Graph Details

| Metric | Value |
|--------|-------|
| **Total files in graph** | 2,224 |
| **Total dependency edges** | 6,834 |
| **Avg dependencies/file** | 3.1 |
| **Circular dependency chains** | 245 |

#### Language Breakdown

| Language | Files |
|----------|-------|
| PHP | 2,081 |
| TypeScript | 114 |
| Shell | 12 |
| JavaScript | 10 |
| CSS | 5 |
| Python | 1 |
| HTML | 1 |

#### Most Connected Files (Top 10)

| File | Connections |
|------|------------|
| `app/Data/BaseData.php` | 227 |
| `tests/TestCase.php` | 187 |
| `tests/CommonDataTestProvider.php` | 173 |
| `app/Models/Branch.php` | 159 |
| `app/Traits/MigrationHelpers.php` | 157 |
| `app/Models/Reservation.php` | 128 |
| `app/Models/Tenant.php` | 122 |
| `app/Models/User.php` | 120 |
| `app/Services/MoneyFactory.php` | 96 |
| `app/Exceptions/FlashException.php` | 85 |

#### Orphan Files (no dependencies)

350 files with no detected dependencies — mostly console commands, casts, and standalone scripts.

## col-fe — 2026-03-25

| Metric | Value |
|--------|-------|
| **Project** | `col-fe` |
| **Collection** | `codebase_5e3760186e06` |
| **Files scanned** | 31,572 |
| **Chunks** | 73,599 |
| **Embedding batches** | 631 |
| **Total indexing time** | ~1,227.4s (~20.5 min) |
| **Embedding throughput** | ~60 chunks/sec average |
| **Code graph nodes** | 19,769 files |
| **Code graph edges** | 39,421 |
| **Avg deps per file** | 2.0 |
| **Circular dep chains** | 88 |
| **Graph build duration** | 18.1s |
| **File watcher** | Active (auto-updating) |

### Infrastructure

| Component | Status |
|-----------|--------|
| Qdrant mode | `managed` (Docker) |
| Qdrant container | `socraticode-qdrant` (qdrant/qdrant:v1.17.0) |
| Qdrant ports | 16333:6333, 16334:6334 |
| Embedding provider | `ollama` (native, localhost:11434) |
| Embedding model | `nomic-embed-text` |
| Ollama version | 0.18.2 |

### Languages in Graph

| Language | Files |
|----------|-------|
| TypeScript | 10,828 |
| C | 5,689 |
| C++ | 2,673 |
| Swift | 474 |
| JavaScript | 62 |
| Shell | 18 |
| CSS | 13 |
| HTML | 6 |
| Kotlin | 6 |

### Most Connected Files (Top 10)

| File | Connections |
|------|------------|
| `createMessageDescriptors.ts` | 877 |
| `ApiState.ts` (types/shared) | 485 |
| `Commodity.ts` | 403 |
| `useDispatch.ts` | 360 |
| `LogSubActionCode.ts` | 328 |
| `View.tsx` (rnui) | 326 |
| `PaperHeader.tsx` | 279 |
| `createErrorAction.ts` | 249 |
| `safeSaga.ts` | 248 |
| `ApiState.ts` (core/redux) | 234 |

### Notes

- Scanned 31,572 files in ~29s, then embedded 73,599 chunks in 631 batches
- Graph auto-built after indexing (19,769 nodes, 39,421 edges, 18.1s)
- File watcher auto-started after indexing
- 88 circular dependency chains detected
- C/C++/Swift files are from React Native / iOS native build artifacts (android/.cxx, ios/Pods)
- 8,537+ orphan files (no dependencies) — mostly native build artifacts

## SocratiCode vs GenesisTools Indexer — ReservineBack — 2026-03-26

### Side-by-Side Comparison

| Metric | **GenesisTools Indexer** | **SocratiCode** |
|--------|--------------------------|-----------------|
| **Files** | 3,164 | 2,459 (indexed) / 2,224 (graph) |
| **Chunks** | 59,806 | 6,224 |
| **DB Size** | 464 MB | — |
| **Embedding Dims** | 768 | 768 (nomic-embed-text) |
| **Code Graph** | — | 2,224 files, 6,834 edges |
| **File Watcher** | — | Active (auto-updating) |
| **Last Sync** | 1 day ago (10.7s) | Incremental update (6.4s) |
| **Status** | completed | green |
| **Searches** | 0 | — |

### Key Differences

- **GenesisTools has ~10x more chunks** (59,806 vs 6,224) — uses much finer-grained chunking strategy
- **GenesisTools indexes more files** (3,164 vs 2,459) — likely includes more file types or doesn't skip as many
- **SocratiCode has a code graph** with dependency edges that GenesisTools doesn't expose
- **SocratiCode has an active file watcher** for automatic incremental updates
- **DB size**: GenesisTools uses 464 MB for its index; SocratiCode size not reported
- Both are fully indexed and operational on the same codebase
