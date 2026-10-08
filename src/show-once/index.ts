#!/usr/bin/env bun
import { resolve } from "node:path";
import { recordingBrowsers } from "@app/chrome-devtools/lib/recording-browser";
import { isInteractive, runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { Command } from "commander";
import { startReportFixture } from "./lib/fixture";
import { parseRecipe } from "./lib/recipe";
import { ShowOnceService, serveBridge } from "./lib/service";

const program = new Command()
    .name("show-once")
    .description("Demonstrate a browser and file task, edit its recipe, replay and verify outputs.");
async function readRecipe(file: string) {
    const input = Bun.file(file);
    if (input.size > 2_000_000) {
        throw new Error("Recipe exceeds the 2 MB import limit.");
    }
    return parseRecipe(SafeJSON.parse(await input.text(), { strict: true }));
}
async function openWindow(file?: string) {
    const { appStatus, buildApp } = await import("@app/macos/lib/permissions/app");
    const status = appStatus();
    if (!status.built || status.stale || !status.manifest) {
        await buildApp({ onStep: (message) => out.log.info(message) });
    }
    const args = [
        "/usr/bin/open",
        "-n",
        status.bundlePath,
        "--args",
        "--show-once",
        "--tools",
        resolve(import.meta.dirname, "../../tools"),
    ];
    if (file) {
        args.push("--open", resolve(file));
    }
    const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe", signal: AbortSignal.timeout(10000) });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) {
        throw new Error(`Show Once did not open: ${error}`);
    }
    out.result({ opened: true });
}
program.action(() => openWindow());
program.command("open").argument("[file]").action(openWindow);
program.command("bridge").description("Native JSON-lines bridge, lifetime owned by stdin").action(serveBridge);
program
    .command("mcp")
    .description("Start the Show Once MCP server on stdio")
    .action(async () => {
        const { startShowOnceMcpServer } = await import("./mcp");
        await startShowOnceMcpServer();
    });
program
    .command("validate")
    .argument("<recipe>")
    .action(async (file) => {
        out.result(await readRecipe(file));
    });
program
    .command("history")
    .argument("<recipe>")
    .action(async (file) => {
        const recipe = await readRecipe(file);
        out.result(await new ShowOnceService().dispatch({ op: "history", recipeId: recipe.id }));
    });
program
    .command("tabs")
    .option("--port <port>", "Existing browser debugger port; omit to discover browser tabs")
    .action(async (options) => {
        out.result(
            await new ShowOnceService().dispatch({ op: "tabs", port: options.port ? Number(options.port) : undefined })
        );
    });
program
    .command("browsers")
    .description("List installed browsers for an isolated recording window")
    .action(async () => {
        out.result(await new ShowOnceService().dispatch({ op: "browsers" }));
    });
program
    .command("open-browser")
    .option("--browser [id]", "Exact installed browser ID from browsers")
    .option("--url <url>", "Initial HTTP(S) page")
    .action(async (options) =>
        withInterrupt(async (signal) => {
            const browsers = recordingBrowsers();
            let browserId: unknown = options.browser;
            if (typeof browserId !== "string" && isInteractive() && browsers.length > 0) {
                const picked = await p.select({
                    message: "Recording browser",
                    options: browsers.map((browser) => ({ value: browser.id, label: browser.name })),
                });
                if (p.isCancel(picked)) {
                    return;
                }
                browserId = picked;
            }
            if (typeof browserId !== "string" || !browsers.some((browser) => browser.id === browserId)) {
                out.log.error(
                    browsers.length === 0
                        ? "No supported recording browser is installed."
                        : suggestEnumFlag(
                              "tools show-once open-browser",
                              "--browser",
                              browsers.map((browser) => browser.id),
                              {
                                  subcommand: ["open-browser"],
                                  given: typeof browserId === "string" ? browserId : undefined,
                              }
                          )
                );
                process.exitCode = 1;
                return;
            }
            out.result(
                await new ShowOnceService().dispatch({ op: "open-browser", browserId, url: options.url }, signal)
            );
        })
    );
program
    .command("run")
    .argument("<recipe>")
    .requiredOption("--port <port>", "Browser debugger port")
    .requiredOption("--target <id>", "Explicit browser tab ID")
    .requiredOption("--inputs <file>", "Runtime input JSON, including secrets only at run time")
    .option("--approve-checkpoints", "Explicitly acknowledge all recipe checkpoints")
    .action(async (file, options) =>
        withInterrupt(async (signal) => {
            const service = new ShowOnceService((event) => out.log.info(SafeJSON.stringify(event, { strict: true })));
            try {
                const result = await service.dispatch(
                    {
                        op: "run",
                        recipe: await readRecipe(file),
                        inputs: SafeJSON.parse(await Bun.file(options.inputs).text(), { strict: true }),
                        port: Number(options.port),
                        targetId: options.target,
                        approveCheckpoints: Boolean(options.approveCheckpoints),
                        waitForCheckpoints: false,
                    },
                    signal
                );
                out.result(result);
                if (result && typeof result === "object" && "status" in result && result.status !== "completed") {
                    process.exitCode = 1;
                }
            } finally {
                await service.close();
            }
        })
    );
program
    .command("record")
    .requiredOption("--port <port>", "Browser debugger port")
    .requiredOption("--target <id>", "Explicit browser tab ID")
    .requiredOption("--downloads <folder>", "Download folder for the demonstrated task")
    .requiredOption("--destination <folder>", "Chosen move destination")
    .requiredOption("--out <file>", "Recipe output")
    .option("--title <title>", "Workflow title", "Recorded report task")
    .option("--seconds <seconds>", "Bounded recording duration", "60")
    .action(async (options) =>
        withInterrupt(async (signal) => {
            const seconds = Number(options.seconds);
            if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
                throw new Error("Recording duration must be 1 to 300 seconds.");
            }
            const service = new ShowOnceService();
            try {
                await service.dispatch(
                    {
                        op: "record-start",
                        port: Number(options.port),
                        targetId: options.target,
                        downloadDirectory: resolve(options.downloads),
                        destinationDirectory: resolve(options.destination),
                    },
                    signal
                );
                signal.throwIfAborted();
                out.log.info(
                    "Recording. Demonstrate the browser download, then rename and move the file into the chosen destination."
                );
                await new Promise<void>((resolveWait) => {
                    const finish = () => {
                        clearTimeout(timer);
                        signal.removeEventListener("abort", finish);
                        resolveWait();
                    };
                    const timer = setTimeout(finish, seconds * 1000);
                    signal.addEventListener("abort", finish, { once: true });
                    if (signal.aborted) {
                        finish();
                    }
                });
                signal.throwIfAborted();
                const result = await service.dispatch({ op: "record-stop", title: options.title });
                if (!result || typeof result !== "object" || !("recipe" in result)) {
                    throw new Error("Recorder returned no recipe.");
                }
                await service.dispatch({ op: "save", recipe: result.recipe, file: resolve(options.out) });
                out.result(result);
            } finally {
                await service.close();
            }
        })
    );
program
    .command("demo")
    .description("Serve the disposable local browser report fixture")
    .action(async () =>
        withInterrupt(async (signal) => {
            const fixture = startReportFixture();
            out.result({ url: fixture.url });
            try {
                await new Promise<void>((resolveWait) =>
                    signal.addEventListener("abort", () => resolveWait(), { once: true })
                );
            } finally {
                fixture.close();
            }
        })
    );
await runTool(program, { tool: "show-once" });
