import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { recordAnswer } from "../lib/record";
import type { QaTag } from "../lib/types";

export function registerRecordCommand(program: Command): void {
    program
        .command("record")
        .description("Record a Q→A entry (used by the question_answer MCP tool / scripts)")
        .requiredOption("--q <question>", "the question")
        .option("--a <answer>", "the answer (markdown)")
        .option("--a-file <path>", "read answer from file")
        .option("--tag <tag>", "question|action|directive", "question")
        .option("--agent <label>", "subagent attribution label")
        .option("--session <id>", "override session id")
        .option("--project <name>", "override project")
        .action(async (o: Record<string, string>) => {
            const answer = o.aFile ? readFileSync(o.aFile, "utf8") : o.a;
            if (!answer) {
                process.stderr.write("error: --a or --a-file required\n");
                process.exitCode = 1;
                return;
            }

            const res = await recordAnswer({
                question: o.q,
                answer,
                tag: (o.tag as QaTag) ?? "question",
                agentLabel: o.agent,
                sessionId: o.session,
                project: o.project,
                source: "cli",
            });
            process.stdout.write(`recorded ${res.id}\n`);
            // One-shot command: a sink (e.g. the grammy Telegram client) can
            // leave an open handle that keeps the event loop alive, so a bare
            // `bun run … record` would hang. Exit explicitly once done.
            process.exit(0);
        });
}
