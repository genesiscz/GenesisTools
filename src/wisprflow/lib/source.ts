import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { getLocalMeeting, localAvailable, localMeetingIdForShareSlug } from "./local";
import { getMcpMeeting, McpUnavailableError, resolveMcpShareLink } from "./mcp";
import type { Meeting, SourceChoice, Sourced } from "./types";

const { log } = logger.scoped("wisprflow-source");

const SHARE_BASE = "https://notes.wisprflow.ai/shared/";
const SHARE_RE = /notes\.wisprflow\.ai\/shared\/([\w-]+)/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[\w-]{40,}$/;

/** A meeting id, a share link, or a bare share slug, as a meeting id. */
export async function resolveMeetingRef(ref: string, source: SourceChoice): Promise<string> {
    const slug = ref.match(SHARE_RE)?.[1] ?? (!UUID_RE.test(ref) && SLUG_RE.test(ref) ? ref : undefined);

    if (!slug) {
        return ref;
    }

    if (source !== "mcp" && localAvailable()) {
        const id = localMeetingIdForShareSlug(slug);

        if (id) {
            return id;
        }
    }

    // The MCP tool takes a share URL; a bare slug becomes one.
    const resolved = await resolveMcpShareLink(`${SHARE_BASE}${slug}`);

    if (!resolved.meetingId) {
        throw new Error(`share link ${ref} did not resolve to one of your meetings`);
    }

    return resolved.meetingId;
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Where the MCP and the local copy disagree on who spoke. Empty when they agree. */
function speakerDrift(local: Meeting, remote: Meeting): string[] {
    const localNames = new Set(local.transcript.map((e) => e.speaker));
    const remoteNames = new Set(remote.transcript.map((e) => e.speaker));
    const onlyRemote = [...remoteNames].filter((n) => !localNames.has(n));

    if (onlyRemote.length === 0) {
        return [];
    }

    const onlyLocal = [...localNames].filter((n) => !remoteNames.has(n));
    return [
        `The MCP names speakers ${onlyRemote.join(", ")}; this Mac names them ${onlyLocal.join(", ") || "differently"}.` +
            (local.speakerRenamePending ? " The app has not sent the rename to the server yet." : ""),
    ];
}

/**
 * `auto`: the local copy when the meeting is on this Mac (it alone has renames not yet on the
 * server, timestamps, and transcript corrections), else the MCP. `crossCheck` also asks the MCP
 * and reports where the two disagree.
 */
export async function loadMeeting(
    id: string,
    options: { source: SourceChoice; transcript: boolean; crossCheck?: boolean }
): Promise<Sourced<Meeting>> {
    const notes: string[] = [];

    if (options.source !== "mcp") {
        const local = localAvailable() ? getLocalMeeting(id) : undefined;

        if (local) {
            if (options.crossCheck) {
                try {
                    const remote = await getMcpMeeting(id, { transcript: options.transcript });
                    notes.push(...speakerDrift(local, remote));
                } catch (err) {
                    notes.push(`Cross-check skipped: ${describe(err)}`);
                }
            } else if (local.speakerRenamePending) {
                notes.push("A speaker rename is on this Mac only; the MCP still returns the old names.");
            }

            log.debug({ id, notes }, "meeting answered by local data");
            return { source: "local", data: local, notes };
        }

        if (options.source === "local") {
            throw new Error(
                localAvailable()
                    ? `meeting ${id} is not in the local Wispr Flow database`
                    : "the Wispr Flow app data is not on this Mac"
            );
        }

        notes.push("The meeting is not on this Mac; asked the MCP.");
    }

    try {
        const remote = await getMcpMeeting(id, { transcript: options.transcript });
        log.debug({ id }, "meeting answered by MCP");
        return { source: "mcp", data: remote, notes };
    } catch (err) {
        if (err instanceof McpUnavailableError) {
            throw new Error(`${err.message}. Check '${toolCommand("mcp-manager gateway status")}'.`);
        }

        throw err;
    }
}
