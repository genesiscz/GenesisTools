import { suggestCommand } from "@app/utils/cli/executor";

export function suggestTail(session: string): string {
    return suggestCommand("tools task", {
        replaceCommand: ["tail", "--session", session, "--follow"],
        keepFlags: [],
    });
}

export function suggestLogs(session: string, extra: string[] = []): string {
    return suggestCommand("tools task", {
        replaceCommand: ["logs", "--session", session, ...extra],
        keepFlags: [],
    });
}

export function suggestGet(session: string): string {
    return suggestCommand("tools task", {
        replaceCommand: ["get", "--session", session],
        keepFlags: [],
    });
}

export function suggestDashboard(session: string): string {
    return suggestCommand("tools task", {
        replaceCommand: ["dashboard", "open", "--session", session],
        keepFlags: [],
    });
}

export function suggestLogsFollow(session: string): string {
    return suggestCommand("tools task", {
        replaceCommand: ["logs", "--session", session, "--tail", "--follow"],
        keepFlags: [],
    });
}

export function suggestClearOlderThanSeq(session: string, seq: number): string {
    return suggestCommand("tools task", {
        replaceCommand: ["get", "--session", session, "--clear-older-than-seq", String(seq)],
        keepFlags: [],
    });
}
