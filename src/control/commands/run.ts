import { existsSync, readFileSync } from "node:fs";
import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";
import { type AxResult, runAx } from "../lib/runner";

const ACTION_ALIASES: Record<string, string> = {
    "ax-set": "set",
    "ax-press": "press",
    "ax-perform": "perform",
    axSet: "set",
    axPress: "press",
    axPerform: "perform",
};

const NO_APP_COMMANDS = new Set(["snapshot", "restore", "hotkey"]);

export function registerRunCommand(program: Command): void {
    program
        .command("run <plan>")
        .description(`Execute a plan file — sequential ax-tool commands with snapshot/restore.

  Plan contract (JSON):
    {
      "app":      "Genesis",         // default app for all steps
      "restore":  true,              // snapshot before, restore after
      "delayMs":  300,               // pause between steps (ms, default 200)
      "exact":    false,             // force strict role matching
      "steps": [
        { "do": "focus" },
        { "do": "press", "q": "Chat" },
        { "do": "click", "desc": "Account", "role": "button" },
        { "do": "set", "id": "field-id", "value": "hello" },
        { "do": "type", "q": "field-id", "text": "world" },
        { "do": "screenshot", "path": "/tmp/shot.png" },
        { "do": "hotkey", "keys": "cmd,w" },
        { "do": "click", "subrole": "close", "window": "Settings" }
      ]
    }

  Step fields: do (command), q (universal search), id, role, title, desc,
    subrole, window, value, text, path, keys, action, delay, app (override).
  Action aliases: ax-set/ax-press/ax-perform map to set/press/perform.
  Role/subrole fuzzy by default: "button" matches AXButton.`)
        .option("--json", "raw JSON output")
        .action((planPath, opts) => {
            if (!existsSync(planPath)) {
                logger.error(`plan file not found: ${planPath}`);
                process.exit(1);
            }
            const plan = SafeJSON.parse(readFileSync(planPath, "utf-8")) as {
                app?: string;
                restore?: boolean;
                delayMs?: number;
                exact?: boolean;
                steps: Array<Record<string, unknown>>;
            };
            if (!plan.steps?.length) {
                logger.error("plan has no steps");
                process.exit(1);
            }

            const delay = plan.delayMs ?? 200;
            let snapshot: AxResult | null = null;

            if (plan.restore) {
                snapshot = runAx(["snapshot"]);
            }

            const results: Array<{ step: Record<string, unknown>; result: AxResult; ms: number }> = [];
            for (const step of plan.steps) {
                let cmd = String(step.do ?? "");
                cmd = ACTION_ALIASES[cmd] ?? cmd;
                const app = String(step.app ?? plan.app ?? "");
                if (!cmd) {
                    results.push({ step, result: { ok: false, error: "missing 'do'" }, ms: 0 });
                    continue;
                }

                const args: string[] = [cmd];
                if (!NO_APP_COMMANDS.has(cmd)) {
                    if (!app) {
                        results.push({ step, result: { ok: false, error: "missing 'app'" }, ms: 0 });
                        continue;
                    }
                    args.push("--app", app);
                }
                for (const [k, v] of Object.entries(step)) {
                    if (k === "do" || k === "app" || k === "delay" || v == null) {
                        continue;
                    }
                    args.push(`--${k}`, String(v));
                }
                if (plan.exact) {
                    args.push("--exact");
                }

                const t0 = performance.now();
                const result = runAx(args);
                const ms = Math.round(performance.now() - t0);
                results.push({ step, result, ms });

                if (!opts.json) {
                    const label = step.q ?? step.id ?? step.desc ?? step.subrole ?? step.text ?? cmd;
                    const status = result.ok ? pc.green("ok") : pc.red("FAIL");
                    out.println(`  ${status} ${pc.cyan(String(label))} ${pc.dim(`${ms}ms`)}`);
                }

                const stepDelay = typeof step.delay === "number" ? step.delay : delay;
                if (stepDelay > 0) {
                    Bun.sleepSync(stepDelay);
                }
            }

            if (plan.restore && snapshot?.ok) {
                runAx(["restore", "--snapshot", SafeJSON.stringify(snapshot)]);
                if (!opts.json) {
                    out.println(`  ${pc.green("restored")} mouse + focus`);
                }
            }

            if (opts.json) {
                out.println(SafeJSON.stringify({ ok: true, steps: results, restored: !!plan.restore }, null, 2));
            } else {
                const passed = results.filter((r) => r.result.ok).length;
                const total = results.length;
                const totalMs = results.reduce((s, r) => s + r.ms, 0);
                out.println(`\n${passed}/${total} steps passed, ${totalMs}ms total`);
            }
        });
}
