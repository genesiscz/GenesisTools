/**
 * fable-replace — verified, transactional batch editing utilities.
 *
 * This file is the BARREL. One import line still gets you everything:
 *
 *   import { run, renameSymbolAcross } from "${CLAUDE_PLUGIN_ROOT}/skills/fable-replace/scripts/replace-utils";
 *
 * The implementation is split by concern, so you can read the 200 lines that
 * matter instead of all 1400. What is where:
 *
 *   types.ts               every op / edit / result shape. The vocabulary.
 *   edit-one-file.ts       ops that transform ONE file's text: literal, regex,
 *                          deleteBlock/replaceBlock, insert, fuzzy, applyOps.
 *   comments.ts            comment and line sweeps: scanComments, dropComments
 *                          (comment goes, code on the line stays), deleteLines
 *                          (whole line goes).
 *   rename-symbols.ts      cross-file identifier renames: renameSymbolAcross,
 *                          renameSymbol, sameOpsAcross.
 *   sweep-many-files.ts    the runner: run(), pre-flight guards, transaction,
 *                          verifyCommand, dry-run diff.
 *   backup-and-rollback.ts backupDir snapshots, drift-aware rollback().
 *   recon.ts               grepPreview — look before you declare an op.
 *   internal.ts            private helpers. Nothing to see.
 *
 * Design contract (the reason this exists instead of sed):
 *  - Every operation is VERIFIED: a literal op with the default `count: 1` requires
 *    the needle EXACTLY once; regex ops can pin an expected match count; block ops
 *    require both anchors. Anything that does not hold is a MISS, never a silent
 *    no-op.
 *  - The batch is TRANSACTIONAL: everything is applied in memory and checked first
 *    (including that every edited script still parses). A single required MISS
 *    aborts the whole run and writes nothing.
 *  - `dryRun` prints diffs and writes nothing.
 *  - `backupDir` snapshots originals + a manifest before writing; `rollback(dir)`
 *    restores byte-for-byte and refuses to clobber anything edited since.
 *
 * Runtime: bun (TypeScript directly). No dependencies outside node builtins.
 */

export {
    backupDirInUse,
    pruneScratch,
    recordPostWriteHashes,
    rollback,
    scratchDir,
    scratchRoot,
    writeBackup,
} from "./backup-and-rollback";
export { applyDeleteLines, applyDropComments, deleteLines, dropComments, removeSpans, scanComments } from "./comments";
export { all, applyOps, drop, dropJsdocStarting, fuzzyWhitespaceRegex, maybe, nearestHint } from "./edit-one-file";
export { changedOnDisk, countOccurrences, FableReplaceError, nthIndexOf } from "./internal";
export type { LeftoverReport } from "./recon";
export { countMatches, findFiles, grepPreview, leftovers, shadowedFiles } from "./recon";
export { renameSymbol, renameSymbolAcross, sameOpsAcross } from "./rename-symbols";
export type { ParseSpecParams } from "./spec";
export { parseSpec } from "./spec";
export { looksGenerated, mergeFileEdits, run, simpleDiff } from "./sweep-many-files";
export * from "./types";
export { checkVerifyCommand, runVerifyCommand, trimOutput, verifyUnknownReason } from "./verify-command";
