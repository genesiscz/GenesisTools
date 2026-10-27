#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { executeHandoffActions } from "./executor";
import { formatHandoffEvent, parseSince, watchHandoffs } from "./watch";

const program = new Command()
    .name("handoff")
    .description("Follow and change handoffs (the store behind the handoff_* MCP tools)");

program
    .command("modify")
    .description(
        "Change a handoff you posted (handoff_action modify_handoff). --project moves it to another project; the move is kept in its events"
    )
    .argument("<handoff>", "handoff id or readable name")
    .requiredOption("--project <name|path>", "the project the handoff is for: a project name or a repository path")
    .option("--edit-id <editId>", "the poster's edit credential, when this is not the session that posted it")
    .option("--json", "print the whole response as JSON")
    .action((handoff: string, opts: { project: string; editId?: string; json?: boolean }) => {
        const response = executeHandoffActions({
            id: handoff,
            editId: opts.editId,
            actions: [{ action: "modify_handoff", project: opts.project }],
        });
        const result = response.results[0];

        if (opts.json) {
            out.result(response);
        } else if (result?.ok) {
            out.log.success(`${response.handoff.id} is now under project ${response.handoff.project ?? "(none)"}`);
        }

        if (!result?.ok) {
            if (!opts.json) {
                out.error(result?.error ?? "modify_handoff was not applied");
            }

            process.exitCode = 1;
        }
    });

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
