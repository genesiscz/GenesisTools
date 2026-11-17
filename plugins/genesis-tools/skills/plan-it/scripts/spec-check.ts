#!/usr/bin/env bun
/**
 * Checks a build spec of the plan-it skill before an executor reads it: the sections and their order, the fields
 * of each package, what each package needs (and the waves that follow), paths that do not exist, handoffs a
 * package names but "Sources" does not, targets without a source or a way, placeholders and the size.
 *
 * Standalone: a plugin file imports nothing from the repository.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type Finding = { level: "error" | "warning"; line: number; where: string; message: string };
export type NeedMode = "interface" | "built";
export type Need = { kind: "package" | "external"; name: string; mode: NeedMode };
export type Field = { line: number; text: string };
export type Package = { id: string; title: string; line: number; fields: Record<string, Field>; needs: Need[] };
export type Waiting = { id: string; on: string[] };
export type SpecReport = {
    lines: number;
    packages: Package[];
    waves: string[][];
    waiting: Waiting[];
    findings: Finding[];
};
export type CheckOptions = { root: string; maxLines?: number; paths?: boolean };

export const SECTIONS = [
    "Read this first after a compaction",
    "Sources",
    "Interface freeze",
    "Order",
    "Packages",
    "Rules for the executor",
    "Decisions",
    "Progress",
    "Seen, not fixed",
    "Deviations",
] as const;

const HEAD_FIELDS = ["Status", "Goal", "Non-goals", "Executor"];
const PACKAGE_FIELDS = ["Owner files", "Needs", "Done when", "Effort"];
const TARGET_SOURCES = ["tool", "hand-reference", "estimate"];
/** The sections the executor fills: a "TODO" there is content, not a placeholder of the planner. */
const EXECUTOR_SECTIONS = new Set(["Progress", "Seen, not fixed", "Deviations"]);
const PLACEHOLDERS = [
    /\bTBD\b/,
    /\bTODO\b/,
    /\bto be decided\b/i,
    /\bas needed\b/i,
    /\bas appropriate\b/i,
    /\bappropriate error handling\b/i,
    /\bhandle edge cases\b/i,
    /\bfill in (the )?details\b/i,
    /\bimplement later\b/i,
];
const WARN_LINES = 450;
const MAX_LINES = 600;

type Line = { n: number; text: string; fenced: boolean; section: string | null };

function readLines(text: string): Line[] {
    const out: Line[] = [];
    let fenced = false;
    let section: string | null = null;
    text.split("\n").forEach((raw, i) => {
        const isFence = /^\s*(```|~~~)/.test(raw);
        const heading = !fenced && !isFence ? /^## (.+?)\s*$/.exec(raw) : null;
        if (heading) {
            section = SECTIONS.find((s) => heading[1].toLowerCase().startsWith(s.toLowerCase())) ?? heading[1];
        }

        out.push({ n: i + 1, text: raw, fenced: fenced || isFence, section });
        if (isFence) {
            fenced = !fenced;
        }
    });
    return out;
}

function modeOf(text: string): NeedMode {
    return text === "built" ? "built" : "interface";
}

function parseNeeds(text: string): { needs: Need[]; bad: string[] } {
    const needs: Need[] = [];
    const bad: string[] = [];
    for (const raw of text.split(/,(?![^(]*\))/)) {
        const item = raw.trim().replace(/\.$/, "");
        if (!item || item.toLowerCase() === "nothing") {
            continue;
        }

        const pkg = /^(P\d+[A-Za-z]?)\s*\((interface|built)\)$/.exec(item);
        const ext = /^external:\s*(.+?)\s*\((interface|built)\)$/.exec(item);
        if (pkg) {
            needs.push({ kind: "package", name: pkg[1], mode: modeOf(pkg[2]) });
        } else if (ext) {
            needs.push({ kind: "external", name: ext[1], mode: modeOf(ext[2]) });
        } else {
            bad.push(item);
        }
    }

    return { needs, bad };
}

function parsePackages(lines: Line[], findings: Finding[]): Package[] {
    const packages: Package[] = [];
    let current: Package | null = null;
    let field: Field | null = null;
    for (const l of lines) {
        if (l.section !== "Packages") {
            current = null;
            field = null;
            continue;
        }

        const head = !l.fenced ? /^### (P\d+[A-Za-z]?)[:.]\s*(.+?)\s*$/.exec(l.text) : null;
        if (head) {
            current = { id: head[1], title: head[2], line: l.n, fields: {}, needs: [] };
            packages.push(current);
            field = null;
            continue;
        }

        if (!current) {
            continue;
        }

        const start = !l.fenced ? /^\*\*([A-Za-z][A-Za-z -]*?):\*\*\s*(.*)$/.exec(l.text) : null;
        if (start) {
            field = { line: l.n, text: start[2] };
            current.fields[start[1]] = field;
        } else if (field) {
            field.text += `\n${l.text}`;
        }
    }

    for (const p of packages) {
        for (const name of PACKAGE_FIELDS) {
            if (!p.fields[name]?.text.trim()) {
                findings.push({
                    level: "error",
                    line: p.line,
                    where: p.id,
                    message: `the field "**${name}:**" is missing or empty`,
                });
            }
        }

        const needs = p.fields.Needs;
        if (needs) {
            const parsed = parseNeeds(needs.text.split("\n")[0]);
            p.needs = parsed.needs;
            for (const item of parsed.bad) {
                findings.push({
                    level: "error",
                    line: needs.line,
                    where: p.id,
                    message: `cannot read the need "${item}". Write "nothing", "P2 (interface)", "P2 (built)" or "external: <name> (interface|built)"`,
                });
            }
        }
    }

    return packages;
}

/** The start order: a wave holds the packages whose built needs are all in earlier waves. */
function orderPackages(
    packages: Package[],
    blocked: Map<string, string[]>,
    findings: Finding[]
): { waves: string[][]; waiting: Waiting[] } {
    const ids = new Set(packages.map((p) => p.id));
    const waiting: Waiting[] = [];
    const held = new Set<string>();
    for (const p of packages) {
        const on = [...(blocked.get(p.id) ?? [])];
        for (const n of p.needs) {
            if (n.kind === "package" && !ids.has(n.name)) {
                findings.push({
                    level: "error",
                    line: p.fields.Needs.line,
                    where: p.id,
                    message: `needs ${n.name}, and no package has that id`,
                });
            }

            if (n.kind === "external" && n.mode === "built") {
                on.push(`external: ${n.name} (built)`);
            }
        }

        if (on.length) {
            waiting.push({ id: p.id, on });
            held.add(p.id);
        }
    }

    const builtNeeds = (p: Package) =>
        p.needs.filter((n) => n.kind === "package" && n.mode === "built" && ids.has(n.name));
    // A package that needs a held package built is held too, and so on down the chain.
    for (let grew = true; grew; ) {
        grew = false;
        for (const p of packages) {
            const on = builtNeeds(p).filter((n) => held.has(n.name));
            if (!held.has(p.id) && on.length) {
                waiting.push({ id: p.id, on: on.map((n) => `${n.name} (built), which itself waits`) });
                held.add(p.id);
                grew = true;
            }
        }
    }

    const waves: string[][] = [];
    const done = new Set<string>();
    let left = packages.filter((p) => !held.has(p.id));
    while (left.length) {
        const wave = left.filter((p) => builtNeeds(p).every((n) => done.has(n.name)));
        if (!wave.length) {
            for (const p of left) {
                const on = builtNeeds(p).filter((n) => !done.has(n.name));
                findings.push({
                    level: "error",
                    line: p.line,
                    where: p.id,
                    message: `its needs form a circle (${on.map((n) => n.name).join(", ")}): no package of the circle can start`,
                });
            }

            break;
        }

        waves.push(wave.map((p) => p.id));
        for (const p of wave) {
            done.add(p.id);
        }

        left = left.filter((p) => !done.has(p.id));
    }

    const position = new Map(packages.map((p, i) => [p.id, i]));
    for (const p of packages) {
        for (const n of p.needs) {
            const at = position.get(n.name);
            if (n.kind === "package" && n.mode === "built" && at !== undefined && at > (position.get(p.id) ?? 0)) {
                findings.push({
                    level: "warning",
                    line: p.line,
                    where: p.id,
                    message: `stands before ${n.name}, which it needs built. Put ${n.name} first`,
                });
            }
        }
    }

    return { waves, waiting };
}

function checkTargets(p: Package, findings: Finding[]): void {
    const targets = p.fields.Targets;
    if (!targets) {
        return;
    }

    const bullets = targets.text.split(/\n(?=- )/).filter((b) => b.trim().startsWith("- "));
    bullets.forEach((bullet, i) => {
        const where = `${p.id} target ${i + 1}`;
        const source = /source:\s*([a-z-]+)/i.exec(bullet)?.[1].toLowerCase();
        if (!source || !TARGET_SOURCES.includes(source)) {
            findings.push({
                level: "error",
                line: targets.line,
                where,
                message: `needs "source:" (${TARGET_SOURCES.join(", ")}): where the number comes from`,
            });
        } else if (/gate:\s*yes/i.test(bullet) && source !== "tool") {
            findings.push({
                level: "error",
                line: targets.line,
                where,
                message: `a number from a ${source} cannot be a gate: the tool may not be able to reach it`,
            });
        }

        if (!/\bway:/i.test(bullet) && !/\bif not:/i.test(bullet)) {
            findings.push({
                level: "error",
                line: targets.line,
                where,
                message:
                    'needs "way:" (how it could be reached) or "if not:" (what to write down). A bare number is an order nobody can check',
            });
        }
    });
}

function looksLikePath(token: string): boolean {
    if (/[<>*{}$…|]|\s|^https?:|^[a-z]+:\/\//.test(token) || !token.includes("/")) {
        return false;
    }

    if (!/^(~\/|\/|\.\.?\/|[\w.@-]+\/)/.test(token)) {
        return false;
    }

    return token.endsWith("/") || /\.[A-Za-z0-9]{1,6}$/.test(token);
}

function checkPaths(lines: Line[], root: string, findings: Finding[]): void {
    const seen = new Set<string>();
    for (const l of lines) {
        if (l.fenced || /\(new[,)]/.test(l.text)) {
            continue;
        }

        for (const m of l.text.matchAll(/`([^`]+)`/g)) {
            const token = m[1].replace(/(:\d+(-\d+)?(:\d+)?|#L\d+(-L?\d+)?)$/, "");
            if (!looksLikePath(token) || seen.has(token)) {
                continue;
            }

            seen.add(token);
            const abs = token.startsWith("~/")
                ? join(homedir(), token.slice(2))
                : isAbsolute(token)
                  ? token
                  : resolve(root, token);
            if (!existsSync(abs)) {
                findings.push({
                    level: "error",
                    line: l.n,
                    where: l.section ?? "head",
                    message: `the path \`${token}\` does not exist. Fix it, or write "(new)" on its line when the build creates it`,
                });
            }
        }
    }
}

export function checkSpec(text: string, opts: CheckOptions): SpecReport {
    const findings: Finding[] = [];
    const lines = readLines(text);
    const add = (level: Finding["level"], line: number, where: string, message: string) =>
        findings.push({ level, line, where, message });

    const firstSection = lines.find((l) => l.section !== null)?.n ?? lines.length + 1;
    const head = lines.filter((l) => l.n < firstSection);
    for (const name of HEAD_FIELDS) {
        if (!head.some((l) => l.text.startsWith(`**${name}:**`) && l.text.length > name.length + 6)) {
            add("error", 1, "head", `the line "**${name}:**" is missing or empty`);
        }
    }

    let last = 0;
    for (const name of SECTIONS) {
        const at = lines.find((l) => l.section === name)?.n;
        if (at === undefined) {
            add("error", 1, "sections", `the section "## ${name}" is missing`);
        } else if (at < last) {
            add(
                "error",
                at,
                "sections",
                `the section "## ${name}" stands before an earlier section of the fixed order`
            );
        } else {
            last = at;
        }
    }

    const packages = parsePackages(lines, findings);
    if (!packages.length && lines.some((l) => l.section === "Packages")) {
        add("error", 1, "Packages", 'no package found. A package starts with "### P1: <name>"');
    }

    const sources = lines
        .filter((l) => l.section === "Sources")
        .map((l) => l.text)
        .join("\n");
    for (const p of packages) {
        checkTargets(p, findings);
        const body = Object.values(p.fields)
            .map((f) => f.text)
            .join("\n");
        for (const id of new Set(body.match(/\bh_[a-z0-9]{8}\b/g) ?? [])) {
            if (!sources.includes(id)) {
                add(
                    "error",
                    p.line,
                    p.id,
                    `names the handoff ${id}, and "## Sources" does not: the executor cannot find how to claim and tick it`
                );
            }
        }

        const done = p.fields["Done when"]?.text ?? "";
        if (done.trim() && !done.includes("`")) {
            add(
                "warning",
                p.fields["Done when"].line,
                p.id,
                '"Done when" names no command and no test. Write the command that shows it'
            );
        }
    }

    const blocked = new Map<string, string[]>();
    for (const l of lines.filter((x) => x.section === "Decisions" && !x.fenced)) {
        const d = /\*\*(D\d+) \((open|answered)([^)]*)\):?\*\*:?\s*(.*)$/.exec(l.text);
        if (!d) {
            continue;
        }

        if (d[2] === "answered" && !d[4].includes('"')) {
            add("warning", l.n, d[1], "an answered decision carries the owner's words in quotes");
        }

        if (d[2] === "open") {
            const ids = d[3].match(/P\d+[A-Za-z]?/g) ?? [];
            if (!ids.length && !/blocks nothing/.test(d[3])) {
                add(
                    "error",
                    l.n,
                    d[1],
                    'an open decision says what it blocks: "(open, blocks P3)" or "(open, blocks nothing)"'
                );
            }

            for (const id of /blocks nothing/.test(d[3]) ? [] : ids) {
                blocked.set(id, [...(blocked.get(id) ?? []), `the open decision ${d[1]}`]);
            }
        }
    }

    for (const l of lines) {
        if (l.fenced || (l.section !== null && EXECUTOR_SECTIONS.has(l.section))) {
            continue;
        }

        const prose = l.text.replace(/`[^`]*`/g, "");
        const hit = PLACEHOLDERS.find((re) => re.test(prose));
        if (hit) {
            add(
                "error",
                l.n,
                l.section ?? "head",
                `a placeholder (${hit.source.replace(/\\b/g, "")}). Decide it now, or make it an open decision`
            );
        }
    }

    if (opts.paths !== false) {
        checkPaths(lines, opts.root, findings);
    }

    const max = opts.maxLines ?? MAX_LINES;
    if (lines.length > max) {
        add(
            "error",
            lines.length,
            "size",
            `${lines.length} lines, the limit is ${max}. Move the truth table, long lists and research into files the spec names`
        );
    } else if (lines.length > WARN_LINES && opts.maxLines === undefined) {
        add(
            "warning",
            lines.length,
            "size",
            `${lines.length} lines. A spec is read again after every compaction: aim at about 400`
        );
    }

    const { waves, waiting } = orderPackages(packages, blocked, findings);
    return { lines: lines.length, packages, waves, waiting, findings: findings.sort((a, b) => a.line - b.line) };
}

/** The repository root for relative paths: the first folder above the spec that holds `.git`. */
export function rootOf(specPath: string): string {
    let dir = dirname(resolve(specPath));
    while (dir !== dirname(dir)) {
        if (existsSync(join(dir, ".git"))) {
            return dir;
        }

        dir = dirname(dir);
    }

    return dirname(resolve(specPath));
}

export function renderReport(path: string, r: SpecReport): string {
    const out = [`${path}: ${r.lines} lines, ${r.packages.length} packages`];
    r.waves.forEach((wave, i) => {
        out.push(`  wave ${i + 1}${i === 0 ? " (can start now)" : ""}: ${wave.join(", ")}`);
    });
    for (const w of r.waiting) {
        out.push(`  waits: ${w.id} on ${w.on.join("; ")}`);
    }

    for (const f of r.findings) {
        out.push(`  ${f.level === "error" ? "ERROR" : "warn "} line ${f.line} [${f.where}] ${f.message}`);
    }

    const errors = r.findings.filter((f) => f.level === "error").length;
    out.push(errors ? `${errors} error(s). The spec is not ready for an executor.` : "ok: no errors.");
    return out.join("\n");
}

const HELP = `spec-check.ts: check a build spec of the plan-it skill

  bun spec-check.ts <spec.md> [--root <dir>] [--max-lines <n>] [--no-paths] [--json]

  --root       folder that relative paths are checked against (default: the repository of the spec)
  --max-lines  the size limit (default ${MAX_LINES}; a warning above ${WARN_LINES})
  --no-paths   do not check that the named paths exist
  --json       print the report as JSON

Exit code 1 when the spec has an error, 2 on a usage error.`;

export function main(argv: string[]): number {
    const args = [...argv];
    const flag = (name: string) => {
        const i = args.indexOf(name);
        if (i < 0) {
            return false;
        }

        args.splice(i, 1);
        return true;
    };
    const value = (name: string) => {
        const i = args.indexOf(name);
        if (i < 0) {
            return undefined;
        }

        return args.splice(i, 2)[1];
    };

    if (flag("--help") || flag("-h")) {
        console.log(HELP);
        return 0;
    }

    const json = flag("--json");
    const paths = !flag("--no-paths");
    const root = value("--root");
    const maxText = value("--max-lines");
    const maxLines = maxText === undefined ? undefined : Number(maxText);
    const [path] = args;
    if (!path || args.length > 1 || (maxLines !== undefined && !(maxLines > 0))) {
        console.error(HELP);
        return 2;
    }

    if (!existsSync(path)) {
        console.error(`spec-check: no file at ${path}`);
        return 2;
    }

    const report = checkSpec(readFileSync(path, "utf8"), {
        root: root ? resolve(root) : rootOf(path),
        maxLines,
        paths,
    });
    console.log(json ? JSON.stringify(report, null, 2) : renderReport(path, report));
    return report.findings.some((f) => f.level === "error") ? 1 : 0;
}

if (import.meta.main) {
    process.exit(main(process.argv.slice(2)));
}
