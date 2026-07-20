/** A short relative time ("now", "5m", "3h", "2d") from an ISO timestamp or epoch-ms number. */
export function relativeTime(input: string | number): string {
    const ms = typeof input === "number" ? input : Date.parse(input);

    if (Number.isNaN(ms)) {
        return "—";
    }

    const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));

    if (sec < 45) {
        return "now";
    }

    const min = Math.round(sec / 60);

    if (min < 60) {
        return `${min}m`;
    }

    const hr = Math.round(min / 60);

    if (hr < 24) {
        return `${hr}h`;
    }

    const day = Math.round(hr / 24);
    return `${day}d`;
}

export function shortSha(sha: string): string {
    return sha.slice(0, 7);
}

export function basename(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function truncateMiddle(value: string, max: number): string {
    if (value.length <= max) {
        return value;
    }

    const keep = Math.floor((max - 1) / 2);
    return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

/** G12: presentation-only criteria split — newline-separated, trimmed, empties dropped, leading -/* stripped. */
export function splitCriteria(raw: string): string[] {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^[-*]\s*/, ""))
        .filter((line) => line.length > 0);
}

/** Actor chip text for both compact `HandoffActor` (sessionName) and event `by` stamps (sessionTitle). */
export function actorChipLabel(by: {
    sessionName?: string | null;
    sessionTitle?: string | null;
    sessionId?: string | null;
    agent: string;
    via?: string;
}): string {
    const name = by.sessionName ?? by.sessionTitle ?? by.sessionId;

    if (name !== null && name !== undefined) {
        return by.via === "dashboard" ? `${name} · dashboard` : name;
    }

    return by.agent;
}
