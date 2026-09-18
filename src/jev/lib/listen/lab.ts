export class ListenSessionConflictError extends Error {
    readonly status = 409;

    constructor() {
        super("A listen session is already running.");
        this.name = "ListenSessionConflictError";
    }
}

export interface ListenLabTail {
    transcript: string;
    status: string;
    choice: string | null;
    probability: number;
    reason: string;
}

export interface ListenLabStatus {
    running: boolean;
    transcript?: string;
    tail: ListenLabTail[];
    wouldPress?: string | null;
}

let session: { transcript?: string; tail: ListenLabTail[] } | null = null;

export function listenLabStatus(): ListenLabStatus {
    if (!session) {
        return { running: false, tail: [] };
    }

    const last = session.tail.at(-1);
    return {
        running: true,
        transcript: last?.transcript ?? session.transcript,
        tail: session.tail,
        wouldPress: last?.status === "would" || last?.status === "act" ? last.choice : null,
    };
}

export function startListenLab(options: { transcript?: string } = {}): ListenLabStatus {
    if (session) {
        throw new ListenSessionConflictError();
    }

    session = { transcript: options.transcript, tail: [] };
    return listenLabStatus();
}

export function stopListenLab(): ListenLabStatus {
    session = null;
    return listenLabStatus();
}

export function appendListenLab(row: ListenLabTail): ListenLabStatus {
    if (!session) {
        throw new Error("No listen session is running.");
    }

    session.tail.push(row);
    return listenLabStatus();
}

export function listenLabTail(): ListenLabTail[] {
    return session?.tail ?? [];
}

export function resetListenLabForTests(): void {
    session = null;
}
