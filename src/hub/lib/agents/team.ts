import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTeamConfig, teamsRoot } from "@app/claude/lib/teams/discover";
import type { TeamMemberConfig } from "@app/claude/lib/teams/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** Claude Code names a session's team `session-<first 8 characters of the lead's session id>`. */
export function sessionTeamName(sessionId: string): string {
    return `session-${sessionId.slice(0, 8)}`;
}

export interface InboxEntry {
    from: string;
    text: string;
    timestamp: string | null;
    read: boolean;
}

export interface SessionTeam {
    name: string;
    root: string;
    /** Current members by name. Claude Code drops a teammate from the config when it shuts down. */
    members: Map<string, TeamMemberConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The team a lead session owns, or null when it never had one. */
export function readSessionTeam(sessionId: string, root: string = teamsRoot()): SessionTeam | null {
    const name = sessionTeamName(sessionId);
    const config = readTeamConfig(name, root);
    if (!config) {
        return null;
    }

    const members = new Map<string, TeamMemberConfig>();
    for (const member of Array.isArray(config.members) ? config.members : []) {
        if (isRecord(member) && typeof member.name === "string") {
            members.set(member.name, member);
        }
    }

    return { name, root, members };
}

/** A teammate's inbox file (`inboxes/<name>.json`): mail the lead or a peer wrote for it. */
export function readInbox(root: string, team: string, member: string): InboxEntry[] {
    const path = join(root, team, "inboxes", `${member}.json`);
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (error) {
        logger.debug({ error, path }, "[hub agents] no inbox");
        return [];
    }

    try {
        const value: unknown = SafeJSON.parse(raw, { strict: true });
        if (!Array.isArray(value)) {
            return [];
        }

        return value.filter(isRecord).map((entry) => ({
            from: typeof entry.from === "string" ? entry.from : "unknown",
            text: typeof entry.text === "string" ? entry.text : "",
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
            read: entry.read === true,
        }));
    } catch (error) {
        logger.debug({ error, path }, "[hub agents] unreadable inbox");
        return [];
    }
}

export function unreadInbox(root: string, team: string, member: string): InboxEntry[] {
    return readInbox(root, team, member).filter((entry) => !entry.read);
}
