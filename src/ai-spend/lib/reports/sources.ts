import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import {
    asNumber,
    asRecord,
    asString,
    fileStem,
    firstFinite,
    isoFromUnknown,
    optionalFinite,
    parseJsonl,
    parseJsonValue,
    pickNumber,
} from "./jsonl";
import type { SourceId, SpendEvent } from "./types";
import { envPathList, readText, walkFiles } from "./walk";

function rootsFromEnv(envName: string, home: string, fallbacks: string[]): string[] {
    const override = envPathList(env.getTrimmed(envName));

    if (override.length > 0) {
        return override;
    }

    return fallbacks.map((rel) => join(home, rel));
}

function emit(partial: Omit<SpendEvent, "source"> & { source: SourceId }): SpendEvent | null {
    if (
        partial.inputTokens === 0 &&
        partial.outputTokens === 0 &&
        partial.cacheCreationTokens === 0 &&
        partial.cacheReadTokens === 0 &&
        (partial.reasoningOutputTokens ?? 0) === 0
    ) {
        return null;
    }

    return partial;
}

function tokensFromUsage(usage: Record<string, unknown> | undefined): {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
} {
    const cache = asRecord(usage?.cache);
    return {
        inputTokens: pickNumber(usage, ["inputTokens", "input_tokens", "input", "prompt_tokens", "promptTokens"]),
        outputTokens: pickNumber(usage, [
            "outputTokens",
            "output_tokens",
            "output",
            "completion_tokens",
            "completionTokens",
            "candidates_tokens",
            "candidatesTokenCount",
        ]),
        cacheCreationTokens:
            pickNumber(usage, [
                "cacheCreationTokens",
                "cache_creation_input_tokens",
                "cacheWrite",
                "cache_write",
                "cacheCreationInputTokens",
            ]) || pickNumber(cache, ["write"]),
        cacheReadTokens:
            pickNumber(usage, [
                "cacheReadTokens",
                "cache_read_input_tokens",
                "cacheRead",
                "cache_read",
                "cached_tokens",
                "cachedContentTokenCount",
                "cacheReadInputTokens",
            ]) || pickNumber(cache, ["read"]),
    };
}

export function loadAmpEvents(home: string): SpendEvent[] {
    const roots = rootsFromEnv("AMP_DATA_DIR", home, [".local/share/amp"]);
    const files = walkFiles(
        roots.map((root) => join(root, "threads")),
        { maxDepth: 2, isFile: (name) => name.startsWith("T-") && name.endsWith(".json") }
    );
    const events: SpendEvent[] = [];

    for (const file of files) {
        const content = readText(file);

        if (content === null) {
            continue;
        }

        const thread = asRecord(parseJsonValue(content));

        if (!thread) {
            continue;
        }

        const threadId = asString(thread.id) ?? fileStem(file);
        const ledger = asRecord(thread.usageLedger) ?? asRecord(thread.usage_ledger);
        const ledgerEvents = Array.isArray(ledger?.events) ? ledger.events : [];

        if (ledgerEvents.length > 0) {
            for (const raw of ledgerEvents) {
                const event = asRecord(raw);

                if (!event) {
                    continue;
                }

                const tokens = asRecord(event.tokens);
                const spent = emit({
                    source: "amp",
                    id: String(event.id ?? `${threadId}|${event.timestamp}`),
                    model: asString(event.model) ?? "unknown",
                    timestamp: isoFromUnknown(event.timestamp),
                    sessionId: threadId,
                    project: "amp",
                    inputTokens: pickNumber(tokens, ["input", "inputTokens"]),
                    outputTokens: pickNumber(tokens, ["output", "outputTokens"]),
                    cacheCreationTokens: 0,
                    cacheReadTokens: 0,
                    recordedCostUsd: optionalFinite(event.credits),
                });

                if (spent) {
                    events.push(spent);
                }
            }

            continue;
        }

        const messages = Array.isArray(thread.messages) ? thread.messages : [];

        for (const [index, raw] of messages.entries()) {
            const message = asRecord(raw);

            if (!message) {
                continue;
            }

            const usage = asRecord(message.usage);
            const tokens = tokensFromUsage(usage);
            const spent = emit({
                source: "amp",
                id: asString(message.messageId) ?? asString(message.message_id) ?? `${threadId}:${index}`,
                model: asString(message.model) ?? "unknown",
                timestamp: isoFromUnknown(message.timestamp),
                sessionId: threadId,
                project: "amp",
                ...tokens,
            });

            if (spent) {
                events.push(spent);
            }
        }
    }

    return events;
}

export function loadDroidEvents(home: string): SpendEvent[] {
    const roots = rootsFromEnv("DROID_SESSIONS_DIR", home, [".factory/sessions"]);
    const files = walkFiles(roots, { maxDepth: 3, isFile: (name) => name.endsWith(".settings.json") });
    const events: SpendEvent[] = [];

    for (const file of files) {
        const content = readText(file);

        if (content === null) {
            continue;
        }

        const settings = asRecord(parseJsonValue(content));

        if (!settings) {
            continue;
        }

        const usage = asRecord(settings.tokenUsage);
        const spent = emit({
            source: "droid",
            id: file,
            model: asString(settings.model) ?? "unknown",
            timestamp: isoFromUnknown(settings.updatedAt ?? settings.createdAt ?? settings.timestamp),
            sessionId: basename(file).replace(/\.settings\.json$/, ""),
            project: "droid",
            inputTokens: pickNumber(usage, ["inputTokens"]),
            outputTokens: pickNumber(usage, ["outputTokens"]),
            cacheCreationTokens: pickNumber(usage, ["cacheCreationTokens"]),
            cacheReadTokens: pickNumber(usage, ["cacheReadTokens"]),
            reasoningOutputTokens: pickNumber(usage, ["thinkingTokens"]),
        });

        if (spent) {
            events.push(spent);
        }
    }

    return events;
}

export function loadCodebuffEvents(home: string): SpendEvent[] {
    const override = envPathList(env.getTrimmed("CODEBUFF_DATA_DIR"));
    const roots =
        override.length > 0
            ? override.map((path) => (basename(path) === "projects" ? path : join(path, "projects")))
            : ["manicode", "manicode-dev", "manicode-staging"].map((channel) =>
                  join(home, ".config", channel, "projects")
              );
    const files = walkFiles(roots, { maxDepth: 6, isFile: (name) => name === "chat-messages.json" });
    const events: SpendEvent[] = [];

    for (const file of files) {
        const content = readText(file);

        if (content === null) {
            continue;
        }

        const parsed = parseJsonValue(content);
        const messages = Array.isArray(parsed) ? parsed : [];
        const sessionId = dirname(file).split("/").slice(-2).join("/");

        for (const [index, raw] of messages.entries()) {
            const message = asRecord(raw);

            if (!message) {
                continue;
            }

            const role = asString(message.role) ?? asString(message.type);

            if (role && role !== "assistant") {
                continue;
            }

            const usage = tokensFromUsage(asRecord(message.usage) ?? asRecord(message.tokenUsage) ?? message);
            const spent = emit({
                source: "codebuff",
                id: asString(message.id) ?? `${sessionId}:${index}`,
                model: asString(message.model) ?? "codebuff-unknown",
                timestamp: isoFromUnknown(message.timestamp ?? message.createdAt),
                sessionId,
                project: "codebuff",
                ...usage,
            });

            if (spent) {
                events.push(spent);
            }
        }
    }

    return events;
}

export function loadPiEvents(home: string): SpendEvent[] {
    const roots = rootsFromEnv("PI_AGENT_DIR", home, [".pi/agent/sessions"]);
    const files = walkFiles(roots, { maxDepth: 4, isFile: (name) => name.endsWith(".jsonl") });
    const events: SpendEvent[] = [];

    for (const file of files) {
        const content = readText(file);

        if (content === null) {
            continue;
        }

        const sessionId = fileStem(file);

        for (const row of parseJsonl(content)) {
            const raw = asRecord(row);

            if (!raw) {
                continue;
            }

            const message = asRecord(raw.message);
            const role = asString(raw.type) ?? asString(message?.role);

            if (role && role !== "assistant") {
                continue;
            }

            const usage = asRecord(message?.usage);
            const spent = emit({
                source: "pi",
                id: asString(message?.id) ?? `${sessionId}|${asString(raw.timestamp)}`,
                model: asString(message?.model) ?? "unknown",
                timestamp: isoFromUnknown(raw.timestamp),
                sessionId,
                project: "pi",
                inputTokens: pickNumber(usage, ["input"]),
                outputTokens: pickNumber(usage, ["output"]),
                cacheCreationTokens: pickNumber(usage, ["cacheWrite"]),
                cacheReadTokens: pickNumber(usage, ["cacheRead"]),
                recordedCostUsd: optionalFinite(asRecord(usage?.cost)?.total),
            });

            if (spent) {
                events.push(spent);
            }
        }
    }

    return events;
}

export function loadKimiEvents(home: string): SpendEvent[] {
    const override = envPathList(env.getTrimmed("KIMI_DATA_DIR"));
    const roots = override.length > 0 ? override : [join(home, ".kimi"), join(home, ".kimi-code")];
    const files = walkFiles(
        roots.map((root) => join(root, "sessions")),
        { maxDepth: 4, isFile: (name) => name === "wire.jsonl" }
    );
    const events: SpendEvent[] = [];

    for (const file of files) {
        const content = readText(file);

        if (content === null) {
            continue;
        }

        const sessionId = basename(dirname(file));

        for (const row of parseJsonl(content)) {
            const raw = asRecord(row);

            if (!raw) {
                continue;
            }

            const message = asRecord(raw.message);
            const payload = asRecord(message?.payload);
            const usage = asRecord(payload?.token_usage) ?? asRecord(raw.usage);
            const timestamp = isoFromUnknown(raw.timestamp ?? raw.time);
            const spent = emit({
                source: "kimi",
                id: asString(payload?.message_id) ?? `${sessionId}|${timestamp}`,
                model: asString(raw.model) ?? "kimi-for-coding",
                timestamp,
                sessionId,
                project: "kimi",
                inputTokens: pickNumber(usage, ["input_other", "input"]),
                outputTokens: pickNumber(usage, ["output"]),
                cacheCreationTokens: pickNumber(usage, ["input_cache_creation"]),
                cacheReadTokens: pickNumber(usage, ["input_cache_read"]),
            });

            if (spent) {
                events.push(spent);
            }
        }
    }

    return events;
}

export function loadGeminiEvents(home: string): SpendEvent[] {
    const roots = rootsFromEnv("GEMINI_DATA_DIR", home, [".gemini"]).map((root) =>
        basename(root) === "tmp" ? root : join(root, "tmp")
    );
    const files = walkFiles(roots, {
        maxDepth: 6,
        isFile: (name) => name.endsWith(".json") || name.endsWith(".jsonl"),
    });
    const events: SpendEvent[] = [];

    const pushRecord = (raw: Record<string, unknown>, file: string, index: number): void => {
        const tokens =
            asRecord(raw.tokens) ?? asRecord(raw.stats) ?? asRecord(raw.result) ?? asRecord(raw.usage_metadata);
        const sessionId = asString(raw.sessionId) ?? asString(raw.session_id) ?? fileStem(file);
        const spent = emit({
            source: "gemini",
            id: asString(raw.id) ?? `${sessionId}:${index}`,
            model: asString(raw.model) ?? "unknown",
            timestamp: isoFromUnknown(raw.timestamp ?? raw.created_at ?? raw.startTime ?? raw.lastUpdated),
            sessionId,
            project: "gemini",
            inputTokens: pickNumber(tokens, ["input_tokens", "prompt_tokens", "promptTokenCount"]),
            outputTokens: pickNumber(tokens, ["output_tokens", "candidates_tokens", "candidatesTokenCount"]),
            cacheCreationTokens: 0,
            cacheReadTokens: pickNumber(tokens, ["cached_tokens", "cachedContentTokenCount"]),
        });

        if (spent) {
            events.push(spent);
        }
    };

    for (const file of files) {
        const content = readText(file);

        if (content === null) {
            continue;
        }

        if (file.endsWith(".jsonl")) {
            for (const [index, row] of parseJsonl(content).entries()) {
                const raw = asRecord(row);

                if (raw) {
                    pushRecord(raw, file, index);
                }
            }

            continue;
        }

        const parsed = parseJsonValue(content);
        const raw = asRecord(parsed);

        if (raw) {
            const messages = Array.isArray(raw.messages) ? raw.messages : [raw];

            for (const [index, message] of messages.entries()) {
                const rec = asRecord(message) ?? raw;
                pushRecord(rec, file, index);
            }
        }
    }

    return events;
}

export function loadQwenEvents(home: string): SpendEvent[] {
    const roots = rootsFromEnv("QWEN_DATA_DIR", home, [".qwen"]).map((root) => join(root, "projects"));
    const files = walkFiles(roots, { maxDepth: 6, isFile: (name) => name.endsWith(".jsonl") });
    const events: SpendEvent[] = [];

    for (const file of files) {
        const content = readText(file);

        if (content === null) {
            continue;
        }

        const fallbackSession = fileStem(file);

        for (const [index, row] of parseJsonl(content).entries()) {
            const raw = asRecord(row);

            if (!raw) {
                continue;
            }

            const usage = asRecord(raw.usageMetadata) ?? asRecord(raw.usage_metadata);
            const spent = emit({
                source: "qwen",
                id: `${asString(raw.sessionId) ?? fallbackSession}:${index}`,
                model: asString(raw.model) ?? "unknown",
                timestamp: isoFromUnknown(raw.timestamp),
                sessionId: asString(raw.sessionId) ?? asString(raw.session_id) ?? fallbackSession,
                project: "qwen",
                inputTokens: pickNumber(usage, ["promptTokenCount", "prompt_token_count"]),
                outputTokens: pickNumber(usage, ["candidatesTokenCount", "candidates_token_count"]),
                cacheCreationTokens: 0,
                cacheReadTokens: pickNumber(usage, ["cachedContentTokenCount", "cached_content_token_count"]),
                reasoningOutputTokens: pickNumber(usage, ["thoughtsTokenCount", "thoughts_token_count"]),
            });

            if (spent) {
                events.push(spent);
            }
        }
    }

    return events;
}

export function loadOpenclawEvents(home: string): SpendEvent[] {
    const override = envPathList(env.getTrimmed("OPENCLAW_DIR"));
    const roots =
        override.length > 0
            ? override
            : [".openclaw", ".clawdbot", ".moltbot", ".moldbot"].map((dir) => join(home, dir));
    const files = walkFiles(roots, { maxDepth: 8, isFile: (name) => name.endsWith(".jsonl") });
    const events: SpendEvent[] = [];

    for (const file of files) {
        const content = readText(file);

        if (content === null) {
            continue;
        }

        const sessionId = fileStem(file);
        let stickyModel = "unknown";

        for (const [index, row] of parseJsonl(content).entries()) {
            const raw = asRecord(row);

            if (!raw) {
                continue;
            }

            const data = asRecord(raw.data);
            const modelChange = asString(raw.type) ?? asString(raw.customType);

            if (modelChange === "model_change" || modelChange === "model-snapshot") {
                stickyModel = asString(raw.modelId) ?? asString(raw.model) ?? asString(data?.modelId) ?? stickyModel;
                continue;
            }

            const message = asRecord(raw.message);
            const usage = asRecord(message?.usage);
            const spent = emit({
                source: "openclaw",
                id: `${sessionId}:${index}`,
                model: asString(message?.model) ?? asString(raw.model) ?? stickyModel,
                timestamp: isoFromUnknown(raw.timestamp ?? message?.timestamp),
                sessionId,
                project: "openclaw",
                inputTokens: pickNumber(usage, ["input"]),
                outputTokens: pickNumber(usage, ["output"]),
                cacheCreationTokens: pickNumber(usage, ["cacheWrite"]),
                cacheReadTokens: pickNumber(usage, ["cacheRead"]),
                recordedCostUsd: optionalFinite(asRecord(usage?.cost)?.total),
            });

            if (spent) {
                events.push(spent);
            }
        }
    }

    return events;
}

export function loadCopilotEvents(home: string): SpendEvent[] {
    const override = env.getTrimmed("COPILOT_OTEL_FILE_EXPORTER_PATH");
    const roots = override ? [override] : [join(home, ".copilot", "otel")];
    const files = walkFiles(roots, { maxDepth: 6, isFile: (name) => name.endsWith(".jsonl") });
    const events: SpendEvent[] = [];

    for (const file of files) {
        const content = readText(file);

        if (content === null) {
            continue;
        }

        for (const [index, row] of parseJsonl(content).entries()) {
            const raw = asRecord(row);

            if (!raw || !asRecord(raw.attributes)) {
                continue;
            }

            const attributes = asRecord(raw.attributes) ?? {};
            const input = asNumber(attributes["gen_ai.usage.input_tokens"]);
            const output = asNumber(attributes["gen_ai.usage.output_tokens"]);
            const cacheRead = asNumber(attributes["gen_ai.usage.cache_read.input_tokens"]);
            const cacheWrite = asNumber(
                attributes["gen_ai.usage.cache_write.input_tokens"] ?? attributes["gen_ai.usage.cached_input_tokens"]
            );
            const model =
                asString(attributes["gen_ai.request.model"]) ??
                asString(attributes["gen_ai.response.model"]) ??
                "unknown";
            const sessionId =
                asString(attributes["session.id"]) ?? asString(attributes["gen_ai.conversation.id"]) ?? fileStem(file);
            const spent = emit({
                source: "copilot",
                id: asString(raw.spanId) ?? `${sessionId}:${index}`,
                model,
                timestamp: isoFromUnknown(raw.startTime ?? raw.timestamp ?? raw.timeUnixNano),
                sessionId,
                project: "copilot",
                inputTokens: input,
                outputTokens: output,
                cacheCreationTokens: cacheWrite,
                cacheReadTokens: cacheRead,
            });

            if (spent) {
                events.push(spent);
            }
        }
    }

    return events;
}

function readSqliteRows(
    path: string,
    sql: string,
    map: (row: Record<string, unknown>) => SpendEvent | null
): SpendEvent[] {
    if (!existsSync(path)) {
        return [];
    }

    const events: SpendEvent[] = [];

    try {
        const db = new Database(path, { readonly: true });

        try {
            const rows = db.query(sql).all() as Record<string, unknown>[];

            for (const row of rows) {
                const event = map(row);

                if (event) {
                    events.push(event);
                }
            }
        } finally {
            db.close();
        }
    } catch (err) {
        logger.debug({ err, path }, "ai-spend: sqlite source unreadable");
    }

    return events;
}

function parseOpenCodeLike(source: SourceId, data: unknown, id: string, sessionId: string): SpendEvent | null {
    const raw = asRecord(data);

    if (!raw) {
        return null;
    }

    const tokens = asRecord(raw.tokens);
    const cache = asRecord(tokens?.cache);
    const time = asRecord(raw.time);
    return emit({
        source,
        id: asString(raw.id) ?? id,
        model: asString(raw.modelID) ?? asString(raw.modelId) ?? "unknown",
        timestamp: isoFromUnknown(time?.created ?? raw.time),
        sessionId: asString(raw.sessionID) ?? asString(raw.session_id) ?? sessionId,
        project: source,
        inputTokens: pickNumber(tokens, ["input"]),
        outputTokens: pickNumber(tokens, ["output"]),
        cacheCreationTokens: pickNumber(cache, ["write"]),
        cacheReadTokens: pickNumber(cache, ["read"]),
        recordedCostUsd: optionalFinite(raw.cost),
        reasoningOutputTokens: pickNumber(tokens, ["reasoning"]),
    });
}

export function loadOpencodeEvents(home: string): SpendEvent[] {
    const roots = rootsFromEnv("OPENCODE_DATA_DIR", home, [".local/share/opencode"]);
    const events: SpendEvent[] = [];

    for (const root of roots) {
        const dbPath = existsSync(join(root, "opencode.db")) ? join(root, "opencode.db") : undefined;

        if (dbPath) {
            events.push(
                ...readSqliteRows(dbPath, "SELECT id, session_id, data FROM message", (row) => {
                    const data = typeof row.data === "string" ? parseJsonValue(row.data) : row.data;
                    return parseOpenCodeLike("opencode", data, String(row.id), String(row.session_id ?? "unknown"));
                })
            );
        }

        const files = walkFiles([join(root, "storage", "message")], {
            maxDepth: 3,
            isFile: (name) => name.endsWith(".json"),
        });

        for (const file of files) {
            const content = readText(file);

            if (content === null) {
                continue;
            }

            const event = parseOpenCodeLike(
                "opencode",
                parseJsonValue(content),
                fileStem(file),
                basename(dirname(file))
            );

            if (event) {
                events.push(event);
            }
        }
    }

    return events;
}

export function loadKiloEvents(home: string): SpendEvent[] {
    const roots = rootsFromEnv("KILO_DATA_DIR", home, [".local/share/kilo"]);
    const events: SpendEvent[] = [];

    for (const root of roots) {
        events.push(
            ...readSqliteRows(join(root, "kilo.db"), "SELECT id, session_id, data FROM message", (row) => {
                const data = typeof row.data === "string" ? parseJsonValue(row.data) : row.data;
                return parseOpenCodeLike("kilo", data, String(row.id), String(row.session_id ?? "unknown"));
            })
        );
    }

    return events;
}

export function loadHermesEvents(home: string): SpendEvent[] {
    const override = envPathList(env.getTrimmed("HERMES_HOME"));
    const homes = override.length > 0 ? override : [join(home, ".hermes")];
    const events: SpendEvent[] = [];

    for (const root of homes) {
        events.push(
            ...readSqliteRows(
                join(root, "state.db"),
                `SELECT id, model, billing_provider, started_at, message_count, input_tokens, output_tokens,
                        cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd
                 FROM sessions WHERE model IS NOT NULL`,
                (row) =>
                    emit({
                        source: "hermes",
                        id: String(row.id),
                        model: String(row.model ?? "unknown"),
                        timestamp: isoFromUnknown(row.started_at),
                        sessionId: String(row.id),
                        project: "hermes",
                        inputTokens: asNumber(row.input_tokens),
                        outputTokens: asNumber(row.output_tokens),
                        cacheCreationTokens: asNumber(row.cache_write_tokens),
                        cacheReadTokens: asNumber(row.cache_read_tokens),
                        reasoningOutputTokens: asNumber(row.reasoning_tokens),
                        recordedCostUsd: optionalFinite(row.actual_cost_usd) ?? optionalFinite(row.estimated_cost_usd),
                    })
            )
        );
    }

    return events;
}

export function loadGooseEvents(home: string): SpendEvent[] {
    const override = env.getTrimmed("GOOSE_PATH_ROOT");
    const dbs = override
        ? [join(override, "data", "sessions", "sessions.db")]
        : [
              join(home, ".local/share/goose/sessions/sessions.db"),
              join(home, "Library/Application Support/goose/sessions/sessions.db"),
              join(home, ".local/share/Block/goose/sessions/sessions.db"),
          ];
    const events: SpendEvent[] = [];

    for (const db of dbs) {
        events.push(
            ...readSqliteRows(
                db,
                `SELECT id, model_config_json, provider_name, created_at, total_tokens, input_tokens, output_tokens,
                        accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens
                 FROM sessions WHERE model_config_json IS NOT NULL`,
                (row) => {
                    const config = asRecord(
                        typeof row.model_config_json === "string"
                            ? parseJsonValue(row.model_config_json)
                            : row.model_config_json
                    );
                    const input = firstFinite(row.accumulated_input_tokens, row.input_tokens);
                    const output = firstFinite(row.accumulated_output_tokens, row.output_tokens);
                    return emit({
                        source: "goose",
                        id: String(row.id),
                        model: asString(config?.model_name) ?? "unknown",
                        timestamp: isoFromUnknown(row.created_at),
                        sessionId: String(row.id),
                        project: "goose",
                        inputTokens: input,
                        outputTokens: output,
                        cacheCreationTokens: 0,
                        cacheReadTokens: 0,
                    });
                }
            )
        );
    }

    return events;
}

const LOADERS: Record<Exclude<SourceId, "claude" | "codex" | "grok">, (home: string) => SpendEvent[]> = {
    amp: loadAmpEvents,
    droid: loadDroidEvents,
    codebuff: loadCodebuffEvents,
    pi: loadPiEvents,
    kimi: loadKimiEvents,
    gemini: loadGeminiEvents,
    qwen: loadQwenEvents,
    openclaw: loadOpenclawEvents,
    copilot: loadCopilotEvents,
    opencode: loadOpencodeEvents,
    kilo: loadKiloEvents,
    hermes: loadHermesEvents,
    goose: loadGooseEvents,
};

export function loadExtraSource(source: Exclude<SourceId, "claude" | "codex" | "grok">, home: string): SpendEvent[] {
    return LOADERS[source](home);
}
