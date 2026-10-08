import { registerSessionQueueCommand } from "@app/ai/commands/agent/queue";
import { readWorkerPrompt } from "@app/ai/commands/agent/worker";
import { out } from "@genesiscz/utils/logger";
import { WorkerDeliveryRejectedError } from "@genesiscz/utils/worker/delivery";
import type { WorkerVerbOutcome } from "@genesiscz/utils/worker/driver";
import type { Command } from "commander";
import { codexDriver } from "../lib/driver";
import {
    type CodexMessageDeps,
    CodexMessageUnknownError,
    codexMessageTarget,
    steerCodexMessage,
} from "../lib/message-delivery";
import { CodexSessionStore } from "../lib/store";

interface MessageFlags extends Record<string, unknown> {
    session?: string;
    home?: string;
    queueRoot?: string;
    idempotencyKey?: string;
    name?: string;
    force?: boolean;
    consumer?: string;
}

function target(flags: MessageFlags) {
    if (!flags.session || !flags.home) {
        throw new Error("Pass both --session and --home to address the exact Codex conversation.");
    }

    return codexMessageTarget({ sessionId: flags.session, sourceHome: flags.home });
}

function prompt(flags: MessageFlags): string {
    const text = readWorkerPrompt(flags, codexDriver.legacyPromptFlags);
    if (!text?.trim()) {
        throw new Error("A nonempty --prompt or --prompt-file is required.");
    }

    return text;
}

export function registerCodexMessageCommands({
    program,
    deps = {},
    output = (value) => out.result(value),
}: {
    program: Command;
    deps?: CodexMessageDeps;
    output?: (value: unknown) => void;
}): void {
    registerSessionQueueCommand({ program, provider: "codex", output, enqueue: deps.enqueue });

    const steer = program.commands.find((command) => command.name() === "steer");
    if (!steer) {
        throw new Error("Register the shared Codex worker verbs before session message commands.");
    }

    steer.options.find((option) => option.attributeName() === "name")?.makeOptionMandatory(false);
    steer
        .option("--session <id>", "Steer an exact native thread or persist for its cooperative receiver")
        .option("--home <path>", "Absolute source CODEX_HOME of that thread")
        .option("--queue-root <path>", "Override the portable queue when no owned daemon is available")
        .option("--idempotency-key <key>", "Stable identity for a portable queued message")
        .action(async (flags: MessageFlags) => {
            if (flags.name && flags.session) {
                throw new Error("--name and --session are mutually exclusive.");
            }

            const text = prompt(flags);
            if (flags.session) {
                try {
                    output(
                        await steerCodexMessage({
                            target: target(flags),
                            text,
                            force: flags.force,
                            root: flags.queueRoot,
                            idempotencyKey: flags.idempotencyKey,
                            deps,
                        })
                    );
                } catch (error) {
                    if (error instanceof CodexMessageUnknownError || error instanceof WorkerDeliveryRejectedError) {
                        output({
                            accepted: false,
                            delivered: false,
                            queued: false,
                            certainty: error instanceof WorkerDeliveryRejectedError ? "not-sent" : "unknown",
                            error: error.message,
                        });
                        process.exitCode = 1;
                        return;
                    }
                    throw error;
                }
                return;
            }

            if (!flags.name || flags.home || flags.queueRoot || flags.idempotencyKey) {
                throw new Error(
                    "Use --name for an owned worker, or both --session and --home for an exact conversation."
                );
            }

            const meta = (deps.store ?? new CodexSessionStore()).readMeta(flags.name);
            if (!meta) {
                throw new Error("The named Codex worker was not found.");
            }

            let outcome: WorkerVerbOutcome;
            try {
                outcome = await (deps.steer ?? codexDriver.steer)(meta, { prompt: text, extras: flags });
            } catch (error) {
                if (flags.json === true && error instanceof WorkerDeliveryRejectedError) {
                    output({ kind: "rejected", backend: "codex", name: meta.name, error: error.message });
                    process.exitCode = 1;
                    return;
                }

                throw error;
            }
            if (outcome.kind !== "ack") {
                throw new CodexMessageUnknownError();
            }

            output(outcome.result ?? {});
        });
}
