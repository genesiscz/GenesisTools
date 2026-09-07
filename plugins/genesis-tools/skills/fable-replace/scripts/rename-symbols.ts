/**
 * fable-replace — RENAMING AN IDENTIFIER ACROSS MANY FILES.
 *
 *   renameSymbolAcross({ files, oldName: "oldName", newName: "newName" })
 *
 * The rename is word-boundary anchored, so `oldName` never matches inside
 * `_oldName` or `oldNameSuffix`. Every listed file MUST contain the symbol: a file
 * that does not is a MISS. When you are renaming several symbols that live in
 * OVERLAPPING but different file sets, bucket the files per symbol rather than
 * passing one list for all of them.
 *
 * A rename is not finished when the code is green. Sweep the markdown that names
 * the symbol too (README, CLAUDE.md, docs), or you leave the docs lying.
 */

import { FableReplaceError, identifierPattern } from "./internal";
import { shadowedFiles } from "./recon";
import type { FileEdit, RegexOp, RenameSymbolAcrossParams, RenameSymbolParams, SameOpsAcrossParams } from "./types";

/** Same set of ops applied to many files (e.g. rename a symbol across call sites). */
export const sameOpsAcross = ({ files, ops, extra = {} }: SameOpsAcrossParams): FileEdit[] =>
    files.map((file) => ({ file, ops, ...extra }));

export const renameSymbol = ({ oldName, newName, expect }: RenameSymbolParams): RegexOp => ({
    kind: "regex",
    find: new RegExp(identifierPattern(oldName), "g"),
    // A function, so a `$` in the new name is literal: as a replacement STRING, "$$foo"
    // would have been written as "$foo".
    replace: () => newName,
    expect,
    label: `rename ${oldName} → ${newName}`,
});

/**
 * Word-boundary rename of an identifier in one file's ops form. Use with
 * sameOpsAcross() for a cross-file rename:
 *   sameOpsAcross({ files, ops: [renameSymbol({ oldName: "getLinkGate", newName: "getActionDisabledState" })] })
 */
/**
 * The commonest sweep of all, in one call:
 *   renameSymbolAcross({ files, oldName: "oldName", newName: "newName" })
 * Equivalent to sameOpsAcross({ files, ops: [renameSymbol({ oldName, newName })] }). Every listed file
 * MUST contain the symbol — a file that does not is a MISS, so bucket your file
 * list by which symbol it actually holds rather than passing one list for several
 * renames.
 */
export const renameSymbolAcross = ({
    files,
    oldName,
    newName,
    extra = {},
    includeShadowed = false,
}: RenameSymbolAcrossParams): FileEdit[] => {
    // countMatches only WARNS about local wrappers; a caller piping its map straight in
    // renamed one anyway. Refusing here makes the warning binding.
    if (!includeShadowed) {
        const candidates = Array.isArray(files) ? files : Object.keys(files);
        const { shadows } = shadowedFiles({ files: candidates, name: oldName });
        if (shadows.length > 0) {
            throw new FableReplaceError(
                `renameSymbolAcross: ${shadows.length} file(s) both import AND declare "${oldName}" (a local wrapper; renaming its declaration changes an unrelated helper):\n  ${shadows.join("\n  ")}\nDrop them from the file list, or pass includeShadowed: true on purpose.`,
                2
            );
        }
    }
    // Accept the countMatches() map directly: zero-match files are dropped (they would
    // MISS) and each file's expected count is pinned from the number you already
    // measured, instead of being transcribed by hand.
    if (Array.isArray(files)) {
        return sameOpsAcross({ files, ops: [renameSymbol({ oldName, newName })], extra });
    }
    return Object.entries(files)
        .filter(([, n]) => n > 0)
        .map(([file, n]) => ({ file, ops: [renameSymbol({ oldName, newName, expect: n })], ...extra }));
};
