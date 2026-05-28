import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { collapsePathForDisplay, toPosixPath } from "@app/utils/paths.client";

export interface SessionHeaderParts {
    badge: string;
    name: string;
    cwd?: string;
    command?: string;
    title: string;
}

function isLikelyDirectoryPath(value: string): boolean {
    const normalized = toPosixPath(value.trim());

    if (!normalized) {
        return false;
    }

    if (normalized.startsWith("~/") || normalized === "~") {
        return true;
    }

    if (normalized.startsWith("/")) {
        return true;
    }

    if (/^[A-Za-z]:[\\/]/.test(normalized)) {
        return true;
    }

    return false;
}

function resolveSessionCwd(session: DashboardSession): string | undefined {
    const rawPath = session.projectPath.trim();

    if (!rawPath || !isLikelyDirectoryPath(rawPath)) {
        return undefined;
    }

    return collapsePathForDisplay(rawPath);
}

export function collectSessionCwds(sessions: readonly DashboardSession[]): string[] {
    const cwds: string[] = [];

    for (const session of sessions) {
        const cwd = resolveSessionCwd(session);

        if (cwd) {
            cwds.push(cwd);
        }
    }

    return cwds;
}

export function collectSessionDirSources(sessions: readonly DashboardSession[]): string[] {
    const sources: string[] = [];

    for (const session of sessions) {
        const rawPath = session.projectPath.trim();

        if (rawPath && isLikelyDirectoryPath(rawPath)) {
            sources.push(rawPath);
        }
    }

    return sources;
}

export function formatSessionHeaderParts(session: DashboardSession): SessionHeaderParts {
    const command = session.command?.trim() || undefined;
    const cwd = resolveSessionCwd(session);

    const segments = [session.name];
    if (cwd) {
        segments.push(cwd);
    }
    if (command) {
        segments.push(command);
    }

    return {
        badge: session.badge,
        name: session.name,
        cwd,
        command,
        title: `[${session.badge}] ${segments.join(" · ")}`,
    };
}

/** @deprecated use formatSessionHeaderParts */
export function formatSessionRunContext(session: DashboardSession): {
    directory?: string;
    command?: string;
    title: string;
} {
    const parts = formatSessionHeaderParts(session);

    return {
        directory: parts.cwd,
        command: parts.command,
        title: parts.title,
    };
}
