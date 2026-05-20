# Clones perf microbenches

Standalone Bun scripts used to validate or rule out specific perf hypotheses
for `tools macos clones duplicates|optimize`. Each one is meant to be run by
hand from the repo root with `bun scripts/benchmarks/clones/microbenches/<file>.ts`.

| Script | What it measures | Used in audit decision |
|---|---|---|
| `apfs-bench-sha-buffer.ts` | sha256 throughput vs `STREAM_CHUNK_BYTES` (64K / 128K / 256K / 512K / 1M / 2M / 4M) | P4 (rejected — 128K wins by 3.5%, anything bigger is slower) |
| `apfs-bench-cloneid.ts` | `getCloneId` throughput (calls/sec) cold & warm | P1 (HIGH — 2.7µs/call ⇒ 380ms warm; cache it) |
| `apfs-bench-bytecompare.ts` | `bytesEqualStreaming` warm-cache throughput | P2 (HIGH — pair cost is small but adds up at 33k pairs) |
| `apfs-bench-bytecompare-cold.ts` | `bytesEqualStreaming` cold vs warm page cache | P2 (HIGH — cold = 5.5s scaled to 33k pairs, dominates warm scan) |
| `apfs-bench-real-bytecompare.ts` | byte-compare against real same-size production groups | P2 (validates the synthetic bench above) |
| `apfs-bench-walk-split.ts` | readdir-only vs readdir+stat cost split | P3 (readdir is 35-55%, stat is 45-65% → dir-mtime cache only saves readdir) |
| `apfs-bench-yield.ts` | cost of `setImmediate` yields in the bucket loop | confirms scheduler isn't the bottleneck |
| `apfs-bench-scan-microsplit.ts` | end-to-end phase breakdown for one scan | sanity check |

Plus `apfs-dirmtime-test/` (not in repo — recreate locally if needed): empirical
verification that APFS dir mtime bumps on add/rename/remove of immediate
children but NOT on content edits or grand-child changes. Validates the
correctness foundation for the per-dir-meta cache plan.

## How to recreate the dir-mtime test

```bash
mkdir -p /tmp/apfs-dirmtime-test
cd /tmp/apfs-dirmtime-test
stat -f '%m initial' .
touch a-file && stat -f '%m add'  .
echo content >> a-file && stat -f '%m content-edit' .
mv a-file a-file2 && stat -f '%m rename' .
rm a-file2 && stat -f '%m remove' .
mkdir sub && touch sub/x && stat -f '%m subchild' .
```

Verified 2026-05-21 on APFS Data volume: mtime updates on add/rename/remove,
holds on content-edit and grand-child changes. (POSIX 1003.1-2001 §4.7 +
Chris Jenkins on eclecticlight.co confirming APFS POSIX compliance.)
