import { indexEntries } from "@app/debugging-master/core/log-parser";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import { formatSchema } from "@app/utils/json-schema";
import { search } from "@jmespath-community/jmespath";
import type { Command } from "commander";

const TOOL = "tools debugging-master";

export function registerExpandCommand(program: Command): void {
    program
        .command("expand <refId>")
        .description("Expand a ref to show full data or schema")
        .option("--schema <mode>", "Schema mode: skeleton, typescript, schema")
        .option("--full", "Show complete raw data")
        .option("--query <jmes>", "JMESPath projection")
        .action(async (refId: string, opts) => {
            const globalOpts = program.opts();
            const sessionManager = new SessionManager();
            const sessionName = await sessionManager.resolveSession(globalOpts.session);

            const prefix = refId[0];
            const entryIndex = parseInt(refId.slice(1), 10);
            if (Number.isNaN(entryIndex)) {
                console.error(`Invalid ref ID: ${refId}. Expected format like d2, e5, s8`);
                process.exit(1);
            }

            const raw = await sessionManager.readEntries(sessionName);
            const entries = indexEntries(raw);
            const entry = entries.find((e) => e.index === entryIndex);

            if (!entry) {
                console.error(`Entry #${entryIndex} not found in session "${sessionName}"`);
                process.exit(1);
            }

            let data: unknown;
            if (prefix === "s") {
                data = entry.vars;
            } else if (prefix === "e" && entry.data && entry.stack) {
                data = { ...(entry.data as Record<string, unknown>), _stack: entry.stack };
            } else {
                data = entry.data ?? entry.stack;
            }
            if (data === undefined) {
                console.error(`Entry #${entryIndex} has no data to expand`);
                process.exit(1);
            }

            let output: string;

            if (opts.query) {
                const result = search(data as never, opts.query);
                output = JSON.stringify(result, null, 2);
            } else if (opts.full) {
                output = JSON.stringify(data, null, 2);
            } else {
                const schemaMode = opts.schema ?? "skeleton";
                output = formatSchema(data, schemaMode);
            }

            console.log(`[ref:${refId}] Entry #${entryIndex} (${entry.level})`);
            console.log(output);

            if (!opts.full && !opts.query) {
                console.log(`\nTip: Full data → ${TOOL} expand ${refId} --full`);
                console.log(`Tip: Query → ${TOOL} expand ${refId} --query '<jmespath>'`);
            } else if (opts.full) {
                console.log(`\nTip: Query → ${TOOL} expand ${refId} --query '<jmespath>'`);
            }
        });
}
