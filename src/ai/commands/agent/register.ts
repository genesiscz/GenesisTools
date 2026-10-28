import { registerAccountLoginCommand, registerLoginVariantCommands } from "@app/ai/commands/accounts/login";
import { registerWarmupCommand } from "@app/ai/commands/warmup";
import { registerAgentHistoryCommand } from "@genesiscz/utils/agent-sessions/history-cli";
import { isTurnProvider } from "@genesiscz/utils/ai/transcripts/turn-state";
import type { Command } from "commander";
import { registerProviderUsageCommand } from "../usage/provider-usage";
import { registerAgentCmuxCommand } from "./cmux";
import { agentWhoSource } from "./launch";
import { registerAgentMessageCommand } from "./message";
import { registerAgentResumeCommand, registerAgentRunCommand } from "./run";
import { type AgentToolSpec, type SharedVerb, toolName } from "./spec";
import { registerAgentWaitCommand } from "./wait";
import { registerAgentWhoCommand } from "./who";
import { registerWorkerVerbs } from "./worker";

/**
 * Every verb a coding-agent tool shares with its siblings, registered from one spec.
 *
 * This is the answer to "how hard is it to add a fourth agent": a provider plugin, a session
 * adapter, a launcher, a worker driver, and this call. Nothing else. A tool that genuinely
 * needs a different verb declares it in `spec.overrides`, so the deviation is visible in the
 * spec instead of hiding in a command file nobody compares.
 */
export function registerAgentTool(program: Command, spec: AgentToolSpec): void {
    const tool = toolName(spec);

    function shared(verb: SharedVerb, register: () => void): void {
        const override = spec.overrides?.[verb];

        if (override) {
            override(program, spec);
            return;
        }

        register();
    }

    shared("run", () => {
        registerAgentRunCommand(program, spec);
    });
    shared("resume", () => {
        registerAgentResumeCommand(program, spec);
    });

    shared("worker", () => {
        const driver = spec.worker;

        if (!driver) {
            return;
        }

        const mount = spec.workerMount
            ? program.command(spec.workerMount).description(spec.workerMountDescription ?? "Headless worker sessions")
            : program;
        registerWorkerVerbs(mount, driver, {
            tool: spec.workerMount ? `${tool} ${spec.workerMount}` : tool,
            subcommand: spec.workerMount ? [spec.workerMount] : [],
        });
    });

    shared("cmux", () => {
        registerAgentCmuxCommand(program, spec);
    });

    shared("wait", () => {
        if (isTurnProvider(spec.alias)) {
            registerAgentWaitCommand(program, spec.alias);
        }
    });

    shared("message", () => {
        if (isTurnProvider(spec.alias)) {
            registerAgentMessageCommand(program, spec.alias);
        }
    });

    shared("who", () => {
        const who = agentWhoSource(spec);

        if (who) {
            registerAgentWhoCommand(program, { ...who, tool });
        }
    });

    shared("history", () => {
        const adapter = spec.adapter;

        if (!adapter) {
            return;
        }

        registerAgentHistoryCommand(program, adapter(), spec.alias);
    });

    shared("login", () => {
        registerAccountLoginCommand(program, {
            provider: spec.provider,
            tool: `${tool} login`,
            subcommand: ["login"],
            ...(spec.help?.login === undefined ? {} : { description: spec.help.login }),
        });
        // `login-long` / `login-secondary` for a provider that declares them; none of today's agents does.
        registerLoginVariantCommands(program, { provider: spec.provider, tool, subcommand: [] });
    });

    shared("warmup", () => {
        registerWarmupCommand(program, { provider: spec.provider, tool: `${tool} warmup` });
    });

    shared("usage", () => {
        registerProviderUsageCommand(program, {
            provider: spec.provider,
            tool: `${tool} usage`,
            description: spec.help?.usage ?? `${spec.alias} usage limits (interactive TUI)`,
        });
    });
}
