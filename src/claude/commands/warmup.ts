import { sendWarmupMessage } from "@app/claude/lib/warmup/service";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

export function registerWarmupCommand(program: Command): void {
    const warmup = program.command("warmup").description("Manually warm up Claude accounts to start session timers");

    warmup.argument("[account]", "Warm up a specific account (skip selection)").action(async (accountArg?: string) => {
        p.intro(pc.bgCyan(pc.black(" claude warmup ")));

        const { AIConfig } = await import("@app/utils/ai/AIConfig");
        const aiConfig = await AIConfig.load();
        const allAccounts = aiConfig.getAccountsByProvider("anthropic-sub");
        const accountNames = allAccounts.map((a) => a.name);

        if (accountNames.length === 0) {
            p.log.error("No accounts configured. Run: tools claude login");
            p.outro("");
            return;
        }

        let selectedNames: string[];

        if (accountArg) {
            if (!allAccounts.some((a) => a.name === accountArg)) {
                p.log.error(`Account "${accountArg}" not found. Available: ${accountNames.join(", ")}`);
                p.outro("");
                return;
            }

            selectedNames = [accountArg];
        } else if (!isInteractive()) {
            p.log.error("No account specified in non-interactive mode.");
            console.info(suggestCommand("tools claude warmup", { add: ["<account>"] }));
            p.outro("");
            return;
        } else {
            const selected = await p.multiselect({
                message: "Select accounts to warm up",
                options: allAccounts.map((a) => ({
                    value: a.name,
                    label: `${a.name}${a.label ? ` (${a.label})` : ""}`,
                })),
                required: true,
            });

            if (p.isCancel(selected)) {
                p.outro("Cancelled.");
                return;
            }

            selectedNames = selected as string[];
        }

        const results: Array<{ name: string; success: boolean; duration: number }> = [];

        const spinner = p.spinner();

        for (const name of selectedNames) {
            spinner.start(`Warming up ${pc.cyan(name)}...`);
            const start = performance.now();
            const success = await sendWarmupMessage(name);
            const duration = Math.round(performance.now() - start);
            results.push({ name, success, duration });

            if (success) {
                spinner.stop(`${pc.cyan(name)} ${pc.green("\u2713")} ${pc.dim(`${duration}ms`)}`);
            } else {
                spinner.stop(`${pc.cyan(name)} ${pc.red("\u2717 failed")} ${pc.dim(`${duration}ms`)}`);
            }
        }

        // Summary
        const ok = results.filter((r) => r.success).length;
        const fail = results.filter((r) => !r.success).length;

        const lines: string[] = [];

        for (const r of results) {
            const icon = r.success ? pc.green("\u2713") : pc.red("\u2717");
            const label = allAccounts.find((a) => a.name === r.name)?.label;
            const hint = label ? pc.dim(` (${label})`) : "";
            lines.push(`  ${icon} ${r.name}${hint}  ${pc.dim(`${r.duration}ms`)}`);
        }

        lines.push("");

        if (fail === 0) {
            lines.push(pc.green(`All ${ok} account(s) warmed up successfully.`));
        } else {
            lines.push(`${pc.green(`${ok} succeeded`)}, ${pc.red(`${fail} failed`)}`);
        }

        p.note(lines.join("\n"), "Warmup Results");
        p.outro("");
    });

    warmup
        .command("all")
        .description("Warm up all configured accounts (non-interactive)")
        .action(async () => {
            const { AIConfig } = await import("@app/utils/ai/AIConfig");
            const aiConfig = await AIConfig.load();
            const accountNames = aiConfig.getAccountsByProvider("anthropic-sub").map((a) => a.name);

            if (accountNames.length === 0) {
                console.error("No accounts configured. Run: tools claude login");
                process.exit(1);
            }

            console.log(`Warming up ${accountNames.length} account(s)...`);

            let failures = 0;

            for (const name of accountNames) {
                const start = performance.now();
                const success = await sendWarmupMessage(name);
                const duration = Math.round(performance.now() - start);
                const icon = success ? "\u2713" : "\u2717";
                console.log(`  ${icon} ${name} (${duration}ms)`);

                if (!success) {
                    failures++;
                }
            }

            if (failures > 0) {
                process.exit(1);
            }
        });
}
