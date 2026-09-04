/**
 * Session enumeration + mined-state. Selection rules distilled from SkillOpt's
 * miner: min-size filter, skip subagent transcripts, dedupe duplicate session
 * copies (same UUID under several dirs) by stem keeping the LARGEST file,
 * skip already-mined stems, OLDEST first (style evolution reads forward).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { extractProjectName } from "@genesiscz/utils/claude";
import { isSubagentFile, readHeadTailLines } from "@genesiscz/utils/claude/session.utils";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { ripgrepBinary } from "@genesiscz/utils/ripgrep";
import { FABLE_MODEL, type FableConfig, packPaths } from "./config";

export interface SessionCandidate {
    path: string;
    stem: string;
    size: number;
    mtimeMs: number;
    source: "live" | "mirror";
    project: string;
}

export interface SessionMeta {
    cwd?: string;
    gitBranch?: string;
    firstTimestamp?: string;
    firstUserPrompt?: string;
}

export interface MinedState {
    /** stems mined by the prose miner (processed.jsonl, key `file`) */
    prose: Map<string, { minedAt?: string; notes?: string }>;
    /** stems mined by the episode miner (skillopt-data/mined.jsonl, key `session`) */
    episodes: Map<string, { episodes?: number }>;
    /** union of both */
    all: Set<string>;
}

function stemOf(path: string): string {
    return basename(path).replace(/\.jsonl$/, "");
}

async function rgFableFiles(root: string): Promise<string[]> {
    if (!existsSync(root)) {
        return [];
    }

    // Bun.spawn throws ENOENT synchronously when the binary is missing, which
    // would abort enumeration instead of degrading to the mirror scan.
    const rg = ripgrepBinary();
    if (!rg) {
        logger.warn({ root }, "no ripgrep on PATH or vendored — skipping fable-file enumeration for this root");
        return [];
    }

    const proc = Bun.spawn([rg, "-l", "--no-messages", "-F", `"model":"${FABLE_MODEL}"`, root, "--glob", "*.jsonl"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    // rg exits 1 on "no matches" — only 2+ is a real failure
    if (code > 1) {
        const stderr = await new Response(proc.stderr).text();
        logger.warn({ root, code, stderr: stderr.slice(0, 300) }, "rg enumeration failed");
    }

    return stdout.split("\n").filter(Boolean);
}

async function mirrorFiles(root: string): Promise<string[]> {
    if (!existsSync(root)) {
        return [];
    }

    const glob = new Bun.Glob("**/*.jsonl");
    const out: string[] = [];
    for await (const rel of glob.scan({ cwd: root, absolute: true })) {
        out.push(rel);
    }

    return out;
}

/**
 * All fable session candidates across configured sources, deduped by stem
 * (largest file wins), subagent transcripts and tiny stubs dropped.
 */
export async function listCandidates(
    config: FableConfig,
    options: { minSize?: number; includeSubagents?: boolean } = {}
): Promise<SessionCandidate[]> {
    const minSize = options.minSize ?? 100_000;
    const mirror = config.sessionsMirrorPath;
    const seen = new Map<string, SessionCandidate>();

    for (const source of config.sessionSources) {
        const isMirror = source === mirror;
        // The mirror was built exclusively from fable sessions, so no grep needed there.
        const files = isMirror ? await mirrorFiles(source) : await rgFableFiles(source);

        for (const path of files) {
            if (!options.includeSubagents && (isSubagentFile(path) || basename(path).startsWith("agent-"))) {
                continue;
            }

            let size = 0;
            let mtimeMs = 0;
            try {
                const st = statSync(path);
                size = st.size;
                mtimeMs = st.mtimeMs;
            } catch (err) {
                logger.debug({ path, error: err }, "stat failed during enumeration");
                continue;
            }

            if (size < minSize) {
                continue;
            }

            const stem = stemOf(path);
            const cur = seen.get(stem);
            if (!cur || size > cur.size) {
                seen.set(stem, {
                    path,
                    stem,
                    size,
                    mtimeMs,
                    source: isMirror ? "mirror" : "live",
                    project: extractProjectName(path),
                });
            }
        }
    }

    return [...seen.values()].sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
}

export function loadMinedState(config: FableConfig): MinedState {
    const paths = packPaths(config);
    const prose = new Map<string, { minedAt?: string; notes?: string }>();
    const episodes = new Map<string, { episodes?: number }>();

    if (existsSync(paths.processedManifest)) {
        for (const line of readFileSync(paths.processedManifest, "utf-8").split("\n")) {
            if (!line.trim()) {
                continue;
            }

            try {
                const row: { file?: string; minedAt?: string; notes?: string } = SafeJSON.parse(line, { strict: true });
                if (row.file) {
                    prose.set(stemOf(row.file), { minedAt: row.minedAt, notes: row.notes });
                }
            } catch (err) {
                logger.debug({ error: err }, "bad processed.jsonl line skipped");
            }
        }
    }

    // Two manifests: the legacy skillopt one, and meta/mined.jsonl which the
    // current miner appends to. Reading only the legacy file made `stats` report
    // 1 mined / 120 unmined right after 20 sessions had been mined.
    for (const manifest of [paths.skilloptManifest, paths.minedManifest]) {
        if (!existsSync(manifest)) {
            continue;
        }

        for (const line of readFileSync(manifest, "utf-8").split("\n")) {
            if (!line.trim()) {
                continue;
            }

            try {
                const row: { session?: string; stem?: string; episodes?: number } = SafeJSON.parse(line, {
                    strict: true,
                });
                const stem = row.stem ?? (row.session ? stemOf(row.session) : undefined);
                if (stem) {
                    episodes.set(stem, { episodes: row.episodes });
                }
            } catch (err) {
                logger.debug({ error: err, manifest }, "bad mined manifest line skipped");
            }
        }
    }

    return { prose, episodes, all: new Set([...prose.keys(), ...episodes.keys()]) };
}

export function unminedCandidates(candidates: SessionCandidate[], mined: MinedState): SessionCandidate[] {
    return candidates.filter((c) => !mined.all.has(c.stem));
}

/** Cheap metadata scan: reads only the head lines of the transcript (cwd, branch, first timestamp, first user prompt). */
export async function sessionMeta(path: string, headLines = 60): Promise<SessionMeta> {
    const meta: SessionMeta = {};

    let lines: string[] = [];
    try {
        lines = await readHeadTailLines(path, headLines, 0);
    } catch (err) {
        logger.debug({ path, error: err }, "sessionMeta read failed");
        return meta;
    }

    for (const line of lines) {
        if (meta.cwd && meta.gitBranch && meta.firstTimestamp && meta.firstUserPrompt) {
            break;
        }

        if (!line.trim()) {
            continue;
        }

        let obj: {
            cwd?: string;
            gitBranch?: string;
            timestamp?: string;
            type?: string;
            message?: { role?: string; content?: unknown };
        };
        try {
            obj = SafeJSON.parse(line, { strict: true });
        } catch {
            continue;
        }

        meta.cwd ??= obj.cwd;
        meta.gitBranch ??= obj.gitBranch;
        meta.firstTimestamp ??= obj.timestamp;

        if (!meta.firstUserPrompt && obj.message?.role === "user") {
            const content = obj.message.content;
            const text =
                typeof content === "string"
                    ? content
                    : Array.isArray(content)
                      ? content
                            .map((b) => (b && typeof b === "object" && "text" in b ? String(b.text ?? "") : ""))
                            .join(" ")
                      : "";
            const cleaned = text
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            // resume/compact preambles are not the user's actual first ask
            if (cleaned && !cleaned.startsWith("Caveat:") && !cleaned.startsWith("This session is being continued")) {
                meta.firstUserPrompt = cleaned.slice(0, 160);
            }
        }
    }

    return meta;
}
