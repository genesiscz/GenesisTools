import { formatDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { getLastResult } from "../lib/results";
import { findSuite } from "../lib/suites";

export async function cmdShow(name: string): Promise<void> {
    const suite = await findSuite(name);

    if (!suite) {
        p.log.error(`Suite "${name}" not found. Use ${pc.bold("tools benchmark list")} to see available suites.`);
        process.exit(1);
    }

    const lines: string[] = [];
    lines.push(`${pc.bold("Name:")} ${suite.name}`);
    lines.push(`${pc.bold("Type:")} ${suite.builtIn ? "built-in" : "custom"}`);

    if (suite.runs) {
        lines.push(`${pc.bold("Runs:")} ${suite.runs}`);
    }

    if (suite.warmup !== undefined) {
        lines.push(`${pc.bold("Warmup:")} ${suite.warmup}`);
    }

    if (suite.cwd) {
        lines.push(`${pc.bold("CWD:")} ${suite.cwd}`);
    }

    if (suite.env) {
        const envStr = Object.entries(suite.env)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
        lines.push(`${pc.bold("Env:")} ${envStr}`);
    }

    const hooks: string[] = [];

    if (suite.setup) {
        hooks.push(`setup: ${pc.dim(suite.setup)}`);
    }

    if (suite.prepare) {
        hooks.push(`prepare: ${pc.dim(suite.prepare)}`);
    }

    if (suite.conclude) {
        hooks.push(`conclude: ${pc.dim(suite.conclude)}`);
    }

    if (suite.cleanup) {
        hooks.push(`cleanup: ${pc.dim(suite.cleanup)}`);
    }

    if (hooks.length > 0) {
        lines.push("");
        lines.push(pc.bold("Suite Hooks:"));
        for (const h of hooks) {
            lines.push(`  ${h}`);
        }
    }

    lines.push("");
    lines.push(pc.bold("Commands:"));

    for (const cmd of suite.commands) {
        lines.push(`  ${pc.cyan(cmd.label)}: ${cmd.cmd}`);

        const cmdHooks: string[] = [];

        if (cmd.prepare) {
            cmdHooks.push(`prepare: ${cmd.prepare}`);
        }

        if (cmd.conclude) {
            cmdHooks.push(`conclude: ${cmd.conclude}`);
        }

        if (cmd.cleanup) {
            cmdHooks.push(`cleanup: ${cmd.cleanup}`);
        }

        if (cmd.env) {
            const envStr = Object.entries(cmd.env)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ");
            cmdHooks.push(`env: ${envStr}`);
        }

        for (const h of cmdHooks) {
            lines.push(`    ${pc.dim(h)}`);
        }
    }

    const lastResult = await getLastResult(suite.name);

    if (lastResult) {
        lines.push("");
        lines.push(`${pc.bold("Last run:")} ${lastResult.date.slice(0, 10)}`);
        for (const r of lastResult.results) {
            lines.push(`  ${r.command}: ${formatDuration(r.mean * 1000)}`);
        }
    }

    p.note(lines.join("\n"), `Suite: ${suite.name}`);
}

export function registerShowCommand(program: Command): void {
    program
        .command("show")
        .description("Show full details of a benchmark suite")
        .argument("<name>", "Suite name to inspect")
        .action(async (name: string) => {
            await cmdShow(name);
        });
}
