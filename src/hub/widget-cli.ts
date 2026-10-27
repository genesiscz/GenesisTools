import { decisionFindArgv } from "@app/claude/lib/cmux/transcript-find";
import { execToolInteractive, runTool } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { readNativeInboxSignals } from "@genesiscz/utils/macos/native-inbox";
import { Command } from "commander";
import { prepareWidgetAsset } from "./lib/composer/assets";
import { widgetDispatcher } from "./lib/composer/dispatch";
import { processWidgetOutbox } from "./lib/composer/engine";
import { performWidgetAction } from "./lib/widget/actions";
import { readWidgetReceiptContext } from "./lib/widget/context";
import { readWidgetText } from "./lib/widget/readback";
import { oneShotWidgetSources } from "./lib/widget/roster-cache";
import {
    attachShelfItem,
    captureShelfImage,
    importShelfFile,
    listWidgetShelf,
    readShelfAttachment,
    removeShelfItem,
    stageShelfImage,
    stageShelfMedia,
} from "./lib/widget/shelf";
import { discoverWidgetCatalog, widgetSnapshot } from "./lib/widget/snapshot";
import { mutateWidgetState } from "./lib/widget/storage";
import { StdinLines, watchWidget, widgetSelectionLine } from "./lib/widget/watch";
import { registerWidgetTasks } from "./widget-tasks-cli";
import { registerWidgetVoiceNotes } from "./widget-voice-notes-cli";

const program = new Command().name("hub");
const widget = program
    .command("widget")
    .description("Native widget data, media and ordered outgoing messages")
    .option("--state-root <directory>", "Widget state/assets directory, independent of shared session history");
registerWidgetTasks(widget);
registerWidgetVoiceNotes(widget);
widget
    .command("pin <session>")
    .requiredOption("--provider <provider>")
    .action(async (session: string, options, command) => {
        const root = command.optsWithGlobals().stateRoot;
        const snapshot = await widgetSnapshot({ root, sources: await oneShotWidgetSources(root) });
        const candidates = snapshot.sessions.filter(
            (entry) => entry.target.sessionId === session && entry.target.provider === options.provider
        );
        if (candidates.length !== 1) {
            throw new Error("Choose the exact session in Widget sessions; its identity is unavailable or ambiguous.");
        }
        out.result(
            await performWidgetAction({ root, input: { action: "visibility", key: candidates[0].key, pinned: true } })
        );
    });
widget
    .command("show-decision <session> <number>")
    .description(
        "Show a decision: its popup in the running widget, or without a running widget, its chat (claude cmux find)"
    )
    .option("--at <at>", "where the link was clicked, passed to the chat fallback")
    .action(async (session: string, number: string, options: { at?: string }, command) => {
        const id = `d_${number}_${session}`;
        if (readNativeInboxSignals().widgetRunning) {
            await mutateWidgetState(command.optsWithGlobals().stateRoot, (state) => {
                state.showDecision = { id, at: Date.now() };
            });
            logger.info({ id }, "show-decision: asked the running widget");
            out.result({ shown: "widget", id });
            return;
        }

        logger.info({ id }, "show-decision: no running widget, showing it in its chat");
        const result = await execToolInteractive(decisionFindArgv({ session, number, at: options.at }));
        process.exitCode = result.exitCode;
    });
widget
    .command("discover")
    .description("Refresh the shared session catalog and agent roster independently of inbox snapshots")
    .action(async () => {
        out.result(await discoverWidgetCatalog());
    });
widget
    .command("snapshot")
    .option("--selected <key>")
    .option("--json")
    .action(async (options, command) => {
        const root = command.optsWithGlobals().stateRoot;
        out.result(
            await widgetSnapshot({ root, selectedKey: options.selected, sources: await oneShotWidgetSources(root) })
        );
    });
widget
    .command("call")
    .requiredOption("--input <file>", "JSON action request")
    .action(async (options, command) => {
        const input: unknown = SafeJSON.parse(await Bun.file(options.input).text());
        await withInterrupt(
            async (signal) => {
                const result = await performWidgetAction({ root: command.optsWithGlobals().stateRoot, input, signal });
                out.result(result ?? { ok: true });
            },
            { handleTermination: true }
        );
    });
widget
    .command("context <id>")
    .description("Read the stored receipt source and a bounded nearby transcript window")
    .requiredOption("--key <key>", "Exact Widget provider/session key")
    .option("--before <turns>", "Context turns before the match (0–10)", Number, 2)
    .option("--after <turns>", "Context turns after the match (0–10)", Number, 2)
    .option("--json")
    .action(async (id: string, options, command) => {
        await withInterrupt(
            async (signal) => {
                out.result(
                    await readWidgetReceiptContext({
                        id,
                        key: options.key,
                        root: command.optsWithGlobals().stateRoot,
                        before: options.before,
                        after: options.after,
                        signal,
                    })
                );
            },
            { handleTermination: true }
        );
    });
widget.command("prepare <id>").action(async (id: string, _options, command) => {
    await withInterrupt(
        async (signal) => {
            await prepareWidgetAsset({ root: command.optsWithGlobals().stateRoot, id, signal });
            out.result({ prepared: true });
        },
        { handleTermination: true }
    );
});
widget.command("dispatch").action(async (_options, command) => {
    await withInterrupt(
        async (signal) => {
            await processWidgetOutbox({
                root: command.optsWithGlobals().stateRoot,
                dispatcher: widgetDispatcher({ signal }),
                signal,
            });
            out.result({ processed: true });
        },
        { handleTermination: true }
    );
});
widget
    .command("watch")
    .option("--selected <key>")
    .option("--stop-on-stdin")
    .action(async (options, command) => {
        await withInterrupt(
            async (signal) => {
                const owner = new AbortController();
                const abort = () => owner.abort();
                signal.addEventListener("abort", abort, { once: true });
                const selections = new Set<(key: string) => void>();
                const lines = new StdinLines((line) => {
                    const key = widgetSelectionLine(line);
                    if (!key) {
                        return;
                    }

                    for (const listener of selections) {
                        listener(key);
                    }
                });
                if (options.stopOnStdin) {
                    process.stdin.on("end", abort);
                    process.stdin.on("data", lines.push);
                    process.stdin.resume();
                    if (process.stdin.readableEnded) {
                        owner.abort();
                    }
                }
                try {
                    await watchWidget({
                        root: command.optsWithGlobals().stateRoot,
                        selectedKey: options.selected,
                        signal: owner.signal,
                        emit: (snapshot) => out.print(`${SafeJSON.stringify(snapshot)}\n`),
                        selections: (listener) => {
                            selections.add(listener);
                            return () => selections.delete(listener);
                        },
                    });
                } finally {
                    signal.removeEventListener("abort", abort);
                    process.stdin.removeListener("end", abort);
                    process.stdin.removeListener("data", lines.push);
                    if (options.stopOnStdin) {
                        process.stdin.pause();
                    }
                }
            },
            { handleTermination: true }
        );
    });
widget
    .command("readback")
    .requiredOption("--input <file>", "UTF-8 visible card text")
    .action(async (options) => {
        await withInterrupt(
            async (signal) => {
                await readWidgetText({ text: await Bun.file(options.input).text(), signal });
                out.result({ finished: true });
            },
            { handleTermination: true }
        );
    });
const shelf = widget.command("shelf").description("Stage captures and files before choosing an inbox recipient");
shelf
    .command("list")
    .option("--json")
    .action(async (_options, command) => {
        out.result(await listWidgetShelf(command.optsWithGlobals().stateRoot));
    });
shelf.command("import <input>").action(async (input: string, _options, command) => {
    await withInterrupt(
        async (signal) => {
            out.result(await importShelfFile({ root: command.optsWithGlobals().stateRoot, input, signal }));
        },
        { handleTermination: true }
    );
});
shelf
    .command("image <input>")
    .description("Stage an image for later attachment")
    .action(async (input: string, _options, command) => {
        await withInterrupt(
            async (signal) => {
                out.result(await stageShelfImage({ root: command.optsWithGlobals().stateRoot, input, signal }));
            },
            { handleTermination: true }
        );
    });
shelf
    .command("video <input>")
    .description(
        "Stage a screen recording for later attachment; attached, it gets the frame review a pasted video gets"
    )
    .option("--name <name>", "The name the shelf shows")
    .action(async (input: string, options: { name?: string }, command) => {
        await withInterrupt(
            async (signal) => {
                out.result(
                    await stageShelfMedia({
                        root: command.optsWithGlobals().stateRoot,
                        input,
                        name: options.name,
                        signal,
                        type: "video",
                    })
                );
            },
            { handleTermination: true }
        );
    });
shelf.command("capture").action(async (_options, command) => {
    await withInterrupt(
        async (signal) => {
            out.result(await captureShelfImage({ root: command.optsWithGlobals().stateRoot, signal }));
        },
        { handleTermination: true }
    );
});
shelf.command("remove <id>").action(async (id: string, _options, command) => {
    await removeShelfItem({ root: command.optsWithGlobals().stateRoot, id });
    out.result({ removed: true });
});
shelf
    .command("attachment <id>")
    .requiredOption("--session-key <key>")
    .action(async (id: string, options, command) => {
        out.result(
            await readShelfAttachment({ root: command.optsWithGlobals().stateRoot, id, key: options.sessionKey })
        );
    });
shelf
    .command("attach <id>")
    .requiredOption("--session-key <key>")
    .action(async (id: string, options, command) => {
        out.result(await attachShelfItem({ root: command.optsWithGlobals().stateRoot, id, key: options.sessionKey }));
    });

await runTool(program, { tool: "hub" });
