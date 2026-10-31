import { existsSync, readFileSync } from "node:fs";
import { ClaudeWorkerStore, claudeWorkerSourceHome } from "@app/claude/lib/worker/store";
import { sessionEventsPath } from "@app/codex/lib/paths";
import { CodexSessionStore } from "@app/codex/lib/store";
import { GrokSessionStore } from "@app/grok/lib/store";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { codexAuthMode } from "@genesiscz/utils/codex/turn-cost";
import { isFunctionPart, toolParts } from "@genesiscz/utils/harness/tool-parts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { WorkerBackend } from "@genesiscz/utils/worker/capabilities";
import type { WorkerAuthMode } from "@genesiscz/utils/worker/cost";

const log = logger.child({ component: "ai-spend:worker-sessions" });

/**
 * Every headless worker session the three stores know, read-only. The stores are the only
 * place that names a session, labels it and says which provider home its transcripts went to;
 * ai-spend's loaders find the transcripts from there.
 */
export interface WorkerSessionInfo {
    backend: WorkerBackend;
    name: string;
    /** codex: the thread id; grok and claude: the session uuid. */
    sessionId: string | null;
    /** The provider home holding the transcripts: codex `home`, grok `workerHome`, claude config dir. */
    home: string | null;
    cwd: string;
    model: string | null;
    effort: string | null;
    label: string | null;
    /** From the session record alone; the ledger's rows are better evidence when there are any. */
    auth: WorkerAuthMode;
    account: string | null;
    /** The last moment the session did anything, for skipping sessions older than the window. */
    lastActiveAt: string | null;
}

/** Codex's own `account/updated` notification in the session's event log names the login. */
export function codexLoginFromEvents(name: string): WorkerAuthMode {
    const path = sessionEventsPath(name);

    if (!existsSync(path)) {
        return "unknown";
    }

    try {
        const text = readFileSync(path, "utf8");
        const at = text.indexOf('"method":"account/updated"');

        if (at < 0) {
            return "unknown";
        }

        const start = text.lastIndexOf("\n", at) + 1;
        const end = text.indexOf("\n", at);
        const record: unknown = SafeJSON.parse(text.slice(start, end < 0 ? undefined : end), { strict: true });
        const params = typeof record === "object" && record !== null && "params" in record ? record.params : undefined;

        return typeof params === "object" && params !== null && "authMode" in params
            ? codexAuthMode(params.authMode)
            : "unknown";
    } catch (err) {
        log.debug({ err, name }, "codex event log unreadable while looking for the login");
        return "unknown";
    }
}

export function codexSessions(): WorkerSessionInfo[] {
    const store = new CodexSessionStore();

    return store.listNames().flatMap((name): WorkerSessionInfo[] => {
        const meta = store.readMeta(name);

        if (!meta) {
            return [];
        }

        return [
            {
                backend: "codex",
                name,
                sessionId: meta.threadId ?? null,
                home: meta.home ?? null,
                cwd: meta.cwd,
                model: meta.model ?? null,
                effort: meta.effort ?? null,
                label: meta.label ?? null,
                // A pinned codex account is a ChatGPT login; without one the event log says.
                auth: meta.accountName ? "subscription" : codexLoginFromEvents(name),
                account: meta.accountName ?? null,
                lastActiveAt: meta.lastEventAt ?? meta.startedAt ?? null,
            },
        ];
    });
}

export function grokSessions(): WorkerSessionInfo[] {
    const store = new GrokSessionStore();

    return store.listNames().flatMap((name): WorkerSessionInfo[] => {
        const meta = store.readMeta(name);

        if (!meta) {
            return [];
        }

        return [
            {
                backend: "grok",
                name,
                sessionId: meta.sessionId,
                home: meta.workerHome,
                cwd: meta.cwd,
                model: meta.model ?? null,
                effort: null,
                label: meta.label ?? null,
                // Before `auth` was recorded the worker picked the login at run time; today's
                // files are no evidence of what it picked then.
                auth: meta.auth ?? "unknown",
                account: null,
                lastActiveAt: meta.lastTurn?.at ?? meta.createdAt,
            },
        ];
    });
}

export function claudeSessions(): WorkerSessionInfo[] {
    const store = new ClaudeWorkerStore();

    return store.listNames().flatMap((name): WorkerSessionInfo[] => {
        const meta = store.readMeta(name);

        if (!meta) {
            return [];
        }

        return [
            {
                backend: "claude",
                name,
                sessionId: meta.sessionId,
                home: claudeWorkerSourceHome(meta),
                cwd: meta.cwd,
                model: meta.model ?? null,
                effort: null,
                label: meta.label ?? null,
                // A pinned worker runs on an `anthropic-sub` long-lived token.
                auth: "subscription",
                account: meta.account,
                lastActiveAt: meta.lastTurn?.at ?? meta.createdAt,
            },
        ];
    });
}

/**
 * Each backend's worker store reader: `stores/<harness id>.ts` exports it as `workerSessionsPart` (`toolParts`). The
 * readers open the worker tools' own stores (`@app/codex`, `@app/grok`, `@app/claude`), so they stay here and not on
 * the spend drivers, which the monitor loads on every refresh; only the wanted backends' stores load.
 */
const WORKER_SESSION_READERS = toolParts<() => WorkerSessionInfo[]>({
    meta: import.meta,
    folder: "stores",
    exportName: "workerSessionsPart",
    isPart: isFunctionPart,
});

/** The backends to read, each once and in the standard order, so `--backend codex,codex` reads one store once. */
export function requestedWorkerBackends(backends?: readonly WorkerBackend[]): WorkerBackend[] {
    const wanted = new Set(backends ?? ACCOUNT_PROVIDER_ALIASES);
    return ACCOUNT_PROVIDER_ALIASES.filter((backend) => wanted.has(backend));
}

export function listWorkerSessions(backends?: readonly WorkerBackend[]): WorkerSessionInfo[] {
    return requestedWorkerBackends(backends).flatMap((backend) => WORKER_SESSION_READERS.of(backend)());
}
