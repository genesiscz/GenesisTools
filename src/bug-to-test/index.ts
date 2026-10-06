import { openRecordingBrowser, recordingBrowsers, recordingTabs } from "@app/chrome-devtools/lib/recording-browser";
import { isInteractive, runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { Command } from "commander";
import { recordBug } from "./lib/capture";
import { showTrace } from "./lib/trace";
import {
    exportWorkspace,
    generateWorkspace,
    loadRecording,
    minimizeWorkspace,
    saveRecording,
    verifyWorkspace,
} from "./lib/workspace";

const program = new Command("bug-to-test").description(
    "Record a browser bug, verify its Playwright assertion and export a portable repro."
);
program.command("browsers").action(() => out.result(recordingBrowsers()));
program
    .command("open-browser")
    .option("--browser [id]", "Installed browser ID from browsers")
    .option("--url <url>", "Initial HTTP URL or about:blank")
    .action((options) =>
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
                              "tools bug-to-test open-browser",
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
            out.result(await openRecordingBrowser({ browserId, url: options.url, signal }));
        })
    );
program
    .command("tabs")
    .option("--port <port>", "Optional local browser debugging port; otherwise discover endpoints")
    .action((options) =>
        withInterrupt(async (signal) => {
            out.result(
                await recordingTabs({ port: options.port === undefined ? undefined : Number(options.port), signal })
            );
        })
    );
program
    .command("record")
    .requiredOption("--port <port>")
    .requiredOption("--tab <id>")
    .requiredOption("--output <path>")
    .requiredOption("--stop <path>")
    .option("--title <title>", "Bug title", "Browser bug")
    .option("--seconds <seconds>", "Recording deadline, at most 600", "300")
    .action(async (options) => {
        await withInterrupt(
            async (signal) => {
                out.result(
                    await recordBug({
                        port: Number(options.port),
                        targetId: options.tab,
                        output: options.output,
                        stopPath: options.stop,
                        title: options.title,
                        seconds: Number(options.seconds),
                        signal,
                    })
                );
            },
            { handleTermination: true }
        );
    });
program
    .command("inspect")
    .requiredOption("--input <path>")
    .action(async (options) => out.result(await loadRecording(options.input)));
program
    .command("generate")
    .requiredOption("--input <path>")
    .action(async (options) => {
        const recording = await loadRecording(options.input);
        const directory = await generateWorkspace({ recording });
        const updated = { ...recording, workspace: directory };
        await saveRecording({ path: options.input, recording: updated });
        out.result({ directory, recording: updated });
    });
program
    .command("verify")
    .requiredOption("--workspace <path>")
    .option("--base-url <url>")
    .option("--browser <path>")
    .action(async (options) =>
        withInterrupt(
            async (signal) => {
                out.result(
                    await verifyWorkspace({
                        directory: options.workspace,
                        baseUrl: options.baseUrl,
                        browserBinary: options.browser,
                        signal,
                    })
                );
            },
            { handleTermination: true }
        )
    );
program
    .command("minimize")
    .requiredOption("--input <path>")
    .option("--base-url <url>")
    .option("--browser <path>")
    .action(async (options) =>
        withInterrupt(
            async (signal) => {
                const result = await minimizeWorkspace({
                    recording: await loadRecording(options.input),
                    signal,
                    baseUrl: options.baseUrl,
                    browserBinary: options.browser,
                    onProgress: (message) => logger.info(message),
                });
                await saveRecording({ path: options.input, recording: result.recording });
                out.result(result);
            },
            { handleTermination: true }
        )
    );
program
    .command("export")
    .requiredOption("--workspace <path>")
    .requiredOption("--destination <path>")
    .option("--fixture <paths...>")
    .action(async (options) =>
        out.result({
            directory: await exportWorkspace({
                directory: options.workspace,
                destination: options.destination,
                fixtures: options.fixture,
            }),
        })
    );
program
    .command("trace")
    .requiredOption("--workspace <path>")
    .action(async (options) =>
        withInterrupt(async (signal) => showTrace({ directory: options.workspace, signal }), {
            handleTermination: true,
        })
    );
await runTool(program, { tool: "bug-to-test" });
