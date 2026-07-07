import { logger, out } from "@app/logger";
import { AIConfig } from "@app/utils/ai/AIConfig";
import { findClaudeCommand } from "@app/utils/claude";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { env } from "@app/utils/env";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

async function main(nameArg: string | undefined): Promise<never> {
    const aiConfig = await AIConfig.load();
    const withToken = aiConfig
        .getAccountsByProvider("anthropic-sub")
        .filter((a) => Boolean(a.tokens.longLivedToken));

    if (withToken.length === 0) {
        out.error(pc.red("No accounts with a long-lived token."));
        out.println(
            pc.dim(`Run ${pc.cyan("tools claude login-long")} first to save one (see \`claude setup-token\`).`)
        );
        process.exit(1);
    }

    let accountName: string;

    if (nameArg) {
        const match = withToken.find((a) => a.name === nameArg);
        if (!match) {
            const hasEntry = aiConfig.getAccount(nameArg);
            if (hasEntry) {
                out.error(pc.red(`Account "${nameArg}" has no long-lived token.`));
                out.println(pc.dim(`Save one with: ${pc.cyan(`tools claude login-long ${nameArg}`)}`));
            } else {
                out.error(pc.red(`Account "${nameArg}" not found.`));
                out.println(pc.dim(`With token: ${withToken.map((a) => a.name).join(", ")}`));
            }
            process.exit(1);
        }
        accountName = match.name;
    } else if (withToken.length === 1) {
        accountName = withToken[0].name;
    } else {
        if (!isInteractive()) {
            out.error(pc.red("Account name required in non-interactive mode."));
            out.println(suggestCommand("tools claude start", { add: [withToken[0].name] }));
            process.exit(1);
        }

        const defaultAccount = aiConfig.getDefaultAccount("claude");
        const defaultName = defaultAccount && withToken.some((a) => a.name === defaultAccount.name)
            ? defaultAccount.name
            : withToken[0].name;

        const picked = await p.select({
            message: "Launch Claude Code as which account?",
            initialValue: defaultName,
            options: withToken.map((acc) => ({
                value: acc.name,
                label: acc.label ? `${acc.name} ${pc.dim(`(${acc.label})`)}` : acc.name,
            })),
        });

        if (p.isCancel(picked)) {
            p.cancel("Cancelled");
            process.exit(0);
        }

        accountName = picked as string;
    }

    const account = withToken.find((a) => a.name === accountName)!;
    const token = account.tokens.longLivedToken!;

    const cmd = await findClaudeCommand();
    const shell = env.paths.getShell("/bin/sh");

    out.println(pc.dim(`Starting Claude as ${pc.cyan(accountName)}${account.label ? ` (${account.label})` : ""}...`));
    logger.debug({ cmd, accountName }, "Spawning claude with long-lived token");

    const proc = Bun.spawn({
        cmd: [shell, "-ic", `exec ${cmd}`],
        stdio: ["inherit", "inherit", "inherit"],
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
    });

    const exitCode = await proc.exited;
    process.exit(exitCode);
}

export function registerStartCommand(program: Command): void {
    const startCmd = program
        .command("start [name]")
        .description("Launch Claude Code using a saved long-lived token (CLAUDE_CODE_OAUTH_TOKEN)")
        .action(async (name?: string) => {
            try {
                await main(name);
            } catch (error) {
                if (error instanceof Error && (error.name === "ExitPromptError" || error.message === "Cancelled")) {
                    process.exit(0);
                }
                throw error;
            }
        });

    startCmd.alias("run");
}
