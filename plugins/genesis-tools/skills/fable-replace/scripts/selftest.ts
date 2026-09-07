/**
 * Self-test for replace-utils.ts. Run: bun selftest.ts
 * Exercises every op kind, transactional abort, partial mode, dry-run,
 * post-conditions, backup + rollback, delete/rename/create — against scratch
 * files in a fresh temp dir. Must end with "ALL SELFTESTS PASSED".
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { collectApi } from "./api";
import { writeBackup } from "./backup-and-rollback";
import type { JournalEntry } from "./journal";
import { parseJson, stringifyJson } from "./json";
import * as barrel from "./replace-utils";
import {
    all,
    applyOps,
    changedOnDisk,
    checkVerifyCommand,
    countMatches,
    countOccurrences,
    deleteLines,
    drop,
    dropComments,
    dropJsdocStarting,
    FableReplaceError,
    findFiles,
    fuzzyWhitespaceRegex,
    grepPreview,
    leftovers,
    looksGenerated,
    maybe,
    mergeFileEdits,
    nearestHint,
    nthIndexOf,
    parseSpec,
    pruneScratch,
    renameSymbol,
    renameSymbolAcross,
    rollback,
    run,
    scanComments,
    scratchDir,
    scratchRoot,
    shadowedFiles,
    simpleDiff,
} from "./replace-utils";
import type { Op } from "./types";

let failures = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
    if (cond) {
        console.log(`  ✓ ${name}`);
    } else {
        failures += 1;
        console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    }
};

// Hermetic: every CLI this file spawns resolves its journal home and its scratch root from
// these two variables, so neither the standalone run nor `bun run test` can touch the real
// ~/.genesis-tools or the real temp folder. Set before `tmp` below, which reads os.tmpdir().
const hermeticRoot = scratchDir("selftest-home");
process.env.GENESIS_TOOLS_HOME = hermeticRoot;
process.env.TMPDIR = hermeticRoot;
// Bun does not forward process.env mutations to spawned children (measured: a child of a
// process that set X after startup sees X empty), so every CLI this file spawns gets the
// hermetic env explicitly. Three standalone runs once wrote 48 lines into the real journal.
const hermeticEnv = { ...process.env };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fable-replace-selftest-"));
const f = (name: string): string => path.join(tmp, name);
const write = (name: string, content: string): string => {
    fs.writeFileSync(f(name), content);
    return f(name);
};
const read = (name: string): string => fs.readFileSync(f(name), "utf8");

console.log(`scratch dir: ${tmp}\n`);

// ── unit: helpers ────────────────────────────────────────────────────────────
console.log("helpers");
check("countOccurrences", countOccurrences("aXbXcX", "X") === 3);
check("countOccurrences empty needle", countOccurrences("abc", "") === 0);
check("nthIndexOf 2nd", nthIndexOf({ haystack: "aXbXc", needle: "X", n: 2 }) === 3);
check("nthIndexOf missing", nthIndexOf({ haystack: "aXbXc", needle: "X", n: 3 }) === -1);
check(
    "simpleDiff shows change",
    simpleDiff({ before: "a\nb\nc", after: "a\nB\nc" }).includes("- b") &&
        simpleDiff({ before: "a\nb\nc", after: "a\nB\nc" }).includes("+ B")
);

// ── unit: applyOps ───────────────────────────────────────────────────────────
console.log("applyOps");
{
    const r = applyOps("hello world", [{ find: "world", replace: "there" }]);
    check("literal exact-once", r.content === "hello there" && r.results[0].status === "OK");
}
{
    const r = applyOps("x x x", [{ find: "x", replace: "y" }]);
    check("ambiguous literal is MISS", r.results[0].status === "MISS" && r.content === "x x x");
}
{
    const r = applyOps("x x x", [all({ find: "x", replace: "y" })]);
    check("count:all replaces every occurrence", r.content === "y y y");
}
{
    const r = applyOps("x x x", [{ find: "x", replace: "y", count: 3 }]);
    check("count:n exact", r.content === "y y y");
}
{
    const r = applyOps("x x x", [{ find: "x", replace: "y", count: 2 }]);
    check("count:n mismatch is MISS", r.results[0].status === "MISS");
}
{
    const r = applyOps("abc", [maybe({ find: "zzz", replace: "q" })]);
    check("optional non-match is SKIP", r.results[0].status === "SKIP" && r.content === "abc");
}
{
    const r = applyOps("abc", [{ find: "abc", replace: "abc" }]);
    check("no-op edit (find===replace) is MISS", r.results[0].status === "MISS");
}
{
    const r = applyOps("useFoo(1) useFoo(2)", [
        { kind: "regex", find: /useFoo\((\d)\)/g, replace: "useBar($1)", expect: 2 },
    ]);
    check("regex with expect", r.content === "useBar(1) useBar(2)");
}
{
    const r = applyOps("useFoo(1)", [{ kind: "regex", find: /useFoo\((\d)\)/g, replace: "useBar($1)", expect: 2 }]);
    check("regex expect mismatch is MISS", r.results[0].status === "MISS");
}
{
    const r = applyOps("keep\n/**\n * junk\n * junk2\n */\nrest", [dropJsdocStarting({ fromPrefix: "/**\n * junk" })]);
    check("dropJsdocStarting removes the block", r.content === "keep\nrest");
}
{
    const r = applyOps("a START mid END b", [
        { kind: "deleteBlock", from: "START", to: "END", keepFrom: true, keepTo: true },
    ]);
    check("deleteBlock keepFrom+keepTo (region between anchors goes, spaces included)", r.content === "a STARTEND b");
}
{
    const r = applyOps("x A1x A2x", [{ kind: "deleteBlock", from: "A", to: "x", occurrence: 2 }]);
    check("deleteBlock occurrence:2", r.content === "x A1x ");
}
{
    const r = applyOps("head body", [{ kind: "replaceBlock", from: "head", to: "body", replace: "ALL" }]);
    check("replaceBlock", r.content === "ALL");
}
{
    const r = applyOps("import a;\ncode", [{ kind: "insertAfter", anchor: "import a;\n", text: "import b;\n" }]);
    check("insertAfter", r.content === "import a;\nimport b;\ncode");
}
{
    const r = applyOps("one two", [{ kind: "insertBefore", anchor: "two", text: "1.5 " }]);
    check("insertBefore", r.content === "one 1.5 two");
}
{
    const r = applyOps("a b", [
        { find: "a", replace: "A" },
        { find: "A b", replace: "A B" },
    ]);
    check("ops chain (later ops see earlier output)", r.content === "A B");
}

// ── integration: run() happy path with backup, then rollback ────────────────
console.log("run(): happy path + rollback");
{
    write("one.ts", "const gate = getLinkGate(link);\ngetLinkGate(x);\n");
    write("two.ts", "// old comment\nkeep();\n");
    const backupDir = path.join(tmp, "backup1");
    const report = await run({
        edits: [
            {
                file: f("one.ts"),
                ops: [all({ find: "getLinkGate(", replace: "getActionDisabledState(" })],
                expectAfter: ["getActionDisabledState"],
                absentAfter: ["getLinkGate"],
            },
            { file: f("two.ts"), ops: [drop({ find: "// old comment\n" })] },
        ],
        backupDir,
        verbose: false,
        throwOnFailure: true,
    });
    check("run ok", report.ok && report.written.length === 2);
    check(
        "one.ts rewritten",
        read("one.ts") === "const gate = getActionDisabledState(link);\ngetActionDisabledState(x);\n"
    );
    check("two.ts comment dropped", read("two.ts") === "keep();\n");
    rollback({ backupDir: backupDir });
    check("rollback restored one.ts", read("one.ts").includes("getLinkGate(link)"));
    check("rollback restored two.ts", read("two.ts") === "// old comment\nkeep();\n");
}

// ── integration: transactional abort — one MISS writes NOTHING ──────────────
console.log("run(): transactional abort");
{
    write("a.ts", "alpha\n");
    write("b.ts", "beta\n");
    let threw = false;
    try {
        await run({
            edits: [
                { file: f("a.ts"), ops: [{ find: "alpha", replace: "ALPHA" }] },
                { file: f("b.ts"), ops: [{ find: "DOES-NOT-EXIST", replace: "x" }] },
            ],
            verbose: false,
            throwOnFailure: true,
        });
    } catch {
        threw = true;
    }
    check("aborted run throws", threw);
    check("a.ts untouched despite its op being OK", read("a.ts") === "alpha\n");
    check("b.ts untouched", read("b.ts") === "beta\n");
}

// ── integration: partial mode writes the clean files ────────────────────────
console.log("run(): partial mode");
{
    let partialError: unknown = null;
    try {
        await run({
            edits: [
                { file: f("a.ts"), ops: [{ find: "alpha", replace: "ALPHA" }] },
                { file: f("b.ts"), ops: [{ find: "DOES-NOT-EXIST", replace: "x" }] },
            ],
            verbose: false,
            partial: true,
            throwOnFailure: true,
        });
    } catch (err) {
        partialError = err;
    }
    check(
        "partial mode with a MISS still fails, code 1, after writing",
        partialError instanceof FableReplaceError &&
            partialError.code === 1 &&
            partialError.message.includes("partial mode wrote 1 file(s)"),
        String(partialError)
    );
    check("clean file written in partial mode", read("a.ts") === "ALPHA\n");
    check("missed file untouched in partial mode", read("b.ts") === "beta\n");
}

// ── integration: dry run writes nothing ─────────────────────────────────────
console.log("run(): dry run");
{
    write("dry.ts", "dry content\n");
    const report = await run({
        edits: [{ file: f("dry.ts"), ops: [{ find: "dry", replace: "wet" }] }],
        dryRun: true,
        verbose: false,
        throwOnFailure: true,
    });
    check("dry run ok", report.ok && report.written.length === 0);
    check("dry run wrote nothing", read("dry.ts") === "dry content\n");
}

// ── integration: post-condition failure aborts ──────────────────────────────
console.log("run(): post-conditions");
{
    write("post.ts", "foo bar\n");
    let threw = false;
    try {
        await run({
            edits: [{ file: f("post.ts"), ops: [{ find: "foo", replace: "baz" }], absentAfter: ["bar"] }],
            verbose: false,
            throwOnFailure: true,
        });
    } catch {
        threw = true;
    }
    check("absentAfter violation aborts", threw && read("post.ts") === "foo bar\n");
}

// ── integration: create, rename, delete ─────────────────────────────────────
console.log("run(): file lifecycle");
{
    write("victim.ts", "bye\n");
    const backupDir = path.join(tmp, "backup2");
    const report = await run({
        edits: [
            {
                file: f("new.ts"),
                createWith: 'export const created = "FIND";\n',
                ops: [{ find: "FIND", replace: "content" }],
            },
            { file: f("one.ts"), renameTo: f("renamed.ts") },
            { file: f("victim.ts"), delete: true },
        ],
        backupDir,
        verbose: false,
        throwOnFailure: true,
    });
    check("lifecycle run ok", report.ok);
    check("createWith + ops", read("new.ts") === 'export const created = "content";\n');
    check("rename moved the file", !fs.existsSync(f("one.ts")) && fs.existsSync(f("renamed.ts")));
    check("delete removed the file", !fs.existsSync(f("victim.ts")));
    rollback({ backupDir: backupDir });
    check("rollback deletes created file", !fs.existsSync(f("new.ts")));
    check("rollback restores renamed source", fs.existsSync(f("one.ts")));
}

// ── comment scanner + higher-level ops ──────────────────────────────────────
console.log("comment scanner + high-level ops");
{
    const src = `const a = "// not a comment";\n// real line comment\nconst b = \`tpl // still string \${x /* real block in interpolation */}\`;\n/* block\n comment */\ncode();\n`;
    const spans = scanComments(src);
    check(
        "scanner skips comment-lookalikes in strings",
        spans.every((s2) => !s2.text.includes("not a comment") && !s2.text.includes("still string"))
    );
    check(
        "scanner finds line + block + interpolation comments",
        spans.filter((s2) => s2.type === "line").length === 1 && spans.filter((s2) => s2.type === "block").length === 2
    );
}
{
    const src = "keep();\n// TODO old marker\nmore(); // trailing TODO old\n";
    const r = dropComments(src, { containing: "TODO old" });
    check(
        "dropComments removes full-line comment incl. its line",
        r.dropped === 2 && r.content === "keep();\nmore();\n"
    );
}
{
    const r = applyOps("a();\n// noise 1\nb();\n// noise 2\n", [
        { kind: "dropComments", containing: "noise", expect: 2 },
    ]);
    check("dropComments op with expect", r.results[0].status === "OK" && r.content === "a();\nb();\n");
}
{
    const r = applyOps("code();\n", [{ kind: "dropComments" } as never]);
    check("dropComments without predicate refuses (never drop ALL)", r.results[0].status === "MISS");
}
{
    const r = applyOps("keep\ndebugLog(1)\nkeep2\ndebugLog(2)\n", [
        { kind: "deleteLines", containing: "debugLog", expect: 2 },
    ]);
    check("deleteLines", r.content === "keep\nkeep2\n");
}
{
    const r = applyOps("if (x) {\n\t\tdoThing( a,  b );\n}", [
        { kind: "fuzzy", find: "doThing( a, b );", replace: "doOther(a, b);" },
    ]);
    check("fuzzy whitespace-tolerant literal", r.content.includes("doOther(a, b);"));
    check("fuzzyWhitespaceRegex matches across reindentation", fuzzyWhitespaceRegex("a b").test("a\n\t b"));
}
{
    const r = applyOps("getFoo(); notGetFoo(); getFoo();", [
        renameSymbol({ oldName: "getFoo", newName: "getBar", expect: 2 }),
    ]);
    check("renameSymbol respects word boundaries", r.content === "getBar(); notGetFoo(); getBar();");
}

// ── verifyCommand keeps the sweep on red ────────────────────────────────────
console.log("run(): verifyCommand");
{
    write("vc.ts", "verify me\n");
    const backupDir = path.join(tmp, "backup3");
    const red = await run({
        edits: [{ file: f("vc.ts"), ops: [{ find: "verify me", replace: "verified" }] }],
        backupDir,
        verifyCommand: "exit 1",
        verbose: false,
        throwOnFailure: true,
    }).catch((e: FableReplaceError) => e);
    check("failing verifyCommand throws code 3", red instanceof FableReplaceError && red.code === 3, String(red));
    check("failing verifyCommand keeps the sweep written", read("vc.ts") === "verified\n", read("vc.ts"));
    check(
        "the thrown error says the sweep is written and carries the verdict",
        red instanceof FableReplaceError &&
            red.message.includes("sweep WRITTEN") &&
            red.report?.verify?.status === "fail" &&
            red.report.verify.exitCode === 1,
        String(red)
    );
    const undo = rollback({ backupDir });
    check(
        "the printed rollback restores it without --force",
        undo.restored.length === 1 && read("vc.ts") === "verify me\n"
    );

    const ok = await run({
        edits: [{ file: f("vc.ts"), ops: [{ find: "verify me", replace: "verified" }] }],
        backupDir: path.join(tmp, "backup4"),
        verifyCommand: "exit 0",
        verbose: false,
        throwOnFailure: true,
    });
    check("passing verifyCommand keeps the write", ok.ok && read("vc.ts") === "verified\n");
    check("a passing verify is reported on the run", ok.verify?.status === "pass" && ok.verify.exitCode === 0);

    // A check that rewrites files (a formatter) must not make the undo command fail with drift.
    write("vc2.ts", "verify me\n");
    const fmtDir = path.join(tmp, "backup-fmt");
    const fmt = await run({
        edits: [{ file: f("vc2.ts"), ops: [{ find: "verify me", replace: "verified" }] }],
        backupDir: fmtDir,
        verifyCommand: `printf 'formatted\\n' > ${f("vc2.ts")} && exit 1`,
        verbose: false,
    }).catch((e: FableReplaceError) => e);
    const fmtUndo = rollback({ backupDir: fmtDir });
    check(
        "the undo works after a verify that rewrote the file",
        fmt instanceof FableReplaceError &&
            fmt.code === 3 &&
            fmtUndo.drifted.length === 0 &&
            read("vc2.ts") === "verify me\n",
        `${String(fmt)} | drifted=${fmtUndo.drifted.length} | ${stringifyJson(read("vc2.ts"))}`
    );

    // Output limits: a pass shows a five-line tail, a fail shows head and tail, both save the rest.
    write("vc3.ts", "verify me\n");
    const tailDir = path.join(tmp, "backup-tail");
    const long = await run({
        edits: [{ file: f("vc3.ts"), ops: [{ find: "verify me", replace: "verified" }] }],
        backupDir: tailDir,
        verifyCommand: "seq 1 12",
        verbose: false,
    });
    check(
        "a passing verify shows only its last 5 lines plus a suppressed-count line",
        long.verify?.shown.length === 6 &&
            long.verify.shown[0].includes("7 earlier line(s) suppressed") &&
            long.verify.shown[5] === "12",
        stringifyJson(long.verify?.shown)
    );
    check(
        "the whole verify output is saved beside the backup",
        fs.readFileSync(path.join(tailDir, "verify-output.txt"), "utf8").trim().split("\n").length === 12
    );
    write("vc4.ts", "verify me\n");
    const both = await run({
        edits: [{ file: f("vc4.ts"), ops: [{ find: "verify me", replace: "verified" }] }],
        backupDir: path.join(tmp, "backup-both"),
        verifyCommand: "seq 1 200 && exit 1",
        verbose: false,
    }).catch((e: FableReplaceError) => e);
    const bothShown = both instanceof FableReplaceError ? (both.report?.verify?.shown ?? []) : [];
    check(
        "a failing verify shows the first 40 and last 60 lines around an omitted marker",
        bothShown.length === 101 &&
            bothShown[0] === "1" &&
            bothShown[40].includes("100 line(s) omitted") &&
            bothShown[100] === "200",
        `${bothShown.length} lines, [40]=${bothShown[40] ?? ""}`
    );

    // More output than the default 1 MB buffer must not read as a failure.
    write("vc5.ts", "verify me\n");
    const big = await run({
        edits: [{ file: f("vc5.ts"), ops: [{ find: "verify me", replace: "verified" }] }],
        backupDir: path.join(tmp, "backup-big"),
        verifyCommand: `bun -e "process.stdout.write('a'.repeat(3000000))"`,
        verbose: false,
    });
    check(
        "3 MB of verify output is a pass, not ENOBUFS",
        big.ok && big.verify?.status === "pass" && big.verify.outputChars === 3000000,
        stringifyJson(big.verify?.status)
    );

    // A check that never returns is "unknown": still exit 3, never a test failure.
    write("vc6.ts", "verify me\n");
    const slow = await run({
        edits: [{ file: f("vc6.ts"), ops: [{ find: "verify me", replace: "verified" }] }],
        backupDir: path.join(tmp, "backup-slow"),
        verifyCommand: "sleep 5",
        verifyTimeoutMs: 300,
        verbose: false,
    }).catch((e: FableReplaceError) => e);
    check(
        "a verify timeout is its own outcome: code 3, status unknown, timedOut",
        slow instanceof FableReplaceError &&
            slow.code === 3 &&
            slow.report?.verify?.status === "unknown" &&
            slow.report.verify.timedOut &&
            slow.message.includes("could not be measured"),
        String(slow)
    );
    check("the timed-out sweep stays written", read("vc6.ts") === "verified\n");

    // A partial run with misses never reaches the check: exit 3 must mean everything declared landed.
    write("vc7.ts", "verify me\n");
    write("vc8.ts", "nothing here\n");
    const part = await run({
        edits: [
            { file: f("vc7.ts"), ops: [{ find: "verify me", replace: "verified" }] },
            { file: f("vc8.ts"), ops: [{ find: "absent needle", replace: "x" }] },
        ],
        backupDir: path.join(tmp, "backup-part"),
        partial: true,
        verifyCommand: "exit 1",
        verbose: false,
    }).catch((e: FableReplaceError) => e);
    check(
        "a partial run with a MISS skips the verify and exits 1",
        part instanceof FableReplaceError &&
            part.code === 1 &&
            part.report?.verify === undefined &&
            read("vc7.ts") === "verified\n",
        String(part)
    );

    // dryRun with a verify is refused before anything happens.
    const dryVerify = await run({
        edits: [{ file: f("vc7.ts"), ops: [{ find: "verified", replace: "verify me" }] }],
        dryRun: true,
        verifyCommand: "exit 0",
        verbose: false,
    }).catch((e: FableReplaceError) => e);
    check(
        "dryRun with a verifyCommand is a pre-flight error",
        dryVerify instanceof FableReplaceError &&
            dryVerify.code === 2 &&
            dryVerify.message.includes("nothing to verify"),
        String(dryVerify)
    );
}

// ── verifyCommand refuses status-hiding shell operators ─────────────────────
console.log("run(): verify command scanner");
{
    const refused = (cmd: string): string => checkVerifyCommand(cmd).refusal ?? "";
    check("a pipe is refused", refused("bun run test | tail -3").includes("contains a pipe"));
    check("a ; chain is refused", refused("bun run test; echo done").includes("chain"));
    check("a newline is refused", refused("bun run test\necho done").includes("more than one line"));
    check("a background & is refused", refused("bun run test &").includes("background"));
    check("&& and || are allowed", refused("a && b || c") === "");
    check("redirects are allowed", refused("bun run test 2>&1 >out.txt <in.txt &>all.txt") === "");
    check(
        "$( ), backticks and env prefixes are allowed",
        refused("FOO=1 bun run test $(git rev-parse HEAD) `date`") === ""
    );
    check(
        "a pipe inside single quotes is allowed",
        refused("bash -c 'set -o pipefail; bun run test | tail -3'") === ""
    );
    check("a pipe inside double quotes is allowed", refused('bun test -t "a|b"') === "");
    check("an escaped quote does not open a quoted region", refused('echo \\"x | cat').includes("contains a pipe"));
    check(
        "/dev/null warns instead of refusing",
        checkVerifyCommand("bun run test 2>/dev/null").warning?.includes("/dev/null") === true &&
            refused("bun run test 2>/dev/null") === ""
    );
    write("scan.ts", "scan me\n");
    const piped = await run({
        edits: [{ file: f("scan.ts"), ops: [{ find: "scan me", replace: "scanned" }] }],
        backupDir: path.join(tmp, "backup-scan"),
        verifyCommand: "exit 1 | cat",
        verbose: false,
    }).catch((e: FableReplaceError) => e);
    check(
        "a piped verifyCommand is a pre-flight error and nothing is written",
        piped instanceof FableReplaceError &&
            piped.code === 2 &&
            piped.message.includes("contains a pipe") &&
            read("scan.ts") === "scan me\n",
        String(piped)
    );
}

// ── guard rails ─────────────────────────────────────────────────────────────
console.log("guard rails");
{
    let threw = false;
    try {
        await run({
            edits: [{ file: path.join(tmp, "node_modules", "x.ts"), ops: [{ find: "a", replace: "b" }] }],
            verbose: false,
            throwOnFailure: true,
        });
    } catch {
        threw = true;
    }
    check("node_modules refused", threw);
}
{
    let threw = false;
    try {
        await run({ edits: [{ file: f("a.ts") }], verbose: false, throwOnFailure: true });
    } catch {
        threw = true;
    }
    check("empty edit refused", threw);
}
{
    let threw = false;
    try {
        await run({
            edits: [
                { file: f("a.ts"), ops: [maybe({ find: "q", replace: "r" })] },
                { file: f("a.ts"), ops: [maybe({ find: "s", replace: "t" })] },
            ],
            verbose: false,
            throwOnFailure: true,
        });
    } catch {
        threw = true;
    }
    check("duplicate file in batch refused", threw);
}

// ── regressions: the four defects found by the 2026-09-03 stress test ───────
console.log("regressions (stress-test defects)");
{
    // 1. a /g predicate regex used to skip every other match (lastIndex carry-over)
    const src4 = "log(1)\nlog(2)\nlog(3)\nlog(4)\nkeep\n";
    const dl = deleteLines(src4, { kind: "deleteLines", matching: /log\(/g });
    check("deleteLines with a /g regex removes EVERY match", dl.removed === 4, `removed ${dl.removed}`);
    const dc = dropComments("// a1\nx;\n// a2\ny;\n// a3\nz;\n// a4\n", { matching: /a\d/g });
    check("dropComments with a /g regex drops EVERY match", dc.dropped === 4, `dropped ${dc.dropped}`);
    const shared = /DEBUG/g;
    const across = [0, 1, 2, 3].map(
        () => deleteLines("k\nDEBUG a\nDEBUG b\n", { kind: "deleteLines", matching: shared }).removed
    );
    check(
        "one shared /g regex behaves the same across files",
        across.every((n) => n === 2),
        across.join(",")
    );
}
{
    // 2. renameTo used to clobber an unrelated existing file with no warning
    write("rn-src.ts", "SOURCE\n");
    write("rn-dst.ts", "PRECIOUS\n");
    let threw = false;
    try {
        await run({
            edits: [{ file: f("rn-src.ts"), ops: [{ find: "SOURCE", replace: "SRC" }], renameTo: f("rn-dst.ts") }],
            verbose: false,
            throwOnFailure: true,
        });
    } catch {
        threw = true;
    }
    check("renameTo onto an existing file is refused", threw && read("rn-dst.ts") === "PRECIOUS\n", read("rn-dst.ts"));
    await run({
        edits: [
            {
                file: f("rn-src.ts"),
                ops: [{ find: "SOURCE", replace: "SRC" }],
                renameTo: f("rn-dst.ts"),
                overwrite: true,
            },
        ],
        verbose: false,
        throwOnFailure: true,
    });
    check("overwrite:true allows it", read("rn-dst.ts") === "SRC\n" && !fs.existsSync(f("rn-src.ts")));
    write("rn-a.ts", "A\n");
    write("rn-b.ts", "B\n");
    let threw2 = false;
    try {
        await run({
            edits: [
                { file: f("rn-a.ts"), ops: [{ find: "A", replace: "A2" }], renameTo: f("rn-x.ts") },
                { file: f("rn-b.ts"), ops: [{ find: "B", replace: "B2" }], renameTo: f("rn-x.ts") },
            ],
            verbose: false,
            throwOnFailure: true,
        });
    } catch {
        threw2 = true;
    }
    check("two edits renaming to the same path are refused", threw2);
}
{
    // 3. an I/O failure mid-batch used to leave the batch half applied
    for (let i = 0; i < 6; i += 1) {
        write(`io${i}.ts`, `const v = "old";\n`);
    }
    fs.chmodSync(f("io3.ts"), 0o444);
    let threw = false;
    try {
        await run({
            edits: [0, 1, 2, 3, 4, 5].map((i) => ({
                file: f(`io${i}.ts`),
                ops: [{ find: `"old"`, replace: `"new"` }],
            })),
            verbose: false,
            throwOnFailure: true,
            backupDir: path.join(tmp, "iobk"),
        });
    } catch {
        threw = true;
    }
    fs.chmodSync(f("io3.ts"), 0o644);
    const allOld = [0, 1, 2, 3, 4, 5].every((i) => read(`io${i}.ts`).includes(`"old"`));
    check(
        "a failing write rolls the whole batch back",
        threw && allOld,
        [0, 1, 2, 3, 4, 5].map((i) => (read(`io${i}.ts`).includes("new") ? "new" : "old")).join(",")
    );
}
{
    // 4. regex literals used to desync the comment scanner for the rest of the file
    const rx = "const RE = /\\/usr\\/bin\\//;\nconst keep = 1;\n";
    check(
        "a regex literal containing // is not a comment",
        scanComments(rx).length === 0,
        stringifyJson(scanComments(rx).map((s) => s.text))
    );
    const quoted = `const esc = /[&<>"']/g;\nconst u = new URL(h, "https://x/").href; // real\n`;
    const spans = scanComments(quoted);
    check(
        "a regex literal containing a quote does not desync the file",
        spans.length === 1 && spans[0].text === "// real",
        stringifyJson(spans.map((s) => s.text))
    );
    const jsx = 'const d = mount(<Tabs t={t} />, "http://x/demo"); // tail\n';
    check(
        "JSX self-close is not a regex",
        scanComments(jsx).length === 1,
        stringifyJson(scanComments(jsx).map((s) => s.text))
    );
    const close = 'const d = <div>x</div>; const u = "http://x/"; // tail\n';
    check(
        "JSX closing tag is not a regex",
        scanComments(close).length === 1,
        stringifyJson(scanComments(close).map((s) => s.text))
    );
    const div = "const avg = total / count / 2; // ok\n";
    check("division is still division", scanComments(div).length === 1);
    const ret = "function f(s) { return /a\\/b/.test(s); } // ok\n";
    check(
        "a regex literal after `return` is skipped",
        scanComments(ret).length === 1,
        stringifyJson(scanComments(ret).map((s) => s.text))
    );
}

// ── rollback safety (2026-09-03 edge-case pass) ─────────────────────────────
console.log("rollback safety");
{
    // a hand edit made AFTER the sweep must never be silently overwritten
    write("rb-hand.ts", "ORIGINAL\n");
    const bd = path.join(tmp, "rb-hand-bk");
    await run({
        edits: [{ file: f("rb-hand.ts"), ops: [{ find: "ORIGINAL", replace: "SWEPT" }] }],
        verbose: false,
        throwOnFailure: true,
        backupDir: bd,
    });
    fs.writeFileSync(f("rb-hand.ts"), "SWEPT\n// hand-written note\n");
    const drifted = rollback({ backupDir: bd });
    check(
        "rollback skips a file changed after the sweep",
        drifted.drifted.length === 1 && drifted.restored.length === 0 && read("rb-hand.ts").includes("hand-written"),
        stringifyJson(read("rb-hand.ts"))
    );
    const forced = rollback({ backupDir: bd, force: true });
    check(
        "rollback({force:true}) restores it anyway",
        forced.restored.length === 1 && read("rb-hand.ts") === "ORIGINAL\n",
        stringifyJson(read("rb-hand.ts"))
    );
}
{
    // only the drifted file is skipped; its neighbours still roll back
    write("rb-a.ts", "A\n");
    write("rb-b.ts", "B\n");
    const bd = path.join(tmp, "rb-pair-bk");
    await run({
        edits: [
            { file: f("rb-a.ts"), ops: [{ find: "A", replace: "A2" }] },
            { file: f("rb-b.ts"), ops: [{ find: "B", replace: "B2" }] },
        ],
        verbose: false,
        throwOnFailure: true,
        backupDir: bd,
    });
    fs.writeFileSync(f("rb-a.ts"), "A2 then hand-edited\n");
    const rep = rollback({ backupDir: bd });
    check(
        "a drifted file does not block its neighbours",
        rep.drifted.length === 1 &&
            rep.restored.length === 1 &&
            read("rb-b.ts") === "B\n" &&
            read("rb-a.ts") === "A2 then hand-edited\n"
    );
}
{
    // reusing a backupDir would destroy the first snapshot — refuse before writing
    write("rb-reuse.ts", "V1\n");
    const bd = path.join(tmp, "rb-reuse-bk");
    await run({
        edits: [{ file: f("rb-reuse.ts"), ops: [{ find: "V1", replace: "V2" }] }],
        verbose: false,
        throwOnFailure: true,
        backupDir: bd,
    });
    let threw = false;
    try {
        await run({
            edits: [{ file: f("rb-reuse.ts"), ops: [{ find: "V2", replace: "V3" }] }],
            verbose: false,
            throwOnFailure: true,
            backupDir: bd,
        });
    } catch {
        threw = true;
    }
    check("a reused backupDir is refused in pre-flight", threw && read("rb-reuse.ts") === "V2\n", read("rb-reuse.ts"));
    await run({
        edits: [{ file: f("rb-reuse.ts"), ops: [{ find: "V2", replace: "V3" }] }],
        verbose: false,
        throwOnFailure: true,
        backupDir: bd,
        backupOverwrite: true,
    });
    check("backupOverwrite:true allows deliberate reuse", read("rb-reuse.ts") === "V3\n");
}
{
    // byte fidelity across CRLF / missing trailing newline / unicode
    const shapes = {
        "rb-crlf.ts": "a\r\nDROP\r\nb\r\n",
        "rb-nonl.ts": "no trailing newline DROP",
        "rb-uni.ts": "emoji 👍 DROP ünïcødé\n",
    };
    const bd = path.join(tmp, "rb-bytes-bk");
    const before = Object.entries(shapes).map(([n, c]) => {
        write(n, c);
        return [n, fs.readFileSync(f(n))] as const;
    });
    await run({
        edits: Object.keys(shapes).map((n) => ({ file: f(n), ops: [{ find: "DROP", replace: "X" }] })),
        verbose: false,
        throwOnFailure: true,
        backupDir: bd,
    });
    rollback({ backupDir: bd });
    check(
        "rollback is byte-exact across CRLF / no-newline / unicode",
        before.every(([n, buf]) => buf.equals(fs.readFileSync(f(n))))
    );
}
{
    // the executable bit must survive a sweep and its rollback
    const p = write("rb-exec.sh", "#!/bin/sh\necho old\n");
    fs.chmodSync(p, 0o755);
    const bd = path.join(tmp, "rb-exec-bk");
    await run({
        edits: [{ file: p, ops: [{ find: "echo old", replace: "echo new" }] }],
        verbose: false,
        throwOnFailure: true,
        backupDir: bd,
    });
    rollback({ backupDir: bd });
    check(
        "the executable bit survives sweep + rollback",
        (fs.statSync(p).mode & 0o777) === 0o755,
        (fs.statSync(p).mode & 0o777).toString(8)
    );
}

{
    // two stacked sweeps must unwind newest-first; the wrong order is caught as drift
    write("rb-stack.ts", "V1\n");
    const bkA = path.join(tmp, "rb-stack-a");
    const bkB = path.join(tmp, "rb-stack-b");
    await run({
        edits: [{ file: f("rb-stack.ts"), ops: [{ find: "V1", replace: "V2" }] }],
        verbose: false,
        throwOnFailure: true,
        backupDir: bkA,
    });
    await run({
        edits: [{ file: f("rb-stack.ts"), ops: [{ find: "V2", replace: "V3" }] }],
        verbose: false,
        throwOnFailure: true,
        backupDir: bkB,
    });
    const wrongOrder = rollback({ backupDir: bkA });
    check(
        "rolling back the older sweep first is refused",
        wrongOrder.drifted.length === 1 && read("rb-stack.ts") === "V3\n",
        read("rb-stack.ts")
    );
    rollback({ backupDir: bkB });
    rollback({ backupDir: bkA });
    check("newest-first unwinds both sweeps to the original", read("rb-stack.ts") === "V1\n", read("rb-stack.ts"));
}

// ── leftovers(): a rename is not finished when the code is green ────────────
console.log("leftovers");
{
    fs.mkdirSync(f("lo/src"), { recursive: true });
    fs.mkdirSync(f("lo/node_modules"), { recursive: true });
    fs.writeFileSync(f("lo/src/code.ts"), 'export { newName as oldName } from "./x";\n');
    fs.writeFileSync(f("lo/README.md"), "Call `oldName(x)` to format.\n");
    fs.writeFileSync(f("lo/node_modules/noise.ts"), "const oldName = 1;\n");
    const rep = leftovers({ names: ["oldName"], dirs: [f("lo")], quiet: true });
    check(
        "leftovers finds the prose mention",
        rep.docs.length === 1 && rep.docs[0].includes("README.md"),
        stringifyJson(rep.docs)
    );
    check(
        "leftovers separates the legitimate code alias",
        rep.code.length === 1 && rep.code[0].includes("code.ts"),
        stringifyJson(rep.code)
    );
    check("leftovers skips node_modules", !rep.code.concat(rep.docs).some((h) => h.includes("node_modules")));
    check(
        "leftovers respects word boundaries",
        leftovers({ names: ["oldNam"], dirs: [f("lo")], quiet: true }).docs.length === 0
    );
    // the root the caller passes may itself sit under a directory name we skip while
    // descending (a git worktree, a build output). It must still be scannable.
    fs.mkdirSync(f("lo/build/nested"), { recursive: true });
    fs.writeFileSync(f("lo/build/nested/code.ts"), "const oldName = 1;\n");
    check(
        "a skipped directory name is skipped while descending",
        leftovers({ names: ["oldName"], dirs: [f("lo")], quiet: true }).code.length === 1
    );
    check(
        "but that same directory is scannable as an explicit root",
        leftovers({ names: ["oldName"], dirs: [f("lo/build")], quiet: true }).code.length === 1
    );
}

// ── countMatches(): the numbers `expect:` rests on ─────────────────────────
console.log("countMatches");
{
    write("cm-a.ts", "oldName(1); oldName(2);\nconst x = _oldName;\n");
    write("cm-b.ts", "nothing here\n");
    const counts = countMatches({ files: [f("cm-a.ts"), f("cm-b.ts")], pattern: "oldName", quiet: true });
    check("identifier pattern is word-boundary matched", counts[f("cm-a.ts")] === 2, String(counts[f("cm-a.ts")]));
    check("a zero-match file is reported as zero, not omitted", counts[f("cm-b.ts")] === 0, stringifyJson(counts));
    write("cm-c.ts", "a.b.c and a.b.c\n");
    check(
        "a non-identifier string is matched literally",
        countMatches({ files: [f("cm-c.ts")], pattern: "a.b.c", quiet: true })[f("cm-c.ts")] === 2
    );
    check(
        "a non-global RegExp still counts every match",
        countMatches({ files: [f("cm-a.ts")], pattern: /oldName/, quiet: true })[f("cm-a.ts")] === 3
    );
}

// ── dry-run diff output is bounded across the WHOLE run ────────────────────
console.log("dry-run diff budget");
{
    const files = [0, 1, 2, 3, 4].map((i) => {
        write(
            `dd${i}.ts`,
            `${Array.from({ length: 60 }, (_, n) => `const v${n} = ${i};`).join("\n")}\nconst TARGET = "old";\n`
        );
        return f(`dd${i}.ts`);
    });
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
        logged.push(args.join(" "));
    };
    try {
        await run({
            edits: files.map((file) => ({ file, ops: [{ find: `"old"`, replace: `"new"` }] })),
            verbose: false,
            dryRun: true,
            throwOnFailure: true,
            maxTotalDiffLines: 12,
        });
    } finally {
        console.log = realLog;
    }
    const joined = logged.join("\n");
    check(
        "the total diff budget suppresses later diffs",
        joined.includes("diffs for") && joined.includes("suppressed"),
        joined.slice(-200)
    );
    check("the dry-run verdict still prints after suppression", joined.includes("DRY RUN — nothing written"));
    check(
        "suppression wrote nothing",
        files.every((p) => fs.readFileSync(p, "utf8").includes('"old"'))
    );
}

// ── the documented two-symbol overlapping rename must actually RUN ─────────
console.log("mergeFileEdits / overlapping renames");
{
    write("mf-both.ts", "renderCliKeyRow(); renderCliSection();\n");
    write("mf-a.ts", "renderCliKeyRow();\n");
    write("mf-b.ts", "renderCliSection();\n");
    const both = [f("mf-both.ts")];
    // exactly the shape SKILL.md documents — without the merge this is "listed twice"
    let threwUnmerged = false;
    try {
        await run({
            edits: [
                ...renameSymbolAcross({
                    files: [...both, f("mf-a.ts")],
                    oldName: "renderCliKeyRow",
                    newName: "renderCliKeyValueRow",
                }),
                ...renameSymbolAcross({
                    files: [...both, f("mf-b.ts")],
                    oldName: "renderCliSection",
                    newName: "renderCliSectionHeader",
                }),
            ],
            verbose: false,
            throwOnFailure: true,
            dryRun: true,
        });
    } catch {
        threwUnmerged = true;
    }
    check("concatenating two renameSymbolAcross calls with an overlap is refused", threwUnmerged);
    let mergedThrew = "";
    try {
        await run({
            edits: mergeFileEdits([
                ...renameSymbolAcross({
                    files: [...both, f("mf-a.ts")],
                    oldName: "renderCliKeyRow",
                    newName: "renderCliKeyValueRow",
                }),
                ...renameSymbolAcross({
                    files: [...both, f("mf-b.ts")],
                    oldName: "renderCliSection",
                    newName: "renderCliSectionHeader",
                }),
            ]),
            verbose: false,
            throwOnFailure: true,
        });
    } catch (err) {
        mergedThrew = String(err).split("\n")[0];
    }
    check("the merged batch runs without a pre-flight refusal", mergedThrew === "", mergedThrew);
    check(
        "mergeFileEdits makes the documented pattern run",
        read("mf-both.ts") === "renderCliKeyValueRow(); renderCliSectionHeader();\n",
        read("mf-both.ts")
    );
    check(
        "the non-overlapping files renamed too",
        read("mf-a.ts").includes("renderCliKeyValueRow") && read("mf-b.ts").includes("renderCliSectionHeader")
    );
    check(
        "merge unions post-conditions",
        mergeFileEdits([
            { file: "x.ts", ops: [maybe({ find: "a", replace: "b" })], expectAfter: ["p"] },
            { file: "x.ts", ops: [maybe({ find: "c", replace: "d" })], absentAfter: ["q"] },
        ])[0].expectAfter?.length === 1
    );
    check(
        "merge concatenates ops in order",
        mergeFileEdits([
            { file: "x.ts", ops: [maybe({ find: "a", replace: "b" })] },
            { file: "x.ts", ops: [maybe({ find: "c", replace: "d" })] },
        ])[0].ops?.length === 2
    );
    let conflicted = false;
    try {
        mergeFileEdits([
            { file: "x.ts", ops: [maybe({ find: "a", replace: "b" })], renameTo: "y.ts" },
            { file: "x.ts", ops: [maybe({ find: "c", replace: "d" })], renameTo: "z.ts" },
        ]);
    } catch {
        conflicted = true;
    }
    check("merge refuses conflicting renameTo rather than guessing", conflicted);
    let deleteConflict = false;
    try {
        mergeFileEdits([
            { file: "x.ts", delete: true },
            { file: "x.ts", ops: [maybe({ find: "a", replace: "b" })] },
        ]);
    } catch {
        deleteConflict = true;
    }
    check("merge refuses a delete beside ops", deleteConflict);
}

// ── generated-file guard: catches output, not files that EMIT the marker ───
console.log("generated-file guard");
{
    write(
        "gen-real.ts",
        "// This file was automatically generated by a tool.\n// You should NOT make any changes in this file.\nexport const routes = 1;\n"
    );
    write(
        "gen-emitter.ts",
        'export const header = "# my shell hook — auto-generated, do not edit";\nexport const x = 1;\n'
    );
    write("gen-plain.ts", "export const x = 1;\n");
    fs.mkdirSync(f("gensub"), { recursive: true });
    fs.writeFileSync(f("gensub/routeTree.gen.ts"), "export const t = 1;\n");
    check(
        "a real generated header is caught",
        looksGenerated(f("gen-real.ts")) !== null,
        String(looksGenerated(f("gen-real.ts")))
    );
    check("a *.gen.ts path is caught", looksGenerated(f("gensub/routeTree.gen.ts")) !== null);
    check(
        "a file that merely EMITS the marker in a string is NOT flagged",
        looksGenerated(f("gen-emitter.ts")) === null,
        String(looksGenerated(f("gen-emitter.ts")))
    );
    check("an ordinary file is not flagged", looksGenerated(f("gen-plain.ts")) === null);
    let refused = false;
    try {
        await run({
            edits: [
                {
                    file: f("gen-real.ts"),
                    ops: [{ find: "export const routes = 1;", replace: "export const routes = 2;" }],
                },
            ],
            verbose: false,
            throwOnFailure: true,
        });
    } catch {
        refused = true;
    }
    check("the runner refuses a generated file", refused && read("gen-real.ts").includes("routes = 1"));
    let overrideErr = "";
    try {
        await run({
            edits: [
                {
                    file: f("gen-real.ts"),
                    ops: [{ find: "export const routes = 1;", replace: "export const routes = 2;" }],
                    allowGenerated: true,
                },
            ],
            verbose: false,
            throwOnFailure: true,
        });
    } catch (err) {
        overrideErr = String(err).split("\n")[0];
    }
    check(
        "per-file allowGenerated overrides it without disarming the batch",
        overrideErr === "" && read("gen-real.ts").includes("routes = 2"),
        overrideErr || read("gen-real.ts")
    );
    // the per-file flag must NOT leak to a sibling edit in the same batch
    write("gen-real2.ts", "// automatically generated, do not edit\nexport const q = 1;\n");
    let siblingRefused = false;
    try {
        await run({
            edits: [
                { file: f("gen-real.ts"), ops: [{ find: "routes = 2", replace: "routes = 3" }], allowGenerated: true },
                { file: f("gen-real2.ts"), ops: [{ find: "q = 1", replace: "q = 2" }] },
            ],
            verbose: false,
            throwOnFailure: true,
        });
    } catch {
        siblingRefused = true;
    }
    check(
        "one file's allowGenerated does not disarm the guard for its siblings",
        siblingRefused && read("gen-real2.ts").includes("q = 1")
    );
}

// ── post-flight leftover gate + recon shadow warning ───────────────────────
console.log("leftovers gate / shadow warning");
{
    fs.mkdirSync(f("lg/src"), { recursive: true });
    fs.writeFileSync(f("lg/src/a.ts"), "export const oldName = 1;\n");
    fs.writeFileSync(f("lg/README.md"), "Call `oldName()` first.\n");
    let gated = "";
    let gatedCode = 0;
    try {
        await run({
            edits: renameSymbolAcross({ files: [f("lg/src/a.ts")], oldName: "oldName", newName: "newName" }),
            verbose: false,
            throwOnFailure: true,
            backupDir: path.join(tmp, "lg-bk"),
            leftoversCheck: { names: ["oldName"], dirs: [f("lg")] },
        });
    } catch (err) {
        gated = String(err);
        gatedCode = err instanceof FableReplaceError ? err.code : 0;
    }
    check("a stale prose mention fails the run", gated.includes("stale prose mention"), gated);
    check("stale prose after a green sweep exits 3, because the code IS written", gatedCode === 3, String(gatedCode));
    check("but the verified code is still written", fs.readFileSync(f("lg/src/a.ts"), "utf8").includes("newName"));
    fs.writeFileSync(f("lg/README.md"), "Call `newName()` first.\n");
    fs.writeFileSync(f("lg/src/b.ts"), "export const oldName = 2;\n");
    const rep = await run({
        edits: renameSymbolAcross({ files: [f("lg/src/b.ts")], oldName: "oldName", newName: "newName" }),
        verbose: false,
        throwOnFailure: true,
        backupDir: path.join(tmp, "lg-bk2"),
        leftoversCheck: { names: ["oldName"], dirs: [f("lg")] },
    });
    check("clean docs pass the gate", rep.ok === true);
    check(
        "the backup dir is not scanned as a survivor",
        leftovers({ names: ["oldName"], dirs: [path.join(tmp, "lg-bk")], quiet: true }).code.length === 0
    );
}
{
    // countMatches must flag a file that DECLARES the same bare name
    write("sh-consumer.ts", "import { fmt } from './x';\nfmt(); oldName();\n");
    write("sh-owner.ts", "function oldName() { return 1; }\noldName();\n");
    const counts = countMatches({ files: [f("sh-consumer.ts"), f("sh-owner.ts")], pattern: "oldName", quiet: true });
    check("both files counted", counts[f("sh-consumer.ts")] === 1 && counts[f("sh-owner.ts")] === 2);
    const printed: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]): void => {
        printed.push(a.join(" "));
    };
    try {
        countMatches({ files: [f("sh-consumer.ts"), f("sh-owner.ts")], pattern: "oldName" });
    } finally {
        console.log = realLog;
    }
    const joined = printed.join("\n");
    // sh-owner declares but does not import, so it lands in the "decide per file"
    // bucket rather than the wrapper bucket — see the declaration-split test below.
    check(
        "a locally-declaring file is surfaced during recon",
        joined.includes("without importing it") && joined.includes("sh-owner.ts"),
        joined.slice(-200)
    );
    check(
        "a plain consumer is not surfaced as a declarer",
        !joined.split("without importing it")[1]?.includes("sh-consumer.ts")
    );
}
{
    const a = scratchDir("x");
    const b = scratchDir("x");
    check("scratchDir returns a unique path per call", a !== b && fs.existsSync(a) && fs.existsSync(b));
}

// ── findFiles(): recon must be able to START inside the API ────────────────
console.log("findFiles");
{
    fs.mkdirSync(f("ff/src/deep"), { recursive: true });
    fs.mkdirSync(f("ff/src/node_modules/pkg"), { recursive: true });
    fs.writeFileSync(f("ff/src/hit.ts"), "export const oldName = 1;\n");
    fs.writeFileSync(f("ff/src/deep/hit.tsx"), "oldName();\n");
    fs.writeFileSync(f("ff/src/miss.ts"), "export const other = 1;\n");
    fs.writeFileSync(f("ff/src/notes.md"), "oldName is documented here\n");
    fs.writeFileSync(f("ff/src/node_modules/pkg/hit.ts"), "oldName();\n");
    const hits = findFiles({ roots: [f("ff")], containing: /\boldName\b/ });
    check(
        "findFiles finds matching .ts and .tsx",
        hits.length === 2,
        stringifyJson(hits.map((h) => h.split("/").pop()))
    );
    check("findFiles skips node_modules", !hits.some((h) => h.includes("node_modules")));
    check("findFiles excludes non-listed extensions by default", !hits.some((h) => h.endsWith(".md")));
    const withMd = findFiles({ roots: [f("ff")], containing: /\boldName\b/, exts: [".md"] });
    check("findFiles honours an explicit extension list", withMd.length === 1 && withMd[0].endsWith("notes.md"));
    check("findFiles accepts a literal string", findFiles({ roots: [f("ff")], containing: "oldName" }).length === 2);
    check(
        "findFiles output feeds countMatches",
        countMatches({
            files: findFiles({ roots: [f("ff")], containing: "oldName" }),
            pattern: "oldName",
            quiet: true,
        })[f("ff/src/hit.ts")] === 1
    );
}

// ── recon fixes found by the grok round ────────────────────────────────────
console.log("recon: leftovers on files, needle anchoring, declaration split");
{
    fs.mkdirSync(f("gk/src"), { recursive: true });
    fs.writeFileSync(f("gk/README.md"), "oldName is documented here\n");
    fs.writeFileSync(f("gk/src/imp.ts"), 'import x from "@pkg/utils/Stopwatch";\n');
    // a FILE path must be accepted — the docs' own example passes README.md
    let viaFile: { code: string[]; docs: string[] } = { code: [], docs: [] };
    let viaFileErr = "";
    try {
        viaFile = leftovers({ names: ["oldName"], dirs: [f("gk/src"), f("gk/README.md")], quiet: true });
    } catch (err) {
        viaFileErr = String(err).split("\n")[0];
    }
    check(
        "leftovers accepts a file path, not just a directory",
        viaFileErr === "" && viaFile.docs.length === 1,
        viaFileErr || stringifyJson(viaFile.docs)
    );
    // a non-identifier needle must NOT be word-boundary wrapped, or it silently finds nothing
    const viaPath = leftovers({ names: ["@pkg/utils/Stopwatch"], dirs: [f("gk/src")], quiet: true });
    check("a non-identifier needle matches literally", viaPath.code.length === 1, stringifyJson(viaPath.code));
    // one line matching two needles is ONE surviving line
    fs.writeFileSync(f("gk/src/two.ts"), "aaa(); bbb();\n");
    check(
        "a line matching two needles is counted once",
        leftovers({ names: ["aaa", "bbb"], dirs: [f("gk/src/two.ts")], quiet: true }).code.length === 1
    );
}
{
    // the declaration warning must not cry wolf on the definition being renamed
    write("dw-wrapper.ts", 'import { fmt as _fmt } from "./x";\nfunction fmt() { return _fmt(); }\nfmt();\n');
    write("dw-source.ts", "export function fmt() { return 1; }\n");
    const printed: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]): void => {
        printed.push(a.join(" "));
    };
    try {
        countMatches({ files: [f("dw-wrapper.ts"), f("dw-source.ts")], pattern: "fmt" });
    } finally {
        console.log = realLog;
    }
    const joined = printed.join("\n");
    const wrapperLine = joined.split("both IMPORT and DECLARE")[1]?.split("·")[0] ?? "";
    const sourceLine = joined.split("without importing it")[1] ?? "";
    check(
        "a file that imports AND declares is flagged as a wrapper",
        wrapperLine.includes("dw-wrapper.ts") && !wrapperLine.includes("dw-source.ts"),
        wrapperLine.trim()
    );
    check(
        "a file that only declares is reported separately, not as a shadow",
        sourceLine.includes("dw-source.ts"),
        sourceLine.trim()
    );
}
{
    // renameSymbolAcross must accept the countMatches map and drop zero-match files
    write("rm-a.ts", "oldName(); oldName();\n");
    write("rm-b.ts", "nothing\n");
    const counts = countMatches({ files: [f("rm-a.ts"), f("rm-b.ts")], pattern: "oldName", quiet: true });
    const edits = renameSymbolAcross({ files: counts, oldName: "oldName", newName: "newName" });
    check(
        "a counts map drops zero-match files",
        edits.length === 1 && edits[0].file === f("rm-a.ts"),
        stringifyJson(edits.map((e) => e.file))
    );
    await run({ edits, verbose: false, throwOnFailure: true });
    check("and the pinned count applies", read("rm-a.ts") === "newName(); newName();\n", read("rm-a.ts"));
}

// ── line-oriented inserts and append ─────────────────────────────────────────
console.log("insertLines / append");
{
    const r = applyOps("a\nb\nc\n", [{ kind: "insertLinesAfter", anchor: "b", text: "b2\nb3" }]);
    check(
        "insertLinesAfter puts whole lines under the anchor line",
        r.content === "a\nb\nb2\nb3\nc\n",
        stringifyJson(r.content)
    );
    const r2 = applyOps("a\n  b = 1;\nc\n", [{ kind: "insertLinesBefore", anchor: "= 1", text: "  // note" }]);
    check(
        "insertLinesBefore ignores where on the line the anchor sits",
        r2.content === "a\n  // note\n  b = 1;\nc\n",
        stringifyJson(r2.content)
    );
    const r2b = applyOps("a\nb\n", [{ kind: "insertLinesAfter", anchor: "a", text: "x\n" }]);
    check(
        "a trailing newline in the text is a real blank line (spec bodies rely on it)",
        r2b.content === "a\nx\n\nb\n",
        stringifyJson(r2b.content)
    );
    const r3 = applyOps("a\nb\nb\n", [{ kind: "insertLinesAfter", anchor: "b", text: "x" }]);
    check(
        "insertLines needs a unique anchor",
        r3.results[0].status === "MISS" && (r3.results[0].reason ?? "").includes("2×")
    );
    const r6 = applyOps("a\nb\nc\nd\n", [{ kind: "insertLinesAfter", anchor: "b\nc", text: "X" }]);
    check(
        "insertLinesAfter with a multi-line anchor goes below the anchor's LAST line",
        r6.content === "a\nb\nc\nX\nd\n",
        stringifyJson(r6.content)
    );
    const r7 = applyOps("a\nb\nc\nd\n", [{ kind: "insertLinesBefore", anchor: "b\nc", text: "X" }]);
    check(
        "insertLinesBefore with a multi-line anchor goes above the anchor's FIRST line",
        r7.content === "a\nX\nb\nc\nd\n",
        stringifyJson(r7.content)
    );
    const r4 = applyOps("a", [{ kind: "append", text: "z" }]);
    check("append adds the newline between and at the end", r4.content === "a\nz\n", stringifyJson(r4.content));
    const r5 = applyOps("a\n", [{ kind: "append", text: "z\n" }]);
    check("append never doubles a newline", r5.content === "a\nz\n", stringifyJson(r5.content));
}

// ── nearestHint: a MISS says where to look ──────────────────────────────────
console.log("nearestHint");
{
    const src = "one\n    two = 2;\nthree\n";
    check(
        "already applied",
        nearestHint({ content: src, needle: "two = 1;", replacement: "two = 2;" }).includes("already")
    );
    check("whitespace-only drift → fuzzy hint", nearestHint({ content: src, needle: "two=2;" }).includes("whitespace"));
    check("case typo → case hint", nearestHint({ content: src, needle: "    Two = 2;" }).includes("case"));
    check("divergence line named", nearestHint({ content: src, needle: "one\nnope" }).includes("diverges at line 2"));
    check(
        "zero-vs-some whitespace still counts as whitespace drift",
        nearestHint({ content: "a = b;", needle: "a=b;" }).includes("whitespace")
    );
    check("nothing similar → re-read", nearestHint({ content: src, needle: "zebra crossing" }).includes("Re-read"));
    const r = applyOps(src, [{ find: "two = 3;", replace: "two = 4;" }]);
    check("literal MISS reason carries the hint", (r.results[0].reason ?? "").includes("needle not found."));
}

// ── parseSpec: the CLI's marker format ──────────────────────────────────────
console.log("parseSpec");
{
    const edits = parseSpec({
        text: [
            "# comment",
            "@@ a.ts",
            "expect: after",
            "absent: before",
            "<<<",
            "before",
            "===",
            "after",
            ">>>",
            "<<< count=all optional label=every one",
            "x",
            "===",
            "y",
            ">>>",
            "<<< regex flags=i count=2",
            "foo(\\d)",
            "===",
            "bar($1)",
            ">>>",
            "<<< after",
            "anchor",
            "===",
            "line1",
            "line2",
            ">>>",
            "<<< append",
            "tail",
            ">>>",
            "<<< delete",
            "gone",
            ">>>",
            "<<< block",
            "/**",
            "===",
            " */",
            "===",
            ">>>",
            "@@ b.ts",
            "<<< create",
            "fresh",
            ">>>",
        ].join("\n"),
    });
    check("two file sections", edits.length === 2 && edits[0].file === "a.ts" && edits[1].file === "b.ts");
    check("post-conditions parsed", edits[0].expectAfter?.[0] === "after" && edits[0].absentAfter?.[0] === "before");
    const ops = edits[0].ops ?? [];
    check(
        "literal op",
        ops[0] !== undefined &&
            "find" in ops[0] &&
            ops[0].find === "before" &&
            (ops[0] as { replace: string }).replace === "after"
    );
    check(
        "count=all optional label",
        "count" in ops[1] && ops[1].count === "all" && ops[1].optional === true && ops[1].label === "every one"
    );
    check(
        "regex op with flags and pinned count",
        ops[2].kind === "regex" &&
            ops[2].find.flags.includes("i") &&
            ops[2].find.flags.includes("g") &&
            ops[2].expect === 2
    );
    check(
        "after → insertLinesAfter with multi-line text",
        ops[3].kind === "insertLinesAfter" && ops[3].text === "line1\nline2"
    );
    check("append", ops[4].kind === "append" && ops[4].text === "tail");
    check(
        "delete → literal with newline, empty replace",
        "find" in ops[5] && ops[5].find === "gone\n" && (ops[5] as { replace: string }).replace === ""
    );
    check("block with empty replacement → deleteBlock", ops[6].kind === "deleteBlock");
    check("create → createWith with trailing newline", edits[1].createWith === "fresh\n" && edits[1].ops === undefined);
    let err = "";
    try {
        parseSpec({ text: "@@ a.ts\n<<< nope\nx\n===\ny\n>>>" });
    } catch (e) {
        err = String(e);
    }
    check("unknown modifier names the line", err.includes("line 2") && err.includes("nope"));
    err = "";
    try {
        parseSpec({ text: "@@ a.ts\n<<<\nx\n" });
    } catch (e) {
        err = String(e);
    }
    check(
        "unclosed block names the kind, the cut point and the heredoc trap",
        err.includes("block (replace) never closed") &&
            err.includes("1 line(s) into its body") &&
            err.includes('last line(s) read: "x"') &&
            err.includes("delimiter") &&
            err.includes("--spec <file>"),
        err
    );
    err = "";
    try {
        parseSpec({ text: "<<<\nx\n===\ny\n>>>" });
    } catch (e) {
        err = String(e);
    }
    check("op before @@ is an error", err.includes("before any @@"));
    const json = parseSpec({
        text: '[{"file":"j.ts","ops":[{"kind":"regex","find":"a(\\\\d)","flags":"g","replace":"b$1"}]}]',
    });
    check(
        "JSON spec with a regex op",
        json[0].ops?.[0].kind === "regex" && (json[0].ops[0] as { find: RegExp }).find.source === "a(\\d)"
    );
}

// ── cli.ts end to end ───────────────────────────────────────────────────────
console.log("cli.ts");
{
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const dir = f("cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "t.ts"), "const a = 1;\nconst b = 2;\n");
    const runCli = (spec: string, ...args: string[]): { status: number | null; out: string } => {
        const p = spawnSync("bun", [cli, ...args], { cwd: dir, input: spec, encoding: "utf8", env: hermeticEnv });
        return { status: p.status, out: `${p.stdout}\n${p.stderr}` };
    };
    const ok = runCli(
        "@@ t.ts\n<<<\nconst a = 1;\n===\nconst a = 10;\n>>>\n<<< append\nexport {};\n>>>\n@@ n.ts\n<<< create\nexport const n = 1;\n>>>\n"
    );
    check(
        "cli: ok run exits 0 and writes",
        ok.status === 0 &&
            read("cli/t.ts") === "const a = 10;\nconst b = 2;\nexport {};\n" &&
            read("cli/n.ts") === "export const n = 1;\n",
        ok.out
    );
    check(
        "cli: ok run reports OK lines and a backup dir",
        ok.out.includes("OK") && ok.out.includes("Backed up") && ok.out.includes("SWEEP COMPLETE")
    );
    const miss = runCli(
        "@@ t.ts\n<<<\nconst b = 2;\n===\nconst b = 3;\n>>>\n<<<\nconst zz = 9;\n===\nconst zz = 8;\n>>>\n"
    );
    check(
        "cli: one MISS aborts the batch, exit 1, nothing written",
        miss.status === 1 &&
            read("cli/t.ts").includes("const b = 2;") &&
            miss.out.includes("MISS") &&
            miss.out.includes("wrote NOTHING")
    );
    const dry = runCli("@@ t.ts\n<<<\nconst b = 2;\n===\nconst b = 3;\n>>>\n", "--dry");
    check(
        "cli: --dry prints a diff and writes nothing",
        dry.status === 0 && dry.out.includes("+ const b = 3;") && read("cli/t.ts").includes("const b = 2;")
    );
    const clash = runCli("@@ t.ts\n<<< create\nx\n>>>\n");
    check("cli: create refuses an existing file", clash.status === 1 && clash.out.includes("refuses to overwrite"));
    const bad = runCli("@@ t.ts\n<<< wat\nx\n===\ny\n>>>\n");
    check(
        "cli: spec error exits 2 with the line",
        bad.status === 2 && bad.out.includes("SPEC ERROR") && bad.out.includes("line 2")
    );
    const verify = runCli("@@ t.ts\n<<<\nconst b = 2;\n===\nconst b = 3;\n>>>\n", "--verify", "exit 1");
    const undoLine = verify.out.match(/--rollback "([^"]+)"/)?.[1];
    check(
        "cli: a red --verify keeps the write, exits 3 and prints the undo command",
        verify.status === 3 &&
            read("cli/t.ts").includes("const b = 3;") &&
            verify.out.includes("SWEEP WRITTEN, VERIFY FAILED (exit 1)") &&
            undoLine !== undefined,
        `${String(verify.status)} ${verify.out.slice(-400)}`
    );
    const undone = runCli("", "--rollback", undoLine ?? "/nonexistent");
    check(
        "cli: the printed --rollback line restores the file",
        undone.status === 0 && read("cli/t.ts").includes("const b = 2;"),
        undone.out
    );
    const dryVerify = runCli("@@ t.ts\n<<<\nconst b = 2;\n===\nconst b = 3;\n>>>\n", "--dry", "--verify", "exit 0");
    check(
        "cli: --dry with --verify is refused, exit 2, nothing written",
        dryVerify.status === 2 &&
            dryVerify.out.includes("nothing to verify") &&
            read("cli/t.ts").includes("const b = 2;"),
        dryVerify.out
    );
    const piped = runCli("@@ t.ts\n<<<\nconst b = 2;\n===\nconst b = 3;\n>>>\n", "--verify", "bun run test | tail -3");
    check(
        "cli: --verify with a pipe is refused, exit 2, nothing written",
        piped.status === 2 &&
            piped.out.includes("contains a pipe") &&
            piped.out.includes("pipefail") &&
            read("cli/t.ts").includes("const b = 2;"),
        piped.out
    );
    const devnull = runCli("@@ t.ts\n<<<\nconst b = 2;\n===\nconst b = 3;\n>>>\n", "--verify", "exit 0 2>/dev/null");
    check(
        "cli: --verify with /dev/null warns and still runs",
        devnull.status === 0 &&
            devnull.out.includes("WARNING") &&
            devnull.out.includes("/dev/null") &&
            read("cli/t.ts").includes("const b = 3;"),
        devnull.out
    );
    const api = spawnSync("bun", [cli, "--api"], { encoding: "utf8" });
    check(
        "cli: --api lists params interfaces with docs",
        api.status === 0 &&
            api.stdout.includes("interface RunParams") &&
            api.stdout.includes("interface LiteralOp") &&
            api.stdout.includes("parseSpec = (")
    );
}
// ── round 2: what ten stress-test agents tripped over ───────────────────────
console.log("round 2: run() contract");
{
    let err: unknown = null;
    try {
        await run({
            edits: [{ file: f("a.ts"), ops: [{ find: "ALPHA", replace: "A" }] }],
            verbose: false,
            ...({ dry: true } as object),
        });
    } catch (e) {
        err = e;
    }
    check(
        "an unknown option key is a pre-flight error (code 2) with a hint",
        err instanceof FableReplaceError &&
            err.code === 2 &&
            err.message.includes('unknown option "dry"') &&
            err.message.includes("dryRun"),
        String(err)
    );
    err = null;
    try {
        await run({
            edits: [{ file: f("a.ts"), ops: [{ find: "NOPE-NOPE", replace: "A" }] }],
            verbose: false,
            dryRun: true,
        });
    } catch (e) {
        err = e;
    }
    check(
        "a dry run with a MISS throws code 1 (default throwOnFailure)",
        err instanceof FableReplaceError && err.code === 1 && err.message.includes("dry run"),
        String(err)
    );
}

console.log("round 2: ops");
{
    const r = applyOps("/** a */\nx\n/** a */\ny\n", [{ kind: "deleteBlock", from: "/** a", to: " */\n" }]);
    check(
        "deleteBlock with a non-unique from anchor is a MISS naming the lines",
        r.results[0].status === "MISS" &&
            (r.results[0].reason ?? "").includes("occurs 2×") &&
            (r.results[0].reason ?? "").includes("lines 1, 3"),
        r.results[0].reason
    );
    const r2 = applyOps("/** a */\nx\n/** a */\ny\n", [
        { kind: "deleteBlock", from: "/** a", to: " */\n", occurrence: 2 },
    ]);
    check(
        "…unless occurrence is given",
        r2.results[0].status === "OK" && r2.content === "/** a */\nx\ny\n",
        stringifyJson(r2.content)
    );
    const r3 = applyOps("a\n        foo();\n", [{ kind: "insertLinesAfter", anchor: "    foo();", text: "bar();" }]);
    check(
        "an indented anchor must match at the start of a line",
        r3.results[0].status === "MISS" && (r3.results[0].reason ?? "").includes("never at the start of a line"),
        r3.results[0].reason
    );
    const r4 = applyOps("a\n    foo();\n", [
        { kind: "insertLinesAfter", anchor: "    foo();", text: "    foo();\n    bar();" },
    ]);
    check(
        "repeating the anchor inside the inserted text is flagged in the report",
        r4.results[0].status === "OK" &&
            r4.results[0].desc.includes("⚠") &&
            r4.results[0].desc.includes("KEEP the anchor"),
        r4.results[0].desc
    );
    const r5 = applyOps("x\nx\nx\n", [{ find: "x", replace: "y", count: 2 }]);
    check(
        "count mismatch lists the lines found",
        (r5.results[0].reason ?? "").includes("at line(s) 1, 2, 3"),
        r5.results[0].reason
    );
    const r6 = applyOps("a1 a2 a3", [{ kind: "regex", find: /a\d/g, replace: "b", expect: 2 }]);
    check(
        "regex expect mismatch lists the lines found",
        (r6.results[0].reason ?? "").includes("at line(s) 1, 1, 1"),
        r6.results[0].reason
    );
    const accented = "Doručená";
    check(
        "NFD vs NFC needle gets a normalization hint",
        nearestHint({ content: `${accented.normalize("NFC")}\n`, needle: accented.normalize("NFD") }).includes(
            "Unicode normalization"
        )
    );
}

console.log("round 2: recon and rename guards");
{
    fs.mkdirSync(f("r2/src"), { recursive: true });
    write("r2/src/lib.ts", "export const oldName = 1;\n");
    write("r2/src/use.ts", 'import { oldName } from "./lib";\nconsole.log(oldName);\n');
    write(
        "r2/src/wrap.ts",
        'import { oldName as base } from "./lib";\nconst oldName = () => base;\nexport { oldName };\n'
    );
    write("r2/README.md", "See oldName.\n");
    const viaFileRoot = findFiles({ roots: [f("r2/README.md"), f("r2/src")], containing: "oldName", exts: [] });
    check(
        "findFiles accepts a plain file as a root",
        viaFileRoot.includes(f("r2/README.md")) && viaFileRoot.length === 4,
        stringifyJson(viaFileRoot)
    );
    const split = shadowedFiles({
        files: [f("r2/src/lib.ts"), f("r2/src/use.ts"), f("r2/src/wrap.ts")],
        name: "oldName",
    });
    check(
        "shadowedFiles splits wrapper vs definer",
        split.shadows.length === 1 &&
            split.shadows[0].endsWith("wrap.ts") &&
            split.declarers.length === 1 &&
            split.declarers[0].endsWith("lib.ts")
    );
    let err: unknown = null;
    try {
        renameSymbolAcross({
            files: [f("r2/src/use.ts"), f("r2/src/wrap.ts")],
            oldName: "oldName",
            newName: "newName",
        });
    } catch (e) {
        err = e;
    }
    check(
        "renameSymbolAcross refuses a shadowing wrapper (code 2)",
        err instanceof FableReplaceError &&
            err.code === 2 &&
            err.message.includes("wrap.ts") &&
            err.message.includes("includeShadowed"),
        String(err)
    );
    const forced = renameSymbolAcross({
        files: [f("r2/src/wrap.ts")],
        oldName: "oldName",
        newName: "newName",
        includeShadowed: true,
    });
    check("…unless includeShadowed is passed", forced.length === 1);
}

console.log("round 2: rollback");
{
    write("r2-rb.ts", "ORIGINAL\n");
    const bd = path.join(tmp, "r2-bk");
    await run({
        edits: [{ file: f("r2-rb.ts"), ops: [{ find: "ORIGINAL", replace: "SWEPT" }] }],
        verbose: false,
        backupDir: bd,
    });
    const first = rollback({ backupDir: bd });
    const second = rollback({ backupDir: bd });
    check(
        "rolling back twice is a no-op, not drift",
        first.restored.length === 1 &&
            second.drifted.length === 0 &&
            second.restored.length === 1 &&
            read("r2-rb.ts") === "ORIGINAL\n",
        stringifyJson(second)
    );
}

console.log("round 2: spec parser");
{
    const edits = parseSpec({ text: "@@ a.md\n<<<\nx\n===\nline\n\\===\n\\>>>\nend\n>>>\n" });
    const op = edits[0].ops?.[0] as { replace: string };
    check("\\=== and \\>>> in a body are unescaped", op.replace === "line\n===\n>>>\nend", stringifyJson(op.replace));
    const tryParse = (text: string): string => {
        try {
            parseSpec({ text });
            return "";
        } catch (e) {
            return String(e);
        }
    };
    const extra = tryParse("@@ a.md\n<<<\nx\n===\ny\n===\nz\n>>>\n");
    check(
        "an extra === names ITS line, not the op line",
        extra.includes("spec line 6") && extra.includes("\\==="),
        extra
    );
    check(
        "a diff hunk header after a bare >>> is diagnosed",
        tryParse("@@ a.md\n<<<\nx\n===\ny\n>>>\n@@ -1,2 +1,2 @@\n").includes("diff hunk header")
    );
    check("count=0 is a spec error", tryParse("@@ a.md\n<<< count=0\nx\n===\ny\n>>>\n").includes("positive"));
    const badRx = tryParse("@@ a.md\n<<< regex\n(x\n===\ny\n>>>\n");
    check(
        "an invalid regex names the spec line",
        badRx.includes("spec line 2") && badRx.includes("invalid regex"),
        badRx
    );
    check(
        "invalid flags name the spec line",
        tryParse("@@ a.md\n<<< regex flags=q\nx\n===\ny\n>>>\n").includes("spec line 2")
    );
    const backspace = String.fromCharCode(8);
    check(
        "a control character in a body is a spec error with the printf hint",
        tryParse(`@@ a.md\n<<< regex\n${backspace}old\n===\ny\n>>>\n`).includes("printf")
    );
    const warnings: string[] = [];
    parseSpec({ text: "@@ a.md\n<<< after\nanchor\n===\n```ts\ncode\n>>>\n", onWarning: (m) => warnings.push(m) });
    check(
        "an unbalanced code fence warns about a bare >>>",
        warnings.length === 1 && warnings[0].includes("\\>>>"),
        stringifyJson(warnings)
    );
    const fragmentWarnings: string[] = [];
    parseSpec({
        text: "@@ doc.md\n<<< block\n# Old\n===\nold\n```\n===\n# New\n```sh\nnew\n```\n>>>\n",
        onWarning: (m) => fragmentWarnings.push(m),
    });
    parseSpec({ text: "@@ a.md\n<<<\n```sh\n===\n```bash\n>>>\n", onWarning: (m) => fragmentWarnings.push(m) });
    parseSpec({
        text: "@@ a.md\n<<< after\nanchor\n===\ncode\n```\n>>>\n",
        onWarning: (m) => fragmentWarnings.push(m),
    });
    check(
        "a closing fence in a block end-anchor, a fence-only body and a body ending on a fence do not warn",
        fragmentWarnings.length === 0,
        stringifyJson(fragmentWarnings)
    );
    const truncated: string[] = [];
    parseSpec({
        text: "@@ doc.md\n<<< block\n# Old\n===\nold\n```\n===\n# New\n```sh\nnew\n>>>\n",
        onWarning: (m) => truncated.push(m),
    });
    check(
        "a block whose last body ends inside an open fence still warns, naming the fence line",
        truncated.length === 1 && truncated[0].includes("opened at its line 2") && truncated[0].includes("\\>>>"),
        stringifyJson(truncated)
    );
}

console.log("round 2: cli");
{
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const dir = f("cli2");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "t.ts"), "const a = 1;\n");
    const runCli = (spec: string, ...args: string[]): { status: number | null; out: string } => {
        const p = spawnSync("bun", [cli, ...args], { cwd: dir, input: spec, encoding: "utf8", env: hermeticEnv });
        return { status: p.status, out: `${p.stdout}\n${p.stderr}` };
    };
    const typo = runCli("@@ t.ts\n<<<\nconst a = 1;\n===\nconst a = 2;\n>>>\n", "--dyr");
    check(
        "cli: an unknown flag exits 2 and writes nothing",
        typo.status === 2 && typo.out.includes('unknown argument "--dyr"') && read("cli2/t.ts") === "const a = 1;\n",
        typo.out
    );
    const dryMiss = runCli("@@ t.ts\n<<<\nconst zz = 1;\n===\nconst zz = 2;\n>>>\n", "--dry");
    check("cli: --dry with a MISS exits 1", dryMiss.status === 1 && dryMiss.out.includes("MISS"), dryMiss.out);
    const missing = runCli("", "--spec", path.join(dir, "nope.txt"));
    const noStdin = runCli("");
    check(
        "cli: empty stdin exits 2 and names the heredoc trap",
        noStdin.status === 2 && noStdin.out.includes("no spec on stdin") && noStdin.out.includes("heredoc"),
        noStdin.out
    );
    check(
        "cli: a missing --spec file is a clean SPEC ERROR, exit 2",
        missing.status === 2 && missing.out.includes("SPEC ERROR") && !missing.out.includes("    at "),
        missing.out
    );
    const real = runCli("@@ t.ts\n<<<\nconst a = 1;\n===\nconst a = 2;\n>>>\n");
    const bk = real.out.match(/Backed up 1 path\(s\) to (\S+)/)?.[1];
    check("cli: a real run prints its backup dir", real.status === 0 && bk !== undefined, real.out);
    const rb = runCli("", "--rollback", bk ?? "/nonexistent");
    check(
        "cli: --rollback restores from that dir",
        rb.status === 0 && read("cli2/t.ts") === "const a = 1;\n" && rb.out.includes("restored"),
        rb.out
    );
    const rbBad = runCli("", "--rollback", path.join(dir, "not-a-backup"));
    check(
        "cli: --rollback on a non-backup dir is a clean error, exit 2",
        rbBad.status === 2 && rbBad.out.includes("ROLLBACK ERROR"),
        rbBad.out
    );
    const api = spawnSync("bun", [cli, "--api"], { encoding: "utf8" });
    const apiLines = api.stdout.split("\n");
    check(
        "cli: --api has no duplicate entries and no function bodies",
        apiLines.filter((l) => l.startsWith("scratchDir = ")).length === 1 &&
            !api.stdout.includes("mkdtempSync") &&
            apiLines.length < 900,
        String(apiLines.length)
    );
    const apiQ = spawnSync("bun", [cli, "--api", "rollback"], { encoding: "utf8" });
    check(
        "cli: --api <query> narrows to matching names",
        apiQ.stdout.includes("rollback = (") && !apiQ.stdout.includes("interface LiteralOp"),
        apiQ.stdout.slice(0, 200)
    );
}

console.log("round 3: error payload and recon guards");
{
    write("rp-good.ts", "const a = 1;\n");
    write("rp-bad.ts", "const b = 2;\n");
    let caught: FableReplaceError | undefined;
    try {
        await run({
            edits: [
                { file: f("rp-good.ts"), ops: [{ find: "const a = 1;", replace: "const a = 9;" }] },
                { file: f("rp-bad.ts"), ops: [{ find: "NOT THERE", replace: "x" }] },
            ],
            partial: true,
        });
    } catch (e) {
        caught = e as FableReplaceError;
    }

    check("a partial failure throws with a report attached", caught?.report !== undefined, String(caught?.message));
    check(
        "the attached report carries missCount and written",
        caught?.report?.missCount === 1 && caught?.report?.written.length === 1 && caught?.report?.ok === false,
        stringifyJson({ miss: caught?.report?.missCount, written: caught?.report?.written.length })
    );

    let guarded = "";
    try {
        // The type says `containing` is required; a throwaway JS script can still omit it.
        (findFiles as unknown as (p: { roots: string[] }) => string[])({ roots: [tmp] });
    } catch (e) {
        guarded = String(e);
    }

    check("findFiles without `containing` throws instead of returning []", guarded.includes("is required"), guarded);
    check(
        "findFiles with `containing` still works",
        findFiles({ roots: [tmp], containing: "const a = 9;" }).length === 1
    );

    // A literal needle is a SUBSTRING match: less indentation than the file still matches
    // (and the file's own indentation survives), more indentation MISSes. SKILL.md says so;
    // this pins the asymmetry so the doc cannot drift away from the behaviour.
    write("ind.ts", "function g() {\n    const v = 1;\n}\n");
    const under = await run({
        edits: [{ file: f("ind.ts"), ops: [{ find: "  const v = 1;", replace: "  const v = 2;" }] }],
    });
    check(
        "an under-indented literal needle matches and keeps the file's indentation",
        under.ok && read("ind.ts") === "function g() {\n    const v = 2;\n}\n",
        stringifyJson(read("ind.ts"))
    );
    const over = await run({
        edits: [{ file: f("ind.ts"), ops: [{ find: "      const v = 2;", replace: "x" }] }],
    }).catch((e: FableReplaceError) => e);
    check(
        "an over-indented literal needle MISSes with the whitespace hint",
        read("ind.ts").includes("    const v = 2;"),
        String(over)
    );

    const apiCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const apiOut = spawnSync("bun", [apiCli, "--api", "rollback"], { encoding: "utf8" });
    check(
        "cli: --api names the import path, not just the defining file",
        apiOut.stdout.includes('from "') &&
            apiOut.stdout.includes("replace-utils") &&
            apiOut.stdout.includes("## backup-and-rollback.ts"),
        apiOut.stdout.split("\n").slice(0, 3).join(" | ")
    );

    // count=N used to re-search the MUTATED text, so a replacement containing the needle
    // wrapped the first hit twice, skipped the second, and still reported OK ×2 of 2.
    write("selfwrap.ts", "const a = oldName(1);\nconst b = oldName(2);\n");
    const wrapped = await run({
        edits: [{ file: f("selfwrap.ts"), ops: [{ find: "oldName", replace: "wrapper(oldName)", count: 2 }] }],
    });
    check(
        "count=N with a self-containing replacement hits each occurrence once",
        wrapped.ok && read("selfwrap.ts") === "const a = wrapper(oldName)(1);\nconst b = wrapper(oldName)(2);\n",
        stringifyJson(read("selfwrap.ts"))
    );

    // An empty `containing` matched every line/comment and wiped the file, reporting OK.
    const wipeLines = applyOps("a\nb\nc\n", [{ kind: "deleteLines", containing: "" } as unknown as Op]);
    check(
        "deleteLines with an empty `containing` refuses instead of wiping the file",
        wipeLines.content === "a\nb\nc\n" && wipeLines.results[0].status === "MISS",
        stringifyJson(wipeLines.results[0])
    );
    const wipeComments = applyOps("// keep\nx = 1; // also\n", [
        { kind: "dropComments", containing: "" } as unknown as Op,
    ]);
    check(
        "dropComments with an empty `containing` refuses instead of dropping all",
        wipeComments.content === "// keep\nx = 1; // also\n" && wipeComments.results[0].status === "MISS",
        stringifyJson(wipeComments.results[0])
    );

    // Inserted lines take the file's own line ending, so a CRLF file stays all-CRLF.
    const crlf = applyOps("line1\r\nline2\r\nline3\r\n", [
        { kind: "insertLinesAfter", anchor: "line2", text: "NEWLINE" } as unknown as Op,
    ]);
    check(
        "an insert into a CRLF file uses CRLF",
        crlf.content === "line1\r\nline2\r\nNEWLINE\r\nline3\r\n",
        stringifyJson(crlf.content)
    );
    const appended = applyOps("line1\r\n", [{ kind: "append", text: "tail" } as unknown as Op]);
    check(
        "an append to a CRLF file uses CRLF",
        appended.content === "line1\r\ntail\r\n",
        stringifyJson(appended.content)
    );

    // A restore blocked on ONE file used to abandon every later entry, leaving swept
    // content live. Each entry is now restored inside its own guard.
    write("st-a.ts", "const a = 1;\n");
    write("st-b.ts", "const b = 2;\n");
    write("st-c.ts", "const c = 3;\n");
    const strandDir = scratchDir("selftest-strand");
    await run({
        edits: [
            { file: f("st-a.ts"), ops: [{ find: "const a = 1;", replace: "const a = 100;" }] },
            { file: f("st-b.ts"), ops: [{ find: "const b = 2;", replace: "const b = 200;" }] },
            { file: f("st-c.ts"), ops: [{ find: "const c = 3;", replace: "const c = 300;" }] },
        ],
        backupDir: strandDir,
        verbose: false,
    });
    fs.chmodSync(f("st-b.ts"), 0o444);
    const strandReport = rollback({ backupDir: strandDir, force: true });
    check(
        "a rollback blocked on one file still restores the others",
        read("st-a.ts") === "const a = 1;\n" && read("st-c.ts") === "const c = 3;\n",
        `${read("st-a.ts")} | ${read("st-c.ts")}`
    );
    check(
        "the blocked file is named in the rollback report, not silently stranded",
        strandReport.failed.length === 1 &&
            strandReport.failed[0].file.endsWith("st-b.ts") &&
            read("st-b.ts") === "const b = 200;\n",
        stringifyJson(strandReport.failed)
    );
    fs.chmodSync(f("st-b.ts"), 0o644);

    // A rename used to write a fresh 644 file, dropping the executable bit.
    const modeSrc = write("mode-src.ts", "export const x = 1;\n");
    fs.chmodSync(modeSrc, 0o750);
    await run({
        edits: [
            {
                file: modeSrc,
                renameTo: f("mode-dst.ts"),
                ops: [{ find: "export const x = 1;", replace: "export const x = 2;" }],
            },
        ],
    });
    check(
        "renameTo carries the source file's permission bits",
        (fs.statSync(f("mode-dst.ts")).mode & 0o777) === 0o750,
        (fs.statSync(f("mode-dst.ts")).mode & 0o777).toString(8)
    );

    // Restoring a file that already matches the backup must be a no-op, not an mtime bump.
    const quietDir = scratchDir("selftest-quiet-rollback");
    write("quiet.ts", "const q = 1;\n");
    await run({
        edits: [{ file: f("quiet.ts"), ops: [{ find: "const q = 1;", replace: "const q = 2;" }] }],
        backupDir: quietDir,
    });
    rollback({ backupDir: quietDir });
    const mtimeAfterFirst = fs.statSync(f("quiet.ts")).mtimeMs;
    rollback({ backupDir: quietDir, force: true });
    check(
        "a second rollback does not touch a file already at its original content",
        fs.statSync(f("quiet.ts")).mtimeMs === mtimeAfterFirst,
        `${mtimeAfterFirst} vs ${fs.statSync(f("quiet.ts")).mtimeMs}`
    );

    const parseErr = (text: string): string => {
        try {
            parseSpec({ text });
            return "";
        } catch (e) {
            return String(e);
        }
    };

    // `label=` eats the rest of the line: a modifier written after it silently vanished and
    // the op ran as a plain literal, matching something unrelated and reporting OK.
    const swallowed = parseErr("@@ a.md\n<<< label=see ticket 123, regex flags=g\nfo+\n===\nMATCHED\n>>>\n");
    check(
        "a modifier absorbed by label= is a spec error",
        swallowed.includes("absorbed into the label") && swallowed.includes("spec line 2"),
        swallowed
    );
    check(
        "a quoted label keeps a modifier word as text",
        (
            parseSpec({ text: '@@ a.md\n<<< label="cleanup, regex noise"\nx\n===\ny\n>>>\n' })[0].ops?.[0] as {
                label?: string;
            }
        ).label === "cleanup, regex noise"
    );
    check(
        "label= last still works with a real modifier",
        (
            parseSpec({ text: "@@ a.md\n<<< regex flags=g label=free text\nx\n===\ny\n>>>\n" })[0].ops?.[0] as {
                kind?: string;
            }
        ).kind === "regex"
    );

    // A spec pasted from two sources carries CRLF on some lines only; splitting on "\n"
    // alone left "\r" on the markers and swallowed the next op into the previous body.
    const mixed = parseSpec({
        text: "@@ a.md\r\n<<<\r\nline one\r\n===\r\nline ONE\r\n>>>\r\n<<<\nline two\n===\nline TWO\n>>>\n",
    });
    check("a spec with mixed CRLF/LF keeps both ops", mixed[0].ops?.length === 2, stringifyJson(mixed[0].ops));

    check(
        "a marker spec starting with [ says so, naming line 1",
        parseErr("[legacy] old feature\n<<<\nfoo\n===\nbar\n>>>\n").includes('spec line 1: the spec starts with "["'),
        parseErr("[legacy] x\n")
    );

    fs.mkdirSync(f("a-dir"), { recursive: true });
    const dirErr = await run({ edits: [{ file: f("a-dir"), ops: [{ find: "x", replace: "y" }] }] }).catch(
        (e: FableReplaceError) => e
    );
    check(
        "a directory as a target is a pre-flight error, not a raw EISDIR",
        String(dirErr).includes("is a directory, not a file"),
        String(dirErr)
    );

    // readFileSync(…,"utf8") decodes lossily, so one stray cp1252 byte used to come back as
    // U+FFFD and get written into the file, far from the edit, reported as OK.
    fs.writeFileSync(f("latin1.txt"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x0a, 0x34, 0x92, 0x0a]));
    const beforeBytes = fs.readFileSync(f("latin1.txt"));
    const encErr = (await run({
        edits: [{ file: f("latin1.txt"), ops: [{ find: "needle", replace: "FOUND" }] }],
    }).catch((e: FableReplaceError) => e)) as FableReplaceError;
    const encReason = (encErr.report?.files ?? []).flatMap((file) => file.postConditionFailures).join(" ");
    check(
        "a file that is not valid UTF-8 is refused, not silently mangled",
        fs.readFileSync(f("latin1.txt")).equals(beforeBytes) && encReason.includes("not valid UTF-8"),
        encReason || String(encErr)
    );

    // The file is read once at plan time; a concurrent write between read and write used to
    // be overwritten silently, with the sweep still reporting OK.
    write("race.ts", "const r = 1;\n");
    check(
        "changedOnDisk is false while the file still holds what was read",
        !changedOnDisk({ abs: f("race.ts"), expected: "const r = 1;\n" })
    );
    fs.writeFileSync(f("race.ts"), "SOMEONE ELSE WROTE THIS\n");
    check("changedOnDisk catches a concurrent write", changedOnDisk({ abs: f("race.ts"), expected: "const r = 1;\n" }));
    check(
        "changedOnDisk treats a vanished file as changed",
        changedOnDisk({ abs: f("gone-forever.ts"), expected: "" })
    );
    const raceOk = await run({
        edits: [{ file: f("race.ts"), ops: [{ find: "SOMEONE ELSE WROTE THIS", replace: "SETTLED" }] }],
    });
    check("the guard does not break an ordinary sweep", raceOk.ok && read("race.ts") === "SETTLED\n", read("race.ts"));

    // Two sweeps racing into one backupDir: the loser used to overwrite the winner's
    // manifest, so its own files could never be rolled back while both reported success.
    const sharedDir = scratchDir("selftest-shared-backup");
    write("shareA.ts", "const a = 1;\n");
    write("shareB.ts", "const b = 1;\n");
    await run({
        edits: [{ file: f("shareA.ts"), ops: [{ find: "const a = 1;", replace: "const a = 2;" }] }],
        backupDir: sharedDir,
    });
    const sharedErr = await run({
        edits: [{ file: f("shareB.ts"), ops: [{ find: "const b = 1;", replace: "const b = 2;" }] }],
        backupDir: sharedDir,
        backupOverwrite: false,
    }).catch((e: FableReplaceError) => e);
    check(
        "a second sweep may not share a backup dir",
        sharedErr instanceof FableReplaceError && read("shareB.ts") === "const b = 1;\n",
        String(sharedErr)
    );
    const overwrote = await run({
        edits: [{ file: f("shareB.ts"), ops: [{ find: "const b = 1;", replace: "const b = 2;" }] }],
        backupDir: sharedDir,
        backupOverwrite: true,
    });
    check("backupOverwrite: true still works", overwrote.ok && read("shareB.ts") === "const b = 2;\n");
}

// ── scratch root and prune ──────────────────────────────────────────────────
console.log("scratchDir() root + pruneScratch()");
{
    const root = scratchRoot();
    const fresh = scratchDir("probe");
    check(
        "scratchDir lands under <tmp>/fable-replace/",
        fresh.startsWith(`${root}${path.sep}`) && path.basename(fresh).startsWith(`probe-${process.pid}-`),
        fresh
    );
    const age = (dir: string): string => {
        const then = new Date(Date.now() - 25 * 3600 * 1000);
        fs.utimesSync(dir, then, then);
        return dir;
    };
    const finished = (dir: string): string => {
        fs.writeFileSync(path.join(dir, "0000-x.ts"), "x".repeat(100));
        fs.writeFileSync(path.join(dir, "fable-replace-manifest.json"), "{}");
        return dir;
    };
    const oldWithManifest = age(finished(scratchDir("old")));
    const youngWithManifest = finished(scratchDir("young"));
    const oldNoManifest = scratchDir("scratch");
    fs.writeFileSync(path.join(oldNoManifest, "notes.txt"), "keep");
    age(oldNoManifest);
    const oldEmpty = age(scratchDir("empty"));
    const legacy = age(finished(fs.mkdtempSync(path.join(os.tmpdir(), "fable-replace-legacy-1-"))));
    const current = age(finished(scratchDir("current")));
    const foreignRoot = path.join(f("other-tmp"), "fable-replace");
    fs.mkdirSync(foreignRoot, { recursive: true });
    const foreign = age(finished(fs.mkdtempSync(path.join(foreignRoot, "old-"))));
    const report = pruneScratch({ keep: [current] });
    check("an old dir with a manifest is removed", !fs.existsSync(oldWithManifest));
    check("a young dir survives", fs.existsSync(youngWithManifest));
    check("an old dir without a manifest survives: not proven ours", fs.existsSync(oldNoManifest));
    check("an old empty dir is removed", !fs.existsSync(oldEmpty));
    check("a legacy fable-replace-* dir directly under the temp dir falls under the same gate", !fs.existsSync(legacy));
    check("the current run's dir survives even when old", fs.existsSync(current));
    check("the report counts what it removed", report.removed === 3 && report.bytes >= 200, stringifyJson(report));
    check(
        "the prune sweeps only the root this process writes to (TMPDIR), never another temp root",
        report.roots.length === 1 && report.roots[0] === scratchRoot() && fs.existsSync(foreign),
        stringifyJson(report.roots)
    );
    const many = Array.from({ length: 60 }, (_, i) => age(finished(scratchDir(`many${i}`))));
    const capped = pruneScratch({ keep: [current] });
    check(
        "at most 50 removals per run, the rest wait for the next one",
        capped.removed === 50 && many.filter((dir) => fs.existsSync(dir)).length === 10,
        String(capped.removed)
    );
    pruneScratch({ keep: [current] });
    fs.rmSync(current, { recursive: true, force: true });
}

// ── journal ─────────────────────────────────────────────────────────────────
console.log("cli.ts journal");
{
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const dir = f("journal");
    const home = f("journal-home");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const journalFile = path.join(home, ".genesis-tools", "fable-replace", "journal.jsonl");
    const runJ = (
        spec: string,
        env: Record<string, string>,
        ...args: string[]
    ): { status: number | null; out: string } => {
        const p = spawnSync("bun", [cli, ...args], {
            cwd: dir,
            input: spec,
            encoding: "utf8",
            env: { ...hermeticEnv, FABLE_REPLACE_HOME: home, ...env },
        });
        return { status: p.status, out: `${p.stdout}\n${p.stderr}` };
    };
    const lines = (): JournalEntry[] =>
        fs.existsSync(journalFile)
            ? fs
                  .readFileSync(journalFile, "utf8")
                  .split("\n")
                  .filter((line) => line.trim() !== "")
                  .map((line) => parseJson(line) as JournalEntry)
            : [];
    fs.writeFileSync(path.join(dir, "j.ts"), "const j = 1;\n");
    runJ("@@ j.ts\n<<<\nconst j = 1;\n===\nconst j = 2;\n>>>\n", {});
    runJ("@@ j.ts\n<<<\nconst nope = 1;\n===\nconst j = 3;\n>>>\n", {});
    runJ("@@ j.ts\n<<< wat\nx\n===\ny\n>>>\n", {});
    runJ("@@ j.ts\n<<<\nconst j = 2;\n===\nconst j = 3;\n>>>\n", {}, "--verify", "exit 0 | cat");
    runJ("@@ j.ts\n<<<\nconst j = 2;\n===\nconst j = 3;\n>>>\n", {}, "--verify", "exit 1");
    runJ("@@ j.ts\n<<<\nconst j = 3;\n===\nconst j = 4;\n>>>\n", {}, "--dry");
    const all = lines();
    const outcomes = all.map((e) => e.outcome);
    check(
        "one journal line per real run outcome, a written line before a verify, and nothing for --dry",
        stringifyJson(outcomes) ===
            stringifyJson(["ok", "miss", "spec-error", "pre-flight", "written", "verify-failed"]),
        stringifyJson(outcomes)
    );
    const miss = all[1];
    check(
        "a MISS line carries its reason, the spec size and a token estimate",
        miss?.missCount === 1 &&
            (miss.reasons?.[0] ?? "").includes("const nope") &&
            (miss.spec?.chars ?? 0) > 0 &&
            miss.tokensEst?.spec === Math.round((miss.spec?.chars ?? 0) / 3.7),
        stringifyJson(miss)
    );
    check(
        "a spec error line carries the parser message",
        all[2]?.specError?.includes("line 2") === true,
        stringifyJson(all[2])
    );
    const vf = all[5];
    check(
        "a verify-failed line carries the verdict, the write count and the backup dir",
        vf?.verify?.status === "fail" && vf.verify.exit === 1 && vf.backupDir !== undefined && vf.written === 1,
        stringifyJson(vf)
    );
    check(
        "the written line precedes the verify and names the same backup dir",
        all[4]?.outcome === "written" && all[4].backupDir === vf?.backupDir,
        stringifyJson(all[4])
    );
    check(
        "the spec text is saved beside the backup, never in the journal",
        vf?.backupDir !== undefined &&
            fs.readFileSync(path.join(vf.backupDir, "spec.frspec"), "utf8").includes("const j = 2;") &&
            !fs.readFileSync(journalFile, "utf8").includes("\\n===\\n")
    );
    check(
        "every line carries what was printed and how long it took",
        all.every((e) => (e.resultChars ?? 0) > 0 && (e.durationMs ?? -1) >= 0 && e.runId.length > 0),
        stringifyJson(all.map((e) => [e.outcome, e.resultChars, e.durationMs]))
    );
    runJ("", {}, "--rollback", vf?.backupDir ?? "/nonexistent");
    const rb = lines().at(-1);
    check(
        "a rollback is journaled with its counts",
        rb?.kind === "rollback" && rb.rollback?.restored === 1,
        stringifyJson(rb)
    );

    const history = runJ("", {}, "--history", "3");
    check(
        "--history prints the last N entries, one line each",
        history.status === 0 && history.out.split("\n").filter((line) => /^\d{4}-\d{2}-\d{2} /.test(line)).length === 3,
        history.out
    );
    const stats = runJ("", {}, "--stats", "1");
    check(
        "--stats prints counts, tokens and waste, and no dollar figure",
        stats.status === 0 &&
            stats.out.includes("runs, last 1 day(s): 5") &&
            !/^\s+written\s+\d+$/m.test(stats.out) &&
            stats.out.includes("chars ÷ 3.7") &&
            !stats.out.includes("$") &&
            stats.out.includes("wasted"),
        stats.out
    );

    const home2 = f("journal-home2");
    fs.mkdirSync(home2, { recursive: true });
    const noOverride = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== "FABLE_REPLACE_HOME")
    );
    spawnSync("bun", [cli], {
        cwd: dir,
        input: "@@ j.ts\n<<<\nconst nope = 1;\n===\nconst j = 9;\n>>>\n",
        encoding: "utf8",
        env: { ...noOverride, GENESIS_TOOLS_HOME: home2 },
    });
    check(
        "GENESIS_TOOLS_HOME is honoured when FABLE_REPLACE_HOME is unset",
        fs.existsSync(path.join(home2, ".genesis-tools", "fable-replace", "journal.jsonl"))
    );

    fs.writeFileSync(journalFile, "x".repeat(5 * 1024 * 1024 + 1));
    runJ("@@ j.ts\n<<<\nconst nope = 1;\n===\nconst j = 9;\n>>>\n", {});
    check(
        "the journal rotates once past 5 MB",
        fs.existsSync(path.join(home, ".genesis-tools", "fable-replace", "journal.1.jsonl")) &&
            fs.statSync(journalFile).size < 4096
    );

    const blocked = f("journal-blocked");
    fs.writeFileSync(blocked, "not a dir\n");
    const warned = runJ("@@ j.ts\n<<<\nconst nope = 1;\n===\nconst j = 9;\n>>>\n", { FABLE_REPLACE_HOME: blocked });
    check(
        "a journal that cannot be written warns and leaves the exit code alone",
        warned.status === 1 && warned.out.includes("journal: could not append"),
        warned.out.slice(-300)
    );

    const planted = scratchDir("planted");
    fs.writeFileSync(path.join(planted, "fable-replace-manifest.json"), "{}");
    const stale = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(planted, stale, stale);
    const linesBeforeDry = lines().length;
    runJ("@@ j.ts\n<<<\nconst j = 2;\n===\nconst j = 3;\n>>>\n", {}, "--dry");
    check(
        "a --dry run journals nothing and prunes nothing",
        lines().length === linesBeforeDry && fs.existsSync(planted),
        `${lines().length} vs ${linesBeforeDry}, planted exists=${fs.existsSync(planted)}`
    );

    const pruned = runJ("", {}, "--prune");
    check(
        "--prune reports what it swept and is journaled on its own line",
        pruned.status === 0 &&
            pruned.out.includes("pruned 1 ") &&
            !fs.existsSync(planted) &&
            lines().at(-1)?.kind === "prune",
        `${pruned.out} ${stringifyJson(lines().at(-1))}`
    );
}

// ── diagnostics: same-batch interference vs. a previous run (h_yvyxmctd) ─────
console.log("diagnostics: consumed needle vs. applied before");
{
    const twice = applyOps("const value = 1;\n", [
        { find: "const value = 1;", replace: "const value = 2;" },
        { find: "const value = 1;", replace: "const value = 2;" },
    ]);
    check(
        "a needle consumed by an earlier op of the batch is blamed on that op, not on a previous run",
        twice.results[0].status === "OK" &&
            twice.results[1].status === "MISS" &&
            (twice.results[1].reason ?? "").includes("op 1 of this batch") &&
            (twice.results[1].reason ?? "").includes("consumed") &&
            !(twice.results[1].reason ?? "").includes("optional"),
        twice.results[1].reason ?? ""
    );
    const before = applyOps("const value = 2;\n", [{ find: "const value = 1;", replace: "const value = 2;" }]);
    check(
        "a replacement that was on disk before the run keeps the re-run guidance",
        before.results[0].status === "MISS" && (before.results[0].reason ?? "").includes("applied before"),
        before.results[0].reason ?? ""
    );

    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const dir = f("handoff");
    fs.mkdirSync(dir, { recursive: true });
    const runH = (spec: string): { status: number | null; out: string } => {
        const p = spawnSync("bun", [cli], { cwd: dir, input: spec, encoding: "utf8", env: hermeticEnv });
        return { status: p.status, out: `${p.stdout}\n${p.stderr}` };
    };
    fs.writeFileSync(path.join(dir, "doc.md"), "# Old\n```sh\nold\n```\n");
    const fence = runH("@@ doc.md\n<<< block\n# Old\n===\nold\n```\n===\n# New\n```sh\nnew\n```\n>>>\n");
    check(
        "cli: a block replacement whose end anchor is a closing fence lands without a truncation warning",
        fence.status === 0 && !fence.out.includes("WARNING") && read("handoff/doc.md") === "# New\n```sh\nnew\n```\n",
        `${String(fence.status)} ${fence.out.slice(0, 300)}`
    );
    fs.writeFileSync(path.join(dir, "example.ts"), "const value = 1;\n");
    const dup = runH(
        "@@ example.ts\n<<<\nconst value = 1;\n===\nconst value = 2;\n>>>\n<<<\nconst value = 1;\n===\nconst value = 2;\n>>>\n"
    );
    check(
        "cli: a duplicate op aborts the batch, leaves the disk untouched and names the earlier op",
        dup.status === 1 &&
            dup.out.includes("op 1 of this batch") &&
            read("handoff/example.ts") === "const value = 1;\n",
        `${String(dup.status)} ${dup.out.slice(0, 400)}`
    );
}

// ── review round 1 (PR #371): backup reservation, created-file syntax, quoted undo ──
console.log("review round 1 regressions");
{
    write("race-a.ts", "const a = 1;\n");
    const raceDir = path.join(tmp, "race-backup");
    writeBackup({ dir: raceDir, files: [f("race-a.ts")] });
    const storedBefore = fs.readFileSync(path.join(raceDir, "0000-race-a.ts"), "utf8");
    const manifestBefore = fs.readFileSync(path.join(raceDir, "fable-replace-manifest.json"), "utf8");
    write("race-a.ts", "const a = 2;\n");
    let refused = "";
    try {
        writeBackup({ dir: raceDir, files: [f("race-a.ts")] });
    } catch (err) {
        refused = String(err);
    }
    check(
        "a second writer into one backup dir is refused before it copies, so the first snapshot is intact",
        refused.includes("another sweep is using it") &&
            fs.readFileSync(path.join(raceDir, "0000-race-a.ts"), "utf8") === storedBefore &&
            fs.readFileSync(path.join(raceDir, "fable-replace-manifest.json"), "utf8") === manifestBefore,
        refused
    );

    const badCreate = await run({
        edits: [{ file: f("bad-new.ts"), createWith: "const x = ;\n" }],
        verbose: false,
    }).catch((e: FableReplaceError) => e);
    check(
        "a created .ts file that does not parse is refused and not written",
        badCreate instanceof FableReplaceError &&
            badCreate.code === 1 &&
            (badCreate.report?.files[0]?.postConditionFailures ?? []).some((p) => p.includes("does not parse")) &&
            !fs.existsSync(f("bad-new.ts")),
        String(badCreate)
    );

    const spaceTmp = f("tmp with space");
    fs.mkdirSync(spaceTmp, { recursive: true });
    const spaceDir = f("space-cli");
    fs.mkdirSync(spaceDir, { recursive: true });
    fs.writeFileSync(path.join(spaceDir, "s.ts"), "const s = 1;\n");
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const red = spawnSync("bun", [cli, "--verify", "exit 1"], {
        cwd: spaceDir,
        input: "@@ s.ts\n<<<\nconst s = 1;\n===\nconst s = 2;\n>>>\n",
        encoding: "utf8",
        env: { ...hermeticEnv, TMPDIR: spaceTmp },
    });
    const quoted = `${red.stdout}\n${red.stderr}`.match(/--rollback "([^"]+)"/)?.[1];
    const undone =
        quoted === undefined
            ? null
            : spawnSync("bun", [cli, "--rollback", quoted], { cwd: spaceDir, encoding: "utf8", env: hermeticEnv });
    check(
        "the undo line quotes a backup path that contains a space, and that path restores",
        red.status === 3 &&
            quoted !== undefined &&
            quoted.includes(" ") &&
            undone?.status === 0 &&
            fs.readFileSync(path.join(spaceDir, "s.ts"), "utf8") === "const s = 1;\n",
        `${String(red.status)} ${quoted ?? "no quoted path"} ${undone?.stdout.slice(-200) ?? ""}`
    );
}

// ── review round 2 (PR #371, CodeRabbit + eve): --api dir decoding, CRLF block anchors, nthIndexOf, /g regexes,
// createWith on an existing file, the rollback guard and exit code ──
console.log("review round 2 (PR #371)");
check(
    "nthIndexOf walks non-overlapping, like countOccurrences",
    nthIndexOf({ haystack: "aaaa", needle: "aa", n: 2 }) === 2
);
check(
    "nthIndexOf: no 3rd non-overlapping occurrence",
    nthIndexOf({ haystack: "aaaa", needle: "aa", n: 3 }) === -1 && countOccurrences("aaaa", "aa") === 2
);
{
    const crlf = "keep\r\n/**\r\n * junk\r\n * junk2\r\n */\r\nrest\r\n";
    const r = applyOps(crlf, [dropJsdocStarting({ fromPrefix: "/**\n * junk" })]);
    check(
        "dropJsdocStarting lands on a CRLF file",
        r.results[0].status === "OK" && r.content === "keep\r\nrest\r\n",
        r.results[0].reason ?? stringifyJson(r.content)
    );
    const lf = applyOps("keep\n/**\n * junk\n */\nrest\n", [dropJsdocStarting({ fromPrefix: "/**\n * junk" })]);
    check("dropJsdocStarting on an LF file is unchanged", lf.content === "keep\nrest\n");
    const mixed = applyOps("a\nSTART\nx\nEND\nb\r\n", [{ kind: "deleteBlock", from: "START\n", to: "END\n" }]);
    check(
        "an LF anchor that exists literally in a mixed-ending file is still preferred",
        mixed.content === "a\nb\r\n",
        mixed.results[0].reason ?? stringifyJson(mixed.content)
    );
}
fs.mkdirSync(f("g-rx"), { recursive: true });
write("g-rx/one.ts", "needle();\nneedle();\n");
write("g-rx/two.ts", "needle();\n");
check(
    "findFiles with a /g regex keeps every matching file",
    findFiles({ roots: [f("g-rx")], containing: /needle/g }).length === 2
);
check(
    "grepPreview with a /g regex counts every matching line",
    grepPreview({ files: [f("g-rx/one.ts")], pattern: /needle/g, context: 0 }) === 2
);
{
    const existing = write("exists.ts", "const keep = 1;\n");
    let refused: FableReplaceError | undefined;
    try {
        await run({ edits: [{ file: existing, createWith: "const other = 2;\n" }], verbose: false });
    } catch (err) {
        refused = err instanceof FableReplaceError ? err : undefined;
    }
    check(
        "run(): createWith on an existing file is refused by the runner (code 1, nothing written)",
        refused?.code === 1 &&
            refused.report?.files[0]?.postConditionFailures[0]?.includes("refuses to overwrite") === true &&
            read("exists.ts") === "const keep = 1;\n",
        String(refused?.message)
    );
}
{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const spaced = f("dir with space/scripts");
    fs.mkdirSync(spaced, { recursive: true });
    for (const name of fs.readdirSync(here)) {
        if (name.endsWith(".ts")) {
            fs.copyFileSync(path.join(here, name), path.join(spaced, name));
        }
    }
    const api = spawnSync("bun", [path.join(spaced, "cli.ts"), "--api", "run"], { encoding: "utf8", env: hermeticEnv });
    const count = Number(api.stdout.match(/fable-replace API — (\d+) entr/)?.[1] ?? -1);
    check(
        "--api from a directory whose path contains a space still lists the modules",
        api.status === 0 && count > 0,
        `${String(api.status)} ${api.stdout.slice(0, 200)} ${api.stderr.slice(0, 200)}`
    );
}

{
    const a = write("rb-dir-a.ts", "const a = 1;\n");
    const b = write("rb-dir-b.ts", "const b = 1;\n");
    const backupDir = scratchDir("rb-dir");
    await run({
        edits: [
            { file: a, ops: [{ find: "= 1", replace: "= 2" }] },
            { file: b, ops: [{ find: "= 1", replace: "= 2" }] },
        ],
        backupDir,
        verbose: false,
    });
    fs.rmSync(a);
    fs.mkdirSync(a);
    const partial = rollback({ backupDir });
    check(
        "rollback: a path that became a directory lands in report.failed and the later entry is still restored",
        partial.failed.length === 1 &&
            partial.failed[0].file === a &&
            partial.restored.includes(b) &&
            read("rb-dir-b.ts") === "const b = 1;\n",
        stringifyJson(partial)
    );
}
{
    const cliDir = f("rb-cli");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, "r.ts"), "const r = 1;\n");
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const swept = spawnSync("bun", [cli], {
        cwd: cliDir,
        input: "@@ r.ts\n<<<\nconst r = 1;\n===\nconst r = 2;\n>>>\n",
        encoding: "utf8",
        env: hermeticEnv,
    });
    const backupDir = `${swept.stdout}\n${swept.stderr}`.match(/Backed up 1 path\(s\) to (.+)/)?.[1]?.trim();
    fs.chmodSync(path.join(cliDir, "r.ts"), 0o444);
    const blocked =
        backupDir === undefined
            ? null
            : spawnSync("bun", [cli, "--rollback", backupDir], { cwd: cliDir, encoding: "utf8", env: hermeticEnv });
    fs.chmodSync(path.join(cliDir, "r.ts"), 0o644);
    const retried =
        backupDir === undefined
            ? null
            : spawnSync("bun", [cli, "--rollback", backupDir], { cwd: cliDir, encoding: "utf8", env: hermeticEnv });
    check(
        "cli --rollback exits 1 while a file could not be restored, then 0 once the cause is fixed",
        swept.status === 0 &&
            backupDir !== undefined &&
            blocked?.status === 1 &&
            blocked.stderr.includes("COULD NOT RESTORE") &&
            retried?.status === 0 &&
            fs.readFileSync(path.join(cliDir, "r.ts"), "utf8") === "const r = 1;\n",
        `${String(swept.status)} ${backupDir ?? "no backup dir"} ${String(blocked?.status)} ${String(retried?.status)}`
    );
}

// ── review round 3 (PR #371, eve): empty anchors, a recovery that restores only what it wrote, hash failures on the
// written path, inline comment removal that keeps tokens apart, tokens instead of dollars ──
console.log("review round 3 (PR #371)");
{
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const hangDir = f("empty-anchor");
    fs.mkdirSync(hangDir, { recursive: true });
    fs.writeFileSync(path.join(hangDir, "e.ts"), "const e = 1;\n");
    const markers = spawnSync("bun", [cli], {
        cwd: hangDir,
        input: "@@ e.ts\n<<< after\n===\nconst added = 2;\n>>>\n",
        encoding: "utf8",
        env: hermeticEnv,
        timeout: 20_000,
    });
    check(
        "cli: an empty after/before anchor is a spec error, not a hang",
        markers.status === 2 && markers.stderr.includes("anchor") && !markers.stdout.includes("Wrote"),
        `${String(markers.status)} ${markers.signal ?? ""} ${markers.stderr.slice(0, 200)}`
    );
    const json = spawnSync("bun", [cli], {
        cwd: hangDir,
        input: stringifyJson([
            { file: "e.ts", ops: [{ kind: "insertLinesAfter", anchor: "", text: "const added = 2;" }] },
        ]),
        encoding: "utf8",
        env: hermeticEnv,
        timeout: 20_000,
    });
    check(
        "cli (JSON form): an empty anchor reaches the runner and is a MISS, not a hang",
        json.status === 1 &&
            json.stdout.includes("anchor is empty") &&
            fs.readFileSync(path.join(hangDir, "e.ts"), "utf8") === "const e = 1;\n",
        `${String(json.status)} ${json.signal ?? ""} ${json.stdout.slice(-300)}`
    );
    const block = applyOps("a\nb\n", [{ kind: "deleteBlock", from: "", to: "b" }]);
    const inline = applyOps("a\nb\n", [{ kind: "insertAfter", anchor: "", text: "x" }]);
    check(
        "api: empty block and same-line anchors are a MISS instead of landing at offset 0",
        block.results[0].status === "MISS" &&
            block.content === "a\nb\n" &&
            inline.results[0].status === "MISS" &&
            inline.content === "a\nb\n",
        `${block.results[0].reason ?? ""} | ${inline.results[0].reason ?? ""}`
    );
}
{
    const a = write("only-a.ts", "const a = 1;\n");
    const b = write("only-b.ts", "const b = 1;\n");
    const onlyDir = scratchDir("only");
    await run({
        edits: [
            { file: a, ops: [{ find: "= 1", replace: "= 2" }] },
            { file: b, ops: [{ find: "= 1", replace: "= 2" }] },
        ],
        backupDir: onlyDir,
        verbose: false,
    });
    const partial = rollback({ backupDir: onlyDir, only: [a] });
    check(
        "rollback({ only }) restores the listed path and leaves the others alone and unreported",
        read("only-a.ts") === "const a = 1;\n" &&
            read("only-b.ts") === "const b = 2;\n" &&
            partial.restored.length === 1 &&
            !partial.restored.includes(b),
        stringifyJson(partial)
    );
}
{
    for (let i = 0; i < 4; i += 1) {
        write(`rec${i}.ts`, `const v${i} = "old";\n`);
    }
    fs.chmodSync(f("rec2.ts"), 0o444);
    let message = "";
    try {
        await run({
            edits: [0, 1, 2, 3].map((i) => ({ file: f(`rec${i}.ts`), ops: [{ find: `"old"`, replace: `"new"` }] })),
            verbose: false,
            backupDir: scratchDir("recover"),
        });
    } catch (err) {
        message = err instanceof Error ? err.message : String(err);
    }
    fs.chmodSync(f("rec2.ts"), 0o644);
    check(
        "a failed write restores what this sweep wrote and reports the later files as never touched",
        message.includes("write failed after 2 file(s)") &&
            message.includes("1 later file(s) were never touched") &&
            [0, 1, 2, 3].every((i) => read(`rec${i}.ts`).includes(`"old"`)),
        message
    );
}
{
    const hashed = write("hash-a.ts", "const h = 1;\n");
    const hashDir = scratchDir("hash");
    const moved = f("hash-a.moved.ts");
    const report = await run({
        edits: [{ file: hashed, ops: [{ find: "= 1", replace: "= 2" }] }],
        backupDir: hashDir,
        verbose: false,
        verifyCommand: `mv "${hashed}" "${moved}" && mkdir "${hashed}"`,
    });
    const undone = rollback({ backupDir: hashDir });
    check(
        "a verify that turned a tracked path into a directory: the run stays green, the hash is skipped, the rollback names the path",
        report.ok && report.verify?.status === "pass" && undone.failed.length === 1 && undone.failed[0].file === hashed,
        stringifyJson({ ok: report.ok, verify: report.verify?.status, failed: undone.failed })
    );
    fs.rmSync(hashed, { recursive: true, force: true });
    fs.renameSync(moved, hashed);
}
{
    const manifestFile = write("manifest-a.ts", "const m = 1;\n");
    const manifestDir = scratchDir("manifest");
    const manifestPath = path.join(manifestDir, "fable-replace-manifest.json");
    let failure: FableReplaceError | undefined;
    try {
        await run({
            edits: [{ file: manifestFile, ops: [{ find: "= 1", replace: "= 2" }] }],
            backupDir: manifestDir,
            verbose: false,
            verifyCommand: `chmod 444 "${manifestPath}"`,
        });
    } catch (err) {
        failure = err instanceof FableReplaceError ? err : undefined;
    }
    fs.chmodSync(manifestPath, 0o644);
    check(
        "a manifest the disk refuses after the write is a code-3 written-sweep failure carrying the report and backup dir",
        failure?.code === 3 &&
            failure.message.includes("backup manifest not updated") &&
            failure.report?.backupDir === manifestDir &&
            read("manifest-a.ts") === "const m = 2;\n",
        `${String(failure?.code)} ${failure?.message ?? "no error"}`
    );
}
{
    const keep = (src: string): string => dropComments(src, { containing: "legacy" }).content;
    check("inline comment removal keeps tokens apart", keep("return/*legacy*/value;\n") === "return value;\n");
    check(
        "inline comment removal never forms ++ or a line comment",
        keep("a +/*legacy*/+b; x/*legacy*//y;\n") === "a + +b; x /y;\n"
    );
    check(
        "inline comment removal adds nothing beside brackets and commas",
        keep("f(/*legacy*/a,/*legacy*/b);\n") === "f(a,b);\n"
    );
}

// ── review round 4 (PR #371, eve): absolute manifest paths under a relative --cwd, empty fuzzy and regex needles,
// identifier boundaries and literal dollar names in renames ──
console.log("review round 4 (PR #371)");
{
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const parent = f("relcwd");
    fs.mkdirSync(path.join(parent, "sub"), { recursive: true });
    fs.writeFileSync(path.join(parent, "sub", "r.ts"), "const r = 1;\n");
    const swept = spawnSync("bun", [cli, "--cwd", "sub"], {
        cwd: parent,
        input: "@@ r.ts\n<<<\nconst r = 1;\n===\nconst r = 2;\n>>>\n",
        encoding: "utf8",
        env: hermeticEnv,
    });
    const backupDir = `${swept.stdout}\n${swept.stderr}`.match(/Backed up 1 path\(s\) to (.+)/)?.[1]?.trim();
    const elsewhere = f("relcwd-elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    const undone =
        backupDir === undefined
            ? null
            : spawnSync("bun", [cli, "--rollback", backupDir], { cwd: elsewhere, encoding: "utf8", env: hermeticEnv });
    check(
        "a relative --cwd records absolute paths, so the printed undo works from any directory",
        swept.status === 0 &&
            undone?.status === 0 &&
            fs.readFileSync(path.join(parent, "sub", "r.ts"), "utf8") === "const r = 1;\n" &&
            !fs.existsSync(path.join(elsewhere, "sub")),
        `${String(swept.status)} ${backupDir ?? "no backup dir"} ${String(undone?.status)} ${undone?.stdout.slice(-200) ?? ""}`
    );
}
{
    const blankFuzzy = applyOps("abc", [{ kind: "fuzzy", find: "  \n ", replace: "x", count: "all" }]);
    const emptyRegex = applyOps("abc", [{ kind: "regex", find: /(?:)/, replace: "x" }]);
    check(
        "api: a blank fuzzy needle and an empty regex are a MISS instead of matching between every character",
        blankFuzzy.results[0].status === "MISS" &&
            blankFuzzy.content === "abc" &&
            emptyRegex.results[0].status === "MISS" &&
            emptyRegex.content === "abc",
        `${blankFuzzy.results[0].reason ?? ""} | ${emptyRegex.results[0].reason ?? ""}`
    );
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const dir = f("blank-needle");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "n.ts"), "const n = 1;\n");
    const blank = spawnSync("bun", [cli], {
        cwd: dir,
        input: "@@ n.ts\n<<< fuzzy\n   \n===\nconst n = 2;\n>>>\n",
        encoding: "utf8",
        env: hermeticEnv,
        timeout: 20_000,
    });
    check(
        "cli: a whitespace-only fuzzy body is a spec error and nothing is written",
        blank.status === 2 &&
            blank.stderr.includes("first body is empty") &&
            fs.readFileSync(path.join(dir, "n.ts"), "utf8") === "const n = 1;\n",
        `${String(blank.status)} ${blank.stderr.slice(0, 200)}`
    );
}
{
    const r = applyOps("foo(); $foo(); foo$(); a$foo; foo;", [
        renameSymbol({ oldName: "foo", newName: "bar", expect: 2 }),
    ]);
    check(
        "renameSymbol stops at $ on either side",
        r.content === "bar(); $foo(); foo$(); a$foo; bar;",
        r.results[0].reason ?? r.content
    );
    const dollar = applyOps("const $foo = 1; use($foo);", [
        renameSymbol({ oldName: "$foo", newName: "$$foo", expect: 2 }),
    ]);
    check(
        "renameSymbol matches a $-name and writes a $$-name literally",
        dollar.content === "const $$foo = 1; use($$foo);",
        dollar.results[0].reason ?? dollar.content
    );
    fs.mkdirSync(f("dollar"), { recursive: true });
    write("dollar/d.ts", "foo(); $foo(); foo$();\n");
    const counts = countMatches({ files: [f("dollar/d.ts")], pattern: "foo", quiet: true });
    check(
        "countMatches uses the same identifier boundary as the rename",
        counts[f("dollar/d.ts")] === 1,
        stringifyJson(counts)
    );
}

// ── review round 5 (PR #371, eve): an empty substring beside a regex, exclusive creates at the write, the barrel
// exports everything --api lists ──
console.log("review round 5 (PR #371)");
{
    const lines = applyOps("a\nDEBUG b\nc\n", [{ kind: "deleteLines", containing: "", matching: /DEBUG/ }]);
    check(
        "deleteLines: an empty substring beside a regex deletes only the regex hits",
        lines.results[0].status === "OK" && lines.content === "a\nc\n",
        `${lines.results[0].reason ?? ""} ${stringifyJson(lines.content)}`
    );
    const dropped = dropComments("// keep\nx(); // drop me\n", { containing: "", matching: /drop/ });
    check(
        "dropComments: an empty substring beside a regex drops only the regex hits",
        dropped.dropped === 1 && dropped.content === "// keep\nx();\n",
        stringifyJson(dropped)
    );
    check(
        "dropComments: an empty substring alone is no predicate",
        dropComments("// a\n// b\n", { containing: "" }).dropped === 0
    );
}
{
    const link = f("create-link.ts");
    fs.symlinkSync(f("create-link-target.ts"), link);
    let failure = "";
    try {
        await run({
            edits: [{ file: link, createWith: "export const late = 1;\n" }],
            verbose: false,
            backupDir: scratchDir("wx"),
        });
    } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
    }
    check(
        "a create target that exists at write time (a dangling symlink the plan cannot see) is refused with EEXIST, never truncated, and survives the recovery",
        failure.includes("EEXIST") && fs.lstatSync(link).isSymbolicLink() && !fs.existsSync(f("create-link-target.ts")),
        failure
    );
    const src = write("mv-src.ts", "const mv = 1;\n");
    const dest = f("mv-dest.ts");
    fs.symlinkSync(f("mv-dest-target.ts"), dest);
    let renameFailure = "";
    try {
        await run({
            edits: [{ file: src, ops: [{ find: "= 1", replace: "= 2" }], renameTo: dest }],
            verbose: false,
            backupDir: scratchDir("wx-mv"),
        });
    } catch (err) {
        renameFailure = err instanceof Error ? err.message : String(err);
    }
    check(
        "a rename target that exists at write time is refused and the source keeps its content",
        renameFailure.includes("EEXIST") &&
            read("mv-src.ts") === "const mv = 1;\n" &&
            fs.lstatSync(dest).isSymbolicLink(),
        renameFailure
    );
}
{
    const here = path.dirname(fileURLToPath(import.meta.url));
    const barrelSource = fs.readFileSync(path.join(here, "replace-utils.ts"), "utf8");
    const notExported = collectApi(here)
        .filter((entry) => {
            const mod = `./${entry.module.replace(/\.ts$/, "")}`;
            if (!/^(interface|type|class) /.test(entry.signature)) {
                return !(entry.name in barrel);
            }

            const star = barrelSource.includes(`export * from "${mod}"`);
            const typed = new RegExp(`export type \\{[^}]*\\b${entry.name}\\b[^}]*\\} from "${mod}"`).test(
                barrelSource
            );
            return !(star || typed);
        })
        .map((entry) => `${entry.module}:${entry.name}`);
    check(
        "every symbol --api lists is importable from the barrel it names",
        notExported.length === 0,
        notExported.join(", ")
    );
}

// ── review round 6 (PR #371, eve): a delete checks drift, an exclusive create is tracked from its descriptor,
// createWith "" is an empty file ──
console.log("review round 6 (PR #371)");
{
    const hlA = write("hl-a.ts", "const hl = 1;\n");
    const hlB = f("hl-b.ts");
    fs.linkSync(hlA, hlB);
    let message = "";
    try {
        await run({
            edits: [
                { file: hlA, ops: [{ find: "= 1", replace: "= 2" }] },
                { file: hlB, delete: true },
            ],
            verbose: false,
            backupDir: scratchDir("hl"),
        });
    } catch (err) {
        message = err instanceof Error ? err.message : String(err);
    }
    check(
        "a delete refuses a file whose bytes changed after planning (a hard link the earlier write altered) and the recovery keeps it",
        message.includes("refusing to delete") && fs.existsSync(hlB) && read("hl-a.ts") === "const hl = 1;\n",
        message
    );
}
{
    const c = write("wx-c.ts", "const c = 1;\n");
    fs.chmodSync(c, 0o444);
    const b = f("wx-b.ts");
    let late = "";
    try {
        await run({
            edits: [
                { file: b, createWith: "export const b = 1;\n" },
                { file: c, ops: [{ find: "= 1", replace: "= 2" }] },
            ],
            verbose: false,
            backupDir: scratchDir("wx-late"),
        });
    } catch (err) {
        late = err instanceof Error ? err.message : String(err);
    }
    fs.chmodSync(c, 0o644);
    check(
        "a file created exclusively before a later write failed is removed by the recovery",
        late.includes("write failed after 1 file(s)") && !fs.existsSync(b) && read("wx-c.ts") === "const c = 1;\n",
        late
    );
    const big = f("wx-big.txt");
    await run({ edits: [{ file: big, createWith: "x".repeat(3_000_000) }], verbose: false });
    check("an exclusive create writes every byte through the descriptor", fs.statSync(big).size === 3_000_000);
}
{
    const empty = f("empty.txt");
    await run({ edits: [{ file: empty, createWith: "" }], verbose: false });
    check('createWith "" creates an empty file', fs.existsSync(empty) && fs.statSync(empty).size === 0);
    let refused: FableReplaceError | undefined;
    try {
        await run({ edits: [{ file: f("both.ts"), delete: true, createWith: "" }], verbose: false });
    } catch (err) {
        refused = err instanceof FableReplaceError ? err : undefined;
    }
    check(
        'delete:true with createWith "" is refused as a contradiction',
        refused?.code === 2 && refused.message.includes("cannot be combined"),
        String(refused?.message)
    );
}

// ── review round 7 (PR #371, eve): protected rename destinations, modifiers a kind does not enforce, the dry-run
// diff of a created file ──
console.log("review round 7 (PR #371)");
{
    const src = write("mv-guard-src.ts", "const g = 1;\n");
    let intoNodeModules: FableReplaceError | undefined;
    try {
        await run({
            edits: [{ file: src, ops: [{ find: "= 1", replace: "= 2" }], renameTo: f("node_modules/pkg/g.ts") }],
            verbose: false,
        });
    } catch (err) {
        intoNodeModules = err instanceof FableReplaceError ? err : undefined;
    }
    check(
        "a rename into node_modules is refused in pre-flight",
        intoNodeModules?.code === 2 &&
            intoNodeModules.message.includes("node_modules") &&
            read("mv-guard-src.ts") === "const g = 1;\n",
        String(intoNodeModules?.message)
    );
    const generated = write(
        "mv-guard-gen.ts",
        "// This file was automatically generated by a tool.\n// You should NOT make any changes in this file.\nexport const routes = 1;\n"
    );
    let ontoGenerated: FableReplaceError | undefined;
    try {
        await run({
            edits: [{ file: src, ops: [{ find: "= 1", replace: "= 2" }], renameTo: generated, overwrite: true }],
            verbose: false,
        });
    } catch (err) {
        ontoGenerated = err instanceof FableReplaceError ? err : undefined;
    }
    check(
        "a rename onto a generated file is refused without allowGenerated",
        ontoGenerated?.code === 2 &&
            ontoGenerated.message.includes("GENERATED") &&
            read("mv-guard-gen.ts").includes("routes = 1"),
        String(ontoGenerated?.message)
    );
    await run({
        edits: [
            {
                file: src,
                ops: [{ find: "= 1", replace: "= 2" }],
                renameTo: generated,
                overwrite: true,
                allowGenerated: true,
            },
        ],
        verbose: false,
    });
    check(
        "allowGenerated lets the rename replace it",
        read("mv-guard-gen.ts") === "const g = 2;\n" && !fs.existsSync(src)
    );
}
{
    const parseError = (text: string): string => {
        try {
            parseSpec({ text });
            return "";
        } catch (err) {
            return err instanceof Error ? err.message : String(err);
        }
    };
    check(
        "count= on a block is a spec error",
        parseError("@@ a.md\n<<< block count=2\nA\n===\nB\n===\n>>>\n").includes("count= is not enforced")
    );
    check(
        "count= on after is a spec error",
        parseError("@@ a.md\n<<< after count=1\nA\n===\nB\n>>>\n").includes("count= is not enforced")
    );
    check(
        "flags= outside regex is a spec error",
        parseError("@@ a.md\n<<< fuzzy flags=g\nA\n===\nB\n>>>\n").includes("flags= only applies to regex")
    );
    check(
        "optional on append is a spec error",
        parseError("@@ a.md\n<<< append optional\nA\n>>>\n").includes("optional has no meaning")
    );
    check("count= on delete still parses", parseError("@@ a.md\n<<< delete count=2\nA\n>>>\n") === "");
}
{
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const dir = f("dry-create");
    fs.mkdirSync(dir, { recursive: true });
    const dry = spawnSync("bun", [cli, "--dry"], {
        cwd: dir,
        input: "@@ fresh.ts\n<<< create\nexport const fresh = 1;\n>>>\n",
        encoding: "utf8",
        env: hermeticEnv,
    });
    check(
        "--dry shows the whole content of a created file as additions",
        dry.status === 0 &&
            dry.stdout.includes("+ export const fresh = 1;") &&
            !fs.existsSync(path.join(dir, "fresh.ts")),
        `${String(dry.status)} ${dry.stdout.slice(-300)}`
    );
    const withOps = spawnSync("bun", [cli, "--dry"], {
        cwd: dir,
        input: "@@ made.ts\n<<< create\nconst seed = 1;\n>>>\n<<<\nseed = 1\n===\nseed = 2\n>>>\n",
        encoding: "utf8",
        env: hermeticEnv,
    });
    check(
        "--dry shows a created-with-ops file against the empty baseline",
        withOps.status === 0 &&
            withOps.stdout.includes("+ const seed = 2;") &&
            !withOps.stdout.includes("- const seed = 1;"),
        `${String(withOps.status)} ${withOps.stdout.slice(-300)}`
    );
}

// ── review round 8 (PR #371, eve): delete bodies anchor to a line start, a rename is syntax-checked as its
// destination ──
console.log("review round 8 (PR #371)");
{
    const mid = applyOps("notfoo\nfoo\n", [{ find: "foo\n", replace: "", wholeLines: true }]);
    check(
        "wholeLines: a needle inside a line is not a match, the line-start one is",
        mid.results[0].status === "OK" && mid.content === "notfoo\n",
        mid.results[0].reason ?? mid.content
    );
    const only = applyOps("notfoo\n", [{ find: "foo\n", replace: "", wholeLines: true }]);
    check(
        "wholeLines: a suffix-only occurrence is a MISS that says so",
        only.results[0].status === "MISS" &&
            only.content === "notfoo\n" &&
            (only.results[0].reason ?? "").includes("start of a line"),
        only.results[0].reason ?? ""
    );
    const multi = applyOps("xfoo\nbar\nfoo\nbar\n", [{ find: "foo\nbar\n", replace: "", wholeLines: true }]);
    check(
        "wholeLines: a multi-line body cannot start halfway through a line",
        multi.results[0].status === "OK" && multi.content === "xfoo\nbar\n",
        multi.results[0].reason ?? multi.content
    );
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const dir = f("delete-lines");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "d.ts"), "const notfoo = 1;\nfoo\nconst b = 2;\n");
    const del = spawnSync("bun", [cli], {
        cwd: dir,
        input: "@@ d.ts\n<<< delete\nfoo\n>>>\n",
        encoding: "utf8",
        env: hermeticEnv,
    });
    check(
        "cli: <<< delete removes the whole line and never a suffix",
        del.status === 0 && fs.readFileSync(path.join(dir, "d.ts"), "utf8") === "const notfoo = 1;\nconst b = 2;\n",
        `${String(del.status)} ${del.stdout.slice(-200)}`
    );
}
{
    const words = write("note.txt", "just words, not code\n");
    let refused: FableReplaceError | undefined;
    try {
        await run({ edits: [{ file: words, renameTo: f("note.ts") }], verbose: false });
    } catch (err) {
        refused = err instanceof FableReplaceError ? err : undefined;
    }
    check(
        "a rename-only edit to .ts is checked under the destination loader",
        refused?.code === 1 &&
            refused.report?.files[0]?.postConditionFailures[0]?.includes("does not parse as .ts") === true &&
            fs.existsSync(words) &&
            !fs.existsSync(f("note.ts")),
        String(refused?.message)
    );
    const view = write("view.tsx", "export const view = <div />;\n");
    let jsx: FableReplaceError | undefined;
    try {
        await run({ edits: [{ file: view, renameTo: f("view.ts") }], verbose: false });
    } catch (err) {
        jsx = err instanceof FableReplaceError ? err : undefined;
    }
    check(
        "a .tsx holding JSX renamed to .ts is refused",
        jsx?.code === 1 &&
            jsx.report?.files[0]?.postConditionFailures[0]?.includes("does not parse as .ts") === true &&
            fs.existsSync(view),
        String(jsx?.message)
    );
    const plain = write("ok.txt", "export const ok = 1;\n");
    await run({ edits: [{ file: plain, renameTo: f("ok.ts") }], verbose: false });
    check("a .txt holding valid TypeScript renames to .ts", fs.existsSync(f("ok.ts")) && !fs.existsSync(plain));
}

// ── review round 9 (PR #371, eve): an unknown op kind is refused at both doors, dropComments enforces expect
// itself ──
console.log("review round 9 (PR #371)");
{
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const dir = f("bad-kind");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "j.ts"), "const old = 1;\n");
    const bad = spawnSync("bun", [cli], {
        cwd: dir,
        input: stringifyJson([{ file: "j.ts", ops: [{ kind: "fuzxy", find: "old", replace: "new" }] }]),
        encoding: "utf8",
        env: hermeticEnv,
    });
    check(
        "cli (JSON form): a misspelled op kind is a spec error, not a literal edit",
        bad.status === 2 &&
            bad.stderr.includes('unknown kind "fuzxy"') &&
            fs.readFileSync(path.join(dir, "j.ts"), "utf8") === "const old = 1;\n",
        `${String(bad.status)} ${bad.stderr.slice(0, 200)}`
    );
    const scripted = applyOps("const old = 1;\n", [{ kind: "fuzxy", find: "old", replace: "new" } as never]);
    check(
        "api: a misspelled op kind is a MISS, not a literal edit",
        scripted.results[0].status === "MISS" &&
            scripted.content === "const old = 1;\n" &&
            (scripted.results[0].reason ?? "").includes("unknown op kind"),
        scripted.results[0].reason ?? ""
    );
}
{
    let refused: FableReplaceError | undefined;
    try {
        dropComments("// legacy a\n// legacy b\n", { containing: "legacy", expect: 1 });
    } catch (err) {
        refused = err instanceof FableReplaceError ? err : undefined;
    }
    check(
        "dropComments enforces expect on a direct call",
        refused?.code === 1 && refused.message.includes("expected 1 comment(s), found 2"),
        String(refused?.message)
    );
    const asOp = applyOps("// legacy a\n// legacy b\n", [{ kind: "dropComments", containing: "legacy", expect: 1 }]);
    check(
        "the op form reports the same mismatch as a MISS and changes nothing",
        asOp.results[0].status === "MISS" &&
            asOp.content === "// legacy a\n// legacy b\n" &&
            (asOp.results[0].reason ?? "").includes("found 2"),
        asOp.results[0].reason ?? ""
    );
}

// ── review round 10 (PR #371, eve): JSON field types are checked, deleteLines enforces expect itself, a spec that
// cannot be read is journaled ──
console.log("review round 10 (PR #371)");
{
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const dir = f("json-types");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "n.ts"), "const n = 1;\n");
    const bad = spawnSync("bun", [cli], {
        cwd: dir,
        input: '[{"file":"n.ts","delete":"false"}]',
        encoding: "utf8",
        env: hermeticEnv,
    });
    check(
        'cli (JSON form): delete: "false" is a spec error, and the file survives',
        bad.status === 2 &&
            bad.stderr.includes("delete must be true or false") &&
            fs.existsSync(path.join(dir, "n.ts")),
        `${String(bad.status)} ${bad.stderr.slice(0, 200)}`
    );
    const overwrite = spawnSync("bun", [cli], {
        cwd: dir,
        input: '[{"file":"n.ts","renameTo":"m.ts","overwrite":"false"}]',
        encoding: "utf8",
        env: hermeticEnv,
    });
    check(
        'cli (JSON form): overwrite: "false" is a spec error',
        overwrite.status === 2 && overwrite.stderr.includes("overwrite must be true or false"),
        `${String(overwrite.status)} ${overwrite.stderr.slice(0, 200)}`
    );
}
{
    let refused: FableReplaceError | undefined;
    try {
        deleteLines("a\nDEBUG 1\nDEBUG 2\n", { kind: "deleteLines", containing: "DEBUG", expect: 1 });
    } catch (err) {
        refused = err instanceof FableReplaceError ? err : undefined;
    }
    check(
        "deleteLines enforces expect on a direct call",
        refused?.code === 1 && refused.message.includes("expected 1 line(s), found 2"),
        String(refused?.message)
    );
    const asOp = applyOps("a\nDEBUG 1\nDEBUG 2\n", [{ kind: "deleteLines", containing: "DEBUG", expect: 1 }]);
    check(
        "the deleteLines op reports the mismatch as a MISS and changes nothing",
        asOp.results[0].status === "MISS" &&
            asOp.content === "a\nDEBUG 1\nDEBUG 2\n" &&
            (asOp.results[0].reason ?? "").includes("found 2"),
        asOp.results[0].reason ?? ""
    );
}
{
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
    const home = f("journal-spec-error");
    fs.mkdirSync(home, { recursive: true });
    const unreadable = spawnSync("bun", [cli, "--spec", f("does-not-exist.frspec")], {
        encoding: "utf8",
        env: { ...hermeticEnv, FABLE_REPLACE_HOME: home },
    });
    const journalFile = path.join(home, ".genesis-tools", "fable-replace", "journal.jsonl");
    const journalLines = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8").trim().split("\n") : [];
    const last =
        journalLines.length > 0 ? (parseJson(journalLines[journalLines.length - 1]) as JournalEntry) : undefined;
    check(
        "an unreadable --spec is journaled as spec-error",
        unreadable.status === 2 && last?.outcome === "spec-error" && (last.message ?? "").includes("cannot read"),
        `${String(unreadable.status)} ${stringifyJson(last)}`
    );
}

// ── verdict ─────────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(hermeticRoot, { recursive: true, force: true });
if (failures > 0) {
    console.error(`\n${failures} SELFTEST FAILURE(S)`);
    process.exit(1);
}
console.log("\nALL SELFTESTS PASSED");
