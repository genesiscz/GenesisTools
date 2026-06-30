const SESSION_PREFIX_CHARS = 12;

export function deriveMainAgentId(session: string): string {
    const slug = session
        .replace(/[^a-z0-9]/gi, "")
        .slice(0, SESSION_PREFIX_CHARS)
        .toLowerCase();

    if (slug.length === 0) {
        return `main_${Math.floor(Math.random() * 0xffffff)
            .toString(16)
            .padStart(6, "0")}`;
    }

    return `main_${slug}`;
}

export function isMainId(agentId: string): boolean {
    return agentId.startsWith("main_");
}

export function ensureMainPrefix(agentId: string, session: string): string {
    if (isMainId(agentId)) {
        return agentId;
    }

    if (agentId.startsWith("agt_")) {
        return `main_${agentId.slice(4)}`;
    }

    if (agentId === "" || agentId === "main_") {
        return deriveMainAgentId(session);
    }

    return `main_${agentId}`;
}
