/**
 * The engine behind the skills' code scanners (ux/scripts/ux-scan.ts, swift/scripts/swift-scan.ts): it runs a list of
 * line checks over Swift files and prints the candidate lines grouped by pass, then facts over the whole set. A line
 * is a candidate, not a finding. It only reads files.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface Check {
    pass: string;
    name: string;
    pattern: RegExp;
    hint: string;
    /** Drop a hit when this matches within `near` lines of it (the case is already handled there). */
    unless?: RegExp;
    near?: number;
    /** Check only files whose text matches (for example view files, or files on the main actor). */
    onlyIn?: RegExp;
    /** A broad check: print the files ranked by hit count instead of every line. */
    byFile?: boolean;
}

/** A count over every scanned line; zero is reported with what it means. */
export interface CountFact {
    name: string;
    pattern: RegExp;
    zeroMeans: string;
}

/** A per-file fact: a label when the file qualifies, otherwise undefined. */
export interface FileFact {
    name: string;
    test: (text: string, lines: string[]) => string | undefined;
}

export interface ScanSet {
    title: string;
    checks: Check[];
    counts: CountFact[];
    fileFacts: FileFact[];
}

interface Hit {
    file: string;
    line: number;
    text: string;
}

export function swiftFiles(target: string, out: string[]): void {
    const info = lstatSync(target);
    if (info.isFile()) {
        if (target.endsWith(".swift")) {
            out.push(target);
        }

        return;
    }

    // Do not follow directory cycles or dangling links, or try to enumerate special files.
    if (!info.isDirectory()) {
        return;
    }

    for (const entry of readdirSync(target)) {
        if (entry === ".build" || entry === "Tests" || entry.startsWith(".")) {
            continue;
        }

        swiftFiles(join(target, entry), out);
    }
}

export function scan(set: ScanSet, files: string[], max: number): string {
    const hits = new Map<Check, Hit[]>();
    const counts = new Map<string, number>();
    const fileFacts = new Map<string, string[]>();
    const cwd = process.cwd();

    for (const file of files) {
        const text = readFileSync(file, "utf8");
        const lines = text.split("\n");
        const shown = relative(cwd, file);

        for (const check of set.checks) {
            if (check.onlyIn && !check.onlyIn.test(text)) {
                continue;
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.trimStart().startsWith("//") || !check.pattern.test(line)) {
                    continue;
                }

                if (check.unless) {
                    const near = check.near ?? 0;
                    const window = lines.slice(Math.max(0, i - near), i + near + 1).join("\n");
                    if (check.unless.test(window)) {
                        continue;
                    }
                }

                const list = hits.get(check) ?? [];
                list.push({ file: shown, line: i + 1, text: line.trim().slice(0, 140) });
                hits.set(check, list);
            }
        }

        for (const fact of set.counts) {
            const count = lines.filter((l) => fact.pattern.test(l)).length;
            counts.set(fact.name, (counts.get(fact.name) ?? 0) + count);
        }

        for (const fact of set.fileFacts) {
            const label = fact.test(text, lines);
            if (label !== undefined) {
                const list = fileFacts.get(fact.name) ?? [];
                list.push(label ? `${shown} (${label})` : shown);
                fileFacts.set(fact.name, list);
            }
        }
    }

    const out: string[] = [`# ${set.title}: ${files.length} Swift files (candidates, not findings)`, ""];
    let pass = "";
    for (const check of set.checks) {
        const list = hits.get(check) ?? [];
        if (check.pass !== pass) {
            pass = check.pass;
            out.push(`## ${pass}`);
        }

        out.push(`- ${check.name} [${list.length}]: ${check.hint}`);
        if (check.byFile) {
            const perFile = new Map<string, number[]>();
            for (const hit of list) {
                perFile.set(hit.file, [...(perFile.get(hit.file) ?? []), hit.line]);
            }

            const ranked = [...perFile].sort((a, b) => b[1].length - a[1].length);
            for (const [file, lines] of ranked.slice(0, max)) {
                out.push(
                    `  ${file} (${lines.length}): lines ${lines.slice(0, 12).join(", ")}${lines.length > 12 ? ", …" : ""}`
                );
            }

            continue;
        }

        for (const hit of list.slice(0, max)) {
            out.push(`  ${hit.file}:${hit.line}  ${hit.text}`);
        }

        if (list.length > max) {
            out.push(`  … ${list.length - max} more (raise --max)`);
        }
    }

    out.push("", "## Facts over these files");
    for (const fact of set.counts) {
        const count = counts.get(fact.name) ?? 0;
        out.push(`- ${fact.name}: ${count}${count === 0 ? ` (0 means: ${fact.zeroMeans})` : ""}`);
    }

    for (const fact of set.fileFacts) {
        out.push(`- ${fact.name}: ${(fileFacts.get(fact.name) ?? []).join(", ") || "none"}`);
    }

    return out.join("\n");
}

/** Parses `<file or folder>... [--max <n>]`, scans, prints. */
export function runCli(set: ScanSet, argv: string[], usage: string): void {
    const maxIndex = argv.indexOf("--max");
    const max = maxIndex >= 0 ? Number(argv[maxIndex + 1]) : 60;
    const targets = maxIndex >= 0 ? argv.filter((_, i) => i !== maxIndex && i !== maxIndex + 1) : argv;
    if (targets.length === 0) {
        console.error(usage);
        process.exit(1);
    }

    const files: string[] = [];
    for (const target of targets) {
        swiftFiles(target, files);
    }

    console.log(scan(set, files, Number.isFinite(max) && max > 0 ? max : 60));
}
