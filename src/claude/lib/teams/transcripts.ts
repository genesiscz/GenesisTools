import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
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
    } catch {
        return null;
    } finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            } catch {
                // ignore
            }
        }
    }
}

function summarizeSlice(
    path: string,
    mtimeMs: number,
    agentName: string | null,
    teamName: string,
    head: string,
    tail: string
): TeammateTranscriptRef | undefined {
    const sessionId = basename(path, ".jsonl");
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
        } catch {
            continue;
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

    if (agentName && !seenAgent && !head.includes(`"agentName":"${agentName}"`)) {
        return undefined;
    }

    return {
        sessionId,
        path,
        mtimeMs,
        hasLeadAssignment,
        lastMessage,
        messageCount,
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

    for (const name of files) {
        try {
            const st = statSync(join(projectDir, name));
            parts.push(`${name}:${st.mtimeMs}:${st.size}`);
        } catch (error) {
            logger.debug({ error, projectDir, name }, "[teams] transcript stat failed; treating index as stale");
            return `stale-${Date.now()}`;
        }
    }

    return parts.join("|");
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
        let files: string[];
        try {
            files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
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

        for (const name of files) {
            const path = join(projectDir, name);
            const slice = readHeadTail(path);
            if (!slice) {
                continue;
            }

            scanned++;
            const { head, tail, size, mtimeMs } = slice;
            const hay = `${head}\n${tail}`;

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
            const agentNames = new Set<string>();
            const agentRe = /"agentName"\s*:\s*"([^"]+)"/g;
            for (const match of hay.matchAll(agentRe)) {
                const name = match[1];
                if (name && name !== "team-lead") {
                    agentNames.add(name);
                }
            }

            if (agentNames.size === 0) {
                continue;
            }

            for (const teamName of hitTeams) {
                const byAgent = byTeam.get(teamName)!;
                for (const agentName of agentNames) {
                    if (
                        size > SKIP_LARGE_WITHOUT_AGENT_BYTES &&
                        !new RegExp(`"agentName"\\s*:\\s*"${agentName}"`).test(head.slice(0, 8192))
                    ) {
                        continue;
                    }

                    const parsed = summarizeSlice(path, mtimeMs, agentName, teamName, head, tail);
                    if (!parsed) {
                        continue;
                    }

                    hits++;
                    const prev = byAgent.get(agentName);
                    if (!prev || parsed.mtimeMs > prev.mtimeMs) {
                        byAgent.set(agentName, parsed);
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
