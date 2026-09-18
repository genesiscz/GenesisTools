import { tmpdir } from "node:os";
import { join } from "node:path";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { parseSnapshotText } from "../lib/browser/snapshot";
import { compactMessages } from "../lib/compact";
import { bool, choice, fakeEvaluator } from "../lib/fake-evaluate";
import { runReel } from "../lib/reel";
import { routeUtterance } from "../lib/route";
import { VERIFY_TEMPLATES, verifyClaims } from "../lib/verify-claims";

export function registerDemoScenes(program: Command): void {
    const demo = program.commands.find((command) => command.name() === "demo");
    if (!demo) {
        return;
    }
    demo.command("route")
        .description("Print a canned route suggestion without paid Jev")
        .action(async () => {
            const result = await routeUtterance({
                utterance: "unresolved review comments on 409",
                srcDir: `${import.meta.dir}/../..`,
                tools: [
                    {
                        name: "github",
                        description: "PRs and review threads",
                        hasReadme: true,
                        path: "src/github/index.ts",
                    },
                ],
                evaluate: fakeEvaluator({
                    tool: choice("github", { github: 0.93, none: 0.07 }),
                    destructive: bool(0.05),
                    needs_args: bool(0.2),
                }),
            });
            out.result(result);
        });
    demo.command("compact")
        .description("Compact a canned session")
        .action(async () => {
            out.result(
                await compactMessages({
                    messages: [
                        { role: "user", content: "fix the pid lie" },
                        {
                            role: "assistant",
                            content: "ok",
                            toolCalls: [
                                { id: "t1", name: "read", result: "a".repeat(400) },
                                { id: "t2", name: "read", result: "b" },
                                { id: "t3", name: "read", result: "c" },
                                { id: "t4", name: "read", result: "d" },
                                { id: "t5", name: "read", result: "e" },
                            ],
                        },
                    ],
                    minReduction: 0.01,
                    evaluate: fakeEvaluator({ keep_call_t1: bool(0.2), keep_result_t1: bool(0.1) }),
                })
            );
        });
    demo.command("verify")
        .description("Run pii/secrets templates on a canned document")
        .action(async () => {
            out.result({
                templates: VERIFY_TEMPLATES,
                ...(await verifyClaims({
                    against: "Contact alice@example.com. No live keys.",
                    claims: [{ id: "c1", text: "The text includes an email." }],
                    purposes: ["pii-contact", "secrets", "accuracy"],
                    evaluate: fakeEvaluator({
                        "pii-contact": bool(0.9),
                        secrets: bool(0.02),
                        accuracy_c1: bool(0.95),
                    }),
                })),
            });
        });
    demo.command("observe")
        .description("Parse a canned browser snapshot")
        .action(() => {
            out.result(parseSnapshotText(`textbox "Username" uid=e1\nbutton "Sign in" uid=e2`));
        });
    demo.command("listen")
        .description("Show the listen JSONL shape without a microphone")
        .action(() => {
            out.result([
                { type: "partial", text: "hey gene" },
                { type: "final", text: "hey genesis go back" },
                { type: "wake", matched: "hey genesis", remainder: "go back" },
                { type: "decision", admitted: false, reason: "No available action safely advances the user's goal." },
            ]);
        });
    demo.command("reel")
        .description("Run every demo chapter into a folder (dry-run, no overlay)")
        .option("--dir <dir>", "Output directory")
        .action(async (options: { dir?: string }) => {
            const dir = options.dir ?? join(tmpdir(), `jev-reel-${Date.now()}`);
            out.result(await runReel({ dir, dryRun: true }));
        });
}
