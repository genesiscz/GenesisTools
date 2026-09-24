#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { formatHandoffEvent, parseSince, watchHandoffs } from "./watch";

const program = new Command()
    .name("handoff")
    .description("Follow the handoff event log (the store behind the handoff_* MCP tools)");

program
    .command("watch")
    .description("Print one line per handoff event: post, claim, checked task + proof, deny, comment, finish")
    .argument("[handoffs...]", "handoff ids or readable names; none follows every handoff")
    .option("--since <duration>", "replay events from this long ago first, e.g. 30m, 6h, 2d", "0")
    .option("--once", "print the replay and exit instead of following")
    .option("--json", "one JSON event per line")
    .action((handoffs: string[], opts: { since: string; once?: boolean; json?: boolean }) => {
        let sinceMs: number;

        try {
            sinceMs = parseSince(opts.since);
        } catch (error) {
            out.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
            return;
        }

        const watch = watchHandoffs({
            filters: handoffs,
            sinceMs,
            follow: !opts.once,
            onEvent: (event, names) => {
                out.println(opts.json ? SafeJSON.stringify(event) : formatHandoffEvent(event, names));
            },
        });

        if (opts.once) {
            watch.close();
            return;
        }

        process.on("SIGINT", () => {
            watch.close();
            process.exit(0);
        });
    });

await runTool(program, { tool: "handoff" });
