import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { demoScriptSchema, runDemo, scriptSteps } from "@app/recorder/lib/demo";
import { movieDemoDriver } from "@app/recorder/lib/toolset";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("demo")
        .description(
            "Record a finished demo from a JSON script of steps: each step is marked, its caption shows while it plays, the waiting between steps is cut, and the movie is exported (the REPL's movies.demo() runs code steps)"
        )
        .argument(
            "<script>",
            "a JSON file (or - for stdin) of { title?, record?: { audio, display, app, window, fps, camera }, edit?, steps: [{ caption, tools?: [words], shell?, wait?, holdSeconds? }] }"
        )
        .option("--no-export", "keep the edited recording without exporting a movie")
        .action(async (path: string, flags: { export?: boolean }) => {
            try {
                const raw = path === "-" ? await Bun.stdin.text() : readFileSync(resolve(path), "utf8");
                const parsed = demoScriptSchema.safeParse(SafeJSON.parse(raw, { strict: true }));

                if (!parsed.success) {
                    const lines = parsed.error.issues.map(
                        (issue) => `  ${issue.path.join(".") || "(script)"}: ${issue.message}`
                    );
                    throw new Error(`the demo script does not parse:\n${lines.join("\n")}`);
                }

                const script = parsed.data;
                const result = await runDemo({
                    steps: scriptSteps(script),
                    driver: movieDemoDriver({ ...script.record, ...(script.title ? { title: script.title } : {}) }),
                    edit: script.edit,
                    settleSeconds: script.settleSeconds,
                    holdSeconds: script.holdSeconds,
                    export: flags.export !== false && script.export !== false,
                });

                for (const failure of result.failed) {
                    out.printlnErr(`step "${failure.caption}" failed: ${failure.error}`);
                }

                out.printlnErr(
                    result.exported
                        ? `demo: ${result.exported.path} (${result.steps.length} steps, ${result.sourceSeconds} s recorded)`
                        : `demo: ${result.folder} (${result.steps.length} steps, edited, not exported)`
                );
                out.result(result);
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
