import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { logger } from "@app/logger";
import { parseImports } from "./imports";
import { roar } from "./roar";
import { scariness } from "./score";
import { tierForScore, tierName } from "./tier";
import type { MonsterReport, ScoredFile } from "./types";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cts", ".mts"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cts", ".mts"];

export interface AnalyzeOptions {
    dir: string;
    /** Injected wall-clock epoch ms used to calculate file age. */
    now: number;
    top: number;
}

interface RawFile {
    abs: string;
    rel: string;
    content: string;
    lines: number;
}

function hasSourceExtension(name: string): boolean {
    const dot = name.lastIndexOf(".");
    if (dot < 0) {
        return false;
    }

    return SOURCE_EXTENSIONS.has(name.slice(dot));
}

function walk(root: string): string[] {
    const out: string[] = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined) {
            continue;
        }

        let entries: Dirent<string>[];
        try {
            entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
        } catch (err) {
            logger.warn({ dir: current, err }, "monster: failed to read directory");
            continue;
        }

        for (const entry of entries) {
            if (entry.name.startsWith(".") && entry.isDirectory()) {
                continue;
            }

            const full = join(current, entry.name);
            if (entry.isSymbolicLink()) {
                continue;
            }

            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) {
                    stack.push(full);
                }

                continue;
            }

            if (entry.isFile() && hasSourceExtension(entry.name)) {
                out.push(full);
            }
        }
    }

    return out;
}

function toPosix(p: string): string {
    return p.split("\\").join("/");
}

/** Run one `git log` to get the most-recent commit epoch-ms per file. Empty map if git unavailable. */
async function gitLastCommitTimes(dir: string): Promise<Map<string, number>> {
    const times = new Map<string, number>();
    try {
        const proc = Bun.spawn(["git", "log", "--relative", "--name-only", "--pretty=format:%H%x09%at"], {
            cwd: dir,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout = await new Response(proc.stdout).text();
        const exit = await proc.exited;
        if (exit !== 0) {
            logger.warn({ dir, exit }, "monster: git log unavailable; age scoring disabled");
            return times;
        }

        let currentTs = 0;
        for (const line of stdout.split("\n")) {
            if (line.length === 0) {
                continue;
            }

            const tab = line.indexOf("\t");
            if (tab >= 0) {
                currentTs = Number.parseInt(line.slice(tab + 1), 10) * 1000;
                continue;
            }

            const rel = toPosix(line.trim());
            if (rel.length > 0 && !times.has(rel)) {
                times.set(rel, currentTs);
            }
        }
    } catch (err) {
        logger.warn({ dir, err }, "monster: git log failed to run; age scoring disabled");
    }

    return times;
}

function resolveSpecifier(from: RawFile, spec: string, byAbs: Map<string, RawFile>): string | null {
    const fromDirAbs = from.abs.slice(0, from.abs.lastIndexOf("/") + 1);
    const baseAbs = toPosix(resolve(fromDirAbs, spec));
    const candidates = [
        baseAbs,
        ...RESOLVE_EXTENSIONS.map((e) => baseAbs + e),
        ...RESOLVE_EXTENSIONS.map((e) => `${baseAbs}/index${e}`),
    ];
    for (const cand of candidates) {
        const found = byAbs.get(cand);
        if (found) {
            return found.rel;
        }
    }

    return null;
}

function buildGraph(files: RawFile[]): { fanIn: Map<string, number>; fanOut: Map<string, number> } {
    const byAbs = new Map<string, RawFile>();
    for (const f of files) {
        byAbs.set(f.abs, f);
    }

    const fanIn = new Map<string, number>();
    const fanOut = new Map<string, number>();
    for (const f of files) {
        fanIn.set(f.rel, 0);
        fanOut.set(f.rel, 0);
    }

    for (const f of files) {
        const specs = parseImports(f.content);
        for (const spec of specs) {
            if (!spec.startsWith(".")) {
                continue;
            }

            const target = resolveSpecifier(f, spec, byAbs);
            if (target === null) {
                continue;
            }

            fanOut.set(f.rel, (fanOut.get(f.rel) ?? 0) + 1);
            fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
        }
    }

    return { fanIn, fanOut };
}

export async function analyze(options: AnalyzeOptions): Promise<MonsterReport> {
    const absDir = resolve(options.dir);
    logger.debug({ dir: absDir, top: options.top }, "monster: analyze start");

    const absPaths = walk(absDir);
    const files: RawFile[] = absPaths.map((abs) => {
        const content = readFileSync(abs, "utf-8");
        return {
            abs: toPosix(abs),
            rel: toPosix(relative(absDir, abs)),
            content,
            lines: content.length === 0 ? 0 : content.split("\n").length,
        };
    });

    if (files.length === 0) {
        logger.debug({ dir: absDir }, "monster: no source files");
        return { dir: absDir, fileCount: 0, repoMonsterSize: 0, scariest: null, leaderboard: [] };
    }

    const lastCommit = await gitLastCommitTimes(absDir);
    const gitAvailable = lastCommit.size > 0;
    const { fanIn, fanOut } = buildGraph(files);

    const scored: ScoredFile[] = files.map((f) => {
        const committedMs = lastCommit.get(f.rel);
        const ageDays = committedMs === undefined ? 0 : Math.max(0, (options.now - committedMs) / 86_400_000);
        const fi = fanIn.get(f.rel) ?? 0;
        const fo = fanOut.get(f.rel) ?? 0;
        const score = scariness({ lines: f.lines, ageDays, fanIn: fi, fanOut: fo });
        const tier = tierForScore(score);
        return {
            path: f.rel,
            score,
            tier,
            tierName: tierName(tier),
            lines: f.lines,
            ageDays,
            fanIn: fi,
            fanOut: fo,
        };
    });

    scored.sort((a, b) => b.score - a.score);
    const repoMonsterSize = scored.reduce((sum, f) => sum + f.score, 0);
    const top = scored[0];
    const scariest = { ...top, roar: roar({ ...top, gitAvailable }) };
    const leaderboard = scored.slice(0, Math.max(1, options.top));

    logger.debug({ dir: absDir, fileCount: scored.length, gitAvailable, scariest: top.path }, "monster: analyze done");

    return { dir: absDir, fileCount: scored.length, repoMonsterSize, scariest, leaderboard };
}
