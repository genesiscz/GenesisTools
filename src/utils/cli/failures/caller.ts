import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { readLastLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { FailureCaller } from "./record";

const TAIL_BYTES = 512 * 1024;
const CODEX_DAYS_BACK = 7;

/** Claude names a project folder after the session's cwd with every non-alphanumeric character as `-`. */
export function claudeProjectFolder(cwd: string): string {
    return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function claudeTranscript(sessionId: string, cwds: string[], configDir: string): string | null {
    const projects = join(configDir, "projects");
    const file = `${sessionId}.jsonl`;

    for (const cwd of cwds) {
        const direct = join(projects, claudeProjectFolder(cwd), file);
        if (existsSync(direct)) {
            return direct;
        }
    }

    if (!existsSync(projects)) {
        return null;
    }

    for (const folder of readdirSync(projects)) {
        const candidate = join(projects, folder, file);
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function codexRollout(threadId: string, codexHome: string, now: Date): string | null {
    for (let back = 0; back < CODEX_DAYS_BACK; back++) {
        const day = new Date(now.getTime() - back * 86_400_000);
        const dir = join(
            codexHome,
            "sessions",
            String(day.getFullYear()),
            String(day.getMonth() + 1).padStart(2, "0"),
            String(day.getDate()).padStart(2, "0")
        );
        if (!existsSync(dir)) {
            continue;
        }

        // Codex 0.164 compresses old rollouts to `.jsonl.zst`; `readLastLines` below reads either form.
        const name = readdirSync(dir).find(
            (entry) => entry.endsWith(`-${threadId}.jsonl`) || entry.endsWith(`-${threadId}.jsonl.zst`)
        );
        if (name) {
            return join(dir, name);
        }
    }

    return null;
}

/** The newest model the transcript tail names: Claude's assistant `message.model`, Codex's `turn_context` model. */
export function modelInTranscriptLines(lines: string[]): string | null {
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line.includes('"model"')) {
            continue;
        }

        let entry: unknown;
        try {
            entry = SafeJSON.parse(line, { strict: true });
        } catch (error) {
            logger.debug({ error }, "failures: a transcript line did not parse");
            continue;
        }

        if (typeof entry !== "object" || entry === null) {
            continue;
        }

        const record = entry as { type?: unknown; message?: { model?: unknown }; payload?: { model?: unknown } };
        const model =
            record.type === "assistant"
                ? record.message?.model
                : record.type === "turn_context"
                  ? record.payload?.model
                  : undefined;
        if (typeof model === "string" && model && !model.startsWith("<")) {
            return model;
        }
    }

    return null;
}

export interface CallerInputs {
    context: AgentRuntimeContext;
    processEnv: NodeJS.ProcessEnv;
    now?: Date;
    home?: string;
}

/** The transcript of the calling session, when this machine has it. */
export function transcriptOf({ context, processEnv, now = new Date(), home = homedir() }: CallerInputs): string | null {
    if (!context.sessionId) {
        return null;
    }

    if (context.agent === "claude-code") {
        const configDir = processEnv.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
        return claudeTranscript(context.sessionId, [context.cwd, context.repoRoot], configDir);
    }

    if (context.agent === "codex") {
        return codexRollout(context.sessionId, processEnv.CODEX_HOME?.trim() || join(home, ".codex"), now);
    }

    return null;
}

export function failureCaller(inputs: CallerInputs): FailureCaller {
    const { context, processEnv } = inputs;
    const transcript = transcriptOf(inputs);
    let model: string | null = null;
    if (transcript) {
        model = modelInTranscriptLines(readLastLines(transcript, { maxBytes: TAIL_BYTES }).lines);
    }

    return {
        agent: context.agent,
        sessionId: context.sessionId,
        sessionTitle: context.sessionTitle,
        model,
        effort: processEnv.CLAUDE_EFFORT?.trim() || null,
        aiAgent: context.aiAgent ?? (processEnv.AI_AGENT?.trim() || null),
        project: context.project,
        repoRoot: context.repoRoot,
        branch: context.branch,
        commitSha: context.commitSha,
        worktreePath: context.worktreePath,
    };
}
