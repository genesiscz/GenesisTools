import { registerAccountLoginCommand } from "@app/ai/commands/accounts/login";
import { registerWarmupCommand } from "@app/ai/commands/warmup";
import { registerAgentHistoryCommand } from "@genesiscz/utils/agent-sessions/history-cli";
import type { Command } from "commander";
import { registerProviderUsageCommand } from "../usage/provider-usage";
import { registerAgentResumeCommand, registerAgentRunCommand } from "./run";
import { type AgentToolSpec, type SharedVerb, toolName } from "./spec";
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

    shared("who", () => {
        if (!spec.processScan) {
            return;
        }

        registerAgentWhoCommand(program, { alias: spec.alias, tool, ...spec.processScan });
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
