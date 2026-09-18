import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { compactMessages } from "@genesiscz/utils/ai/compact";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseSnapshotText } from "./browser/snapshot";
import { bool, choice, fakeEvaluator } from "./fake-evaluate";
import { listenDaemonPlan } from "./listen-daemon";
import { routeUtterance } from "./route";
import { splitPlanUtterance } from "./route-plan";
import { VERIFY_TEMPLATES, verifyClaims } from "./verify-claims";

export interface ReelChapter {
    name: string;
    ok: boolean;
    artifact: string;
    error?: string;
}

export async function runReel(options: {
    dir: string;
    dryRun?: boolean;
}): Promise<{ chapters: ReelChapter[]; failed: number }> {
    await mkdir(options.dir, { recursive: true });
    const chapters: ReelChapter[] = [];
    const evaluate = fakeEvaluator({
        tool: choice("github", { github: 0.93, none: 0.07 }),
        destructive: bool(0.05),
        needs_args: bool(0.1),
        keep_call_t1: bool(0.2),
        keep_result_t1: bool(0.1),
        secrets: bool(0.02),
        "pii-contact": bool(0.9),
        accuracy_c1: bool(0.95),
    });
    async function chapter(name: string, work: () => Promise<unknown>) {
        try {
            const value = await work();
            const artifact = join(options.dir, `${name}.json`);
            await Bun.write(artifact, `${SafeJSON.stringify(value, { strict: true })}\n`);
            chapters.push({ name, ok: true, artifact });
        } catch (error) {
            chapters.push({
                name,
                ok: false,
                artifact: "",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    await chapter("listen", async () =>
        listenDaemonPlan({ stt: "mock", wake: "hey genesis", wakeMode: "contains", dryRun: true })
    );
    await chapter("route", async () => ({
        plan: splitPlanUtterance("login then open atlas"),
        ...(await routeUtterance({
            utterance: "unresolved comments",
            srcDir: ".",
            tools: [{ name: "github", description: "PRs", hasReadme: true, path: "x" }],
            evaluate,
        })),
    }));
    await chapter("compact", async () =>
        compactMessages({
            messages: [
                { role: "user", content: "fix #pin" },
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
            evaluate,
        })
    );
    await chapter("verify", async () => ({
        templates: VERIFY_TEMPLATES,
        ...(await verifyClaims({
            against: "Contact alice@example.com",
            claims: [{ id: "c1", text: "email present" }],
            purposes: ["pii-contact", "secrets", "accuracy"],
            evaluate,
        })),
    }));
    await chapter("observe", async () => parseSnapshotText(`textbox "Username" uid=e1\nbutton "Sign in" uid=e2`));
    await chapter("loop", async () => ({ surface: "auto", dryRun: options.dryRun ?? true }));
    return { chapters, failed: chapters.filter((chapter) => !chapter.ok).length };
}
