import { closeSync, type Dirent, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { TeammateLastMessage, TeammateTranscriptRef } from "./types";

const prof = profiler.scope("teams");

/** Max bytes of each end of a jsonl we ever touch. Never load whole multi‑MB leads. */
const HEAD_BYTES = 48 * 1024;
const TAIL_BYTES = 32 * 1024;
/** Files bigger than this without an agentName hit in the head are skipped. */
const SKIP_LARGE_WITHOUT_AGENT_BYTES = 2 * 1024 * 1024;

/** Matches a whole JSON string literal, so `\"` and `\\` do not end the capture. */
const AGENT_NAME_RE = /"agentName"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Agent names in the slice are JSON string literals, so the bytes between the quotes
 * are the ENCODED spelling (`a\"b`, `a\\b`). Everything downstream compares against
 * the DECODED value `SafeJSON.parse` returns, so a name indexed under the raw capture
 * could never match its own member. Decode each literal before it becomes a key.
 *
 * Decoding also removes the need to build a RegExp out of a name: one containing
 * `.`/`+`/`(` silently stopped matching its own transcript, and an unbalanced one
 * (`a[b`) threw and aborted the whole index pass.
 */
function agentNamesIn(text: string): Set<string> {
    const names = new Set<string>();

    for (const match of text.matchAll(AGENT_NAME_RE)) {
        try {
            const decoded = SafeJSON.parse(`"${match[1]}"`, { strict: true }) as string;

            if (decoded && decoded !== "team-lead") {
                names.add(decoded);
            }
        } catch (error) {
            // A literal cut in half by the head/tail boundary lands here.
            logger.trace({ error, raw: match[1] }, "[teams] skipping undecodable agentName literal");
        }
    }

    return names;
}

function stripTeammateEnvelope(text: string): string {
    return text
        .replace(/^<teammate-message[^>]*>\s*/i, "")
        .replace(/\s*<\/teammate-message>\s*$/i, "")
        .trim();
}

function contentToText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    const parts: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== "object") {
            continue;
        }

        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") {
            parts.push(b.text);
        } else if (typeof b.thinking === "string") {
            parts.push(b.thinking);
        } else if (b.type === "tool_use" && typeof b.name === "string") {
            parts.push(`[tool ${b.name}]`);
        }
    }

    return parts.join("\n");
}

/**
 * Read only the head + tail of a file via positioned reads.
 * Critical: never `readFileSync` multi‑10MB lead transcripts.
 */
export function readHeadTail(
    path: string,
    headBytes = HEAD_BYTES,
    tailBytes = TAIL_BYTES
): { head: string; tail: string; size: number; mtimeMs: number } | null {
    let fd: number | undefined;
    try {
        fd = openSync(path, "r");
        const st = fstatSync(fd);
        const size = st.size;
        const mtimeMs = st.mtimeMs;

        const hLen = Math.min(headBytes, size);
        const headBuf = Buffer.allocUnsafe(hLen);
        readSync(fd, headBuf, 0, hLen, 0);

        let tail = "";
        if (size > hLen) {
            const tLen = Math.min(tailBytes, size - hLen);
            const tailBuf = Buffer.allocUnsafe(tLen);
            readSync(fd, tailBuf, 0, tLen, size - tLen);
            tail = tailBuf.toString("utf8");
        }

        return { head: headBuf.toString("utf8"), tail, size, mtimeMs };
    } catch (error) {
        logger.debug({ error, path }, "[teams] could not read transcript head/tail; skipping this file");
        return null;
    } finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            } catch (error) {
                logger.debug({ error, path }, "[teams] could not close transcript fd");
            }
        }
    }
}

function isSidechainPath(path: string): boolean {
    return path.includes(`${sep}subagents${sep}`);
}

function parentSessionIdFromSidechainPath(path: string): string | undefined {
    const parts = path.split(sep);
    const idx = parts.lastIndexOf("subagents");
    if (idx <= 0) {
        return undefined;
    }

    return parts[idx - 1];
}

interface AgentMetaFile {
    name?: string;
    teamName?: string;
    taskKind?: string;
}

function readSidechainMeta(jsonlPath: string): AgentMetaFile | undefined {
    const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
    try {
        const parsed = SafeJSON.parse(readFileSync(metaPath, "utf8"), { strict: true });
        if (!parsed || typeof parsed !== "object") {
            return undefined;
        }

        const rec = parsed as Record<string, unknown>;
        return {
            name: typeof rec.name === "string" ? rec.name : undefined,
            teamName: typeof rec.teamName === "string" ? rec.teamName : undefined,
            taskKind: typeof rec.taskKind === "string" ? rec.taskKind : undefined,
        };
    } catch (error) {
        logger.debug({ error, metaPath }, "[teams] sidechain meta missing or unreadable");
        return undefined;
    }
}

function summarizeSlice(
    path: string,
    mtimeMs: number,
    agentName: string | null,
    teamName: string,
    head: string,
    tail: string,
    extra?: { sidechain?: boolean; sessionIdOverride?: string }
): TeammateTranscriptRef | undefined {
    let sessionId =
        extra?.sessionIdOverride || (isSidechainPath(path) ? parentSessionIdFromSidechainPath(path) : undefined);
    if (!sessionId) {
        sessionId = basename(path, ".jsonl");
    }

    let hasLeadAssignment = false;
    let messageCount = 0;
    let lastMessage: TeammateLastMessage | undefined;
    let seenAgent: string | null = agentName;

    const lines = `${head}\n${tail}`.split("\n");
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }

        let obj: Record<string, unknown>;
        try {
            obj = SafeJSON.parse(line, { strict: true }) as Record<string, unknown>;
        } catch (error) {
            // Expected, not exceptional: head and tail are byte slices, so the line
            // at each cut is usually truncated. trace (not debug) because this fires
            // per unparsable line across every transcript in the project.
            logger.trace({ error, path }, "[teams] skipping unparsable transcript line");
            continue;
        }

        if (typeof obj.sessionId === "string" && obj.sessionId && !extra?.sessionIdOverride) {
            sessionId = obj.sessionId;
        }

        const ag = (obj.agentName ?? obj.agent_name) as string | undefined;
        const team = (obj.teamName ?? obj.team_name) as string | undefined;

        if (ag) {
            seenAgent = ag;
        }

        if (agentName && ag && ag !== agentName) {
            continue;
        }

        if (team && team !== teamName && (!ag || (agentName && ag !== agentName))) {
            continue;
        }

        if (obj.type === "user" || obj.type === "assistant") {
            messageCount++;
            const msg = obj.message as Record<string, unknown> | undefined;
            const text = contentToText(msg?.content);
            if (!text) {
                continue;
            }

            const isLeadAssignment =
                obj.type === "user" && (text.includes("<teammate-message") || text.includes('teammate_id="team-lead"'));

            if (isLeadAssignment) {
                hasLeadAssignment = true;
            }

            lastMessage = {
                role: obj.type === "user" ? "user" : "assistant",
                text: isLeadAssignment ? stripTeammateEnvelope(text) : text,
                timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
                isLeadAssignment,
            };
        }
    }

    if (!seenAgent && messageCount === 0) {
        return undefined;
    }

    // Fallback for a slice where no line parsed: compare decoded names, since a
    // literal spelling of `agentName` misses anything JSON had to escape.
    if (agentName && !seenAgent && !agentNamesIn(head).has(agentName)) {
        return undefined;
    }

    return {
        sessionId,
        path,
        mtimeMs,
        hasLeadAssignment,
        lastMessage,
        messageCount,
        sidechain: extra?.sidechain || isSidechainPath(path) || undefined,
    };
}

interface ProjectIndexCacheEntry {
    fingerprint: string;
    byTeam: Map<string, Map<string, TeammateTranscriptRef>>;
}

const indexCache = new Map<string, ProjectIndexCacheEntry>();

/**
 * Cheap "did anything change" key for a project dir: the file set plus each
 * file's mtime/size, and the team list the index was built for. Stats are
 * metadata-only, so this costs a fraction of re-reading every head/tail.
 */
function projectFingerprint(projectDir: string, files: string[], teamNames: string[]): string {
    const parts: string[] = [teamNames.join(",")];

    for (const file of files) {
        try {
            const st = statSync(file);
            parts.push(`${file}:${st.mtimeMs}:${st.size}`);
        } catch (error) {
            logger.debug({ error, projectDir, file }, "[teams] transcript stat failed; treating index as stale");
            return `stale-${Date.now()}`;
        }
    }

    return parts.join("|");
}

/** Top-level `*.jsonl` plus `<session>/subagents/*.jsonl` (in-process teammates). */
function listTranscriptFiles(projectDir: string): string[] | null {
    let entries: Dirent[];
    try {
        entries = readdirSync(projectDir, { withFileTypes: true });
    } catch (error) {
        logger.debug({ error, projectDir }, "[teams] could not list the project dir; no transcripts indexed");
        return null;
    }

    const files: string[] = [];
    for (const ent of entries) {
        if (ent.isFile() && ent.name.endsWith(".jsonl")) {
            files.push(join(projectDir, ent.name));
            continue;
        }

        if (!ent.isDirectory()) {
            continue;
        }

        const subDir = join(projectDir, ent.name, "subagents");
        let subEntries: string[];
        try {
            subEntries = readdirSync(subDir);
        } catch (error) {
            // Most sessions have no subagents dir at all, so a missing one is
            // not worth a line; anything else (permissions, a broken link) is.
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
                logger.debug({ error, subDir }, "[teams] could not list a subagents dir; its teammates stay unindexed");
            }

            continue;
        }

        for (const name of subEntries) {
            if (name.endsWith(".jsonl")) {
                files.push(join(subDir, name));
            }
        }
    }

    return files;
}

function rememberHit(
    byAgent: Map<string, TeammateTranscriptRef>,
    agentName: string,
    parsed: TeammateTranscriptRef
): boolean {
    const prev = byAgent.get(agentName);
    if (!prev || parsed.mtimeMs > prev.mtimeMs) {
        byAgent.set(agentName, parsed);
        return true;
    }

    return false;
}

/**
 * One pass over a project dir for MANY teams at once.
 * Returns Map<teamName, Map<agentName, transcript>>.
 *
 * Previously we re-scanned 241 × multi‑10MB jsonls once per team (4–8s).
 * Now: head/tail only, one pass, shared across all teams in that project.
 */
export function indexProjectTranscripts(
    projectDir: string,
    teamNames: string[]
): Map<string, Map<string, TeammateTranscriptRef>> {
    return prof.measure("index-project-transcripts", () => {
        const byTeam = new Map<string, Map<string, TeammateTranscriptRef>>();
        for (const t of teamNames) {
            byTeam.set(t, new Map());
        }

        if (teamNames.length === 0) {
            return byTeam;
        }

        const teamSet = new Set(teamNames);
        const files = listTranscriptFiles(projectDir);
        if (files === null) {
            return byTeam;
        }

        // `tools claude teams --watch` re-discovers every 2s; without this the whole
        // project dir gets head/tail-read again each tick even when nothing changed.
        // N cheap stats replace N × 80 KiB of reads, and any write invalidates.
        const fingerprint = projectFingerprint(projectDir, files, teamNames);
        const cached = indexCache.get(projectDir);
        if (cached?.fingerprint === fingerprint) {
            prof.mark(`project-index ${basename(projectDir)}: cache hit (${files.length} files)`);
            return cached.byTeam;
        }

        let scanned = 0;
        let skippedLarge = 0;
        let hits = 0;

        for (const path of files) {
            const slice = readHeadTail(path);
            if (!slice) {
                continue;
            }

            scanned++;
            const { head, tail, size, mtimeMs } = slice;
            const hay = `${head}\n${tail}`;

            if (isSidechainPath(path)) {
                const meta = readSidechainMeta(path);
                const agentName = meta?.name;
                const metaTeam = meta?.teamName;
                if (!agentName || agentName === "team-lead") {
                    continue;
                }

                // An ordinary subagent sidecar is not a teammate. Only a
                // declared kind rules it out; older metas carry none.
                if (meta?.taskKind !== undefined && meta.taskKind !== "in_process_teammate") {
                    continue;
                }

                // Metadata wins when it names a team. Letting the transcript
                // TEXT also match would index this agent under any other team
                // whose name merely appears in the head or tail, and a later
                // reattach would then resume the wrong lead session.
                const hitTeams =
                    metaTeam !== undefined && metaTeam.length > 0
                        ? teamSet.has(metaTeam)
                            ? [metaTeam]
                            : []
                        : [...teamSet].filter((t) => hay.includes(t));

                if (hitTeams.length === 0) {
                    continue;
                }

                const parentId = parentSessionIdFromSidechainPath(path);
                for (const teamName of hitTeams) {
                    const parsed = summarizeSlice(path, mtimeMs, agentName, teamName, head, tail, {
                        sidechain: true,
                        sessionIdOverride: parentId,
                    });
                    if (!parsed) {
                        continue;
                    }

                    if (rememberHit(byTeam.get(teamName)!, agentName, parsed)) {
                        hits++;
                    }
                }

                continue;
            }

            // Which of our teams appear in this slice?
            const hitTeams: string[] = [];
            for (const t of teamSet) {
                if (hay.includes(t)) {
                    hitTeams.push(t);
                }
            }

            if (hitTeams.length === 0) {
                if (size > SKIP_LARGE_WITHOUT_AGENT_BYTES) {
                    skippedLarge++;
                }

                continue;
            }

            // Agents present in the slice
            const agentNames = agentNamesIn(hay);

            if (agentNames.size === 0) {
                continue;
            }

            // Large files only earn a full summarize pass when the agent shows up
            // early. Resolved once per file, against decoded names, rather than
            // rebuilt per agent.
            const headAgentNames = size > SKIP_LARGE_WITHOUT_AGENT_BYTES ? agentNamesIn(head.slice(0, 8192)) : null;

            for (const teamName of hitTeams) {
                const byAgent = byTeam.get(teamName)!;
                for (const agentName of agentNames) {
                    if (headAgentNames && !headAgentNames.has(agentName)) {
                        continue;
                    }

                    const parsed = summarizeSlice(path, mtimeMs, agentName, teamName, head, tail);
                    if (!parsed) {
                        continue;
                    }

                    if (rememberHit(byAgent, agentName, parsed)) {
                        hits++;
                    }
                }
            }
        }

        indexCache.set(projectDir, { fingerprint, byTeam });

        prof.mark(
            `project-index ${basename(projectDir)}: files=${files.length} scanned=${scanned} skipLarge=${skippedLarge} hits=${hits} teams=${teamNames.length}`
        );
        return byTeam;
    });
}

/** Convenience: single team index (detail / tests). */
export function indexTeamTranscripts(projectDir: string, teamName: string): Map<string, TeammateTranscriptRef> {
    return indexProjectTranscripts(projectDir, [teamName]).get(teamName) ?? new Map();
}

/**
 * Single-agent lookup (detail / fallback). Still uses head/tail only.
 */
export function findTeammateTranscript(opts: {
    teamName: string;
    agentName: string;
    projectDir?: string;
}): TeammateTranscriptRef | undefined {
    return prof.measure("find-one-transcript", () => {
        if (!opts.projectDir) {
            return undefined;
        }

        const index = indexTeamTranscripts(opts.projectDir, opts.teamName);
        return index.get(opts.agentName);
    });
}
