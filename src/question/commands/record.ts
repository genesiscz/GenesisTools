import { readFileSync } from "node:fs";
import { sourceMessageSchema } from "@genesiscz/utils/agent/source-anchor";
import { parseImageAttachmentInputs } from "@genesiscz/utils/image/attachments";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { imageInputs } from "../lib/message";
import { recordAnswer } from "../lib/record";
import type { QaTag } from "../lib/types";
import { collect } from "./ask";

export function registerRecordCommand(program: Command): void {
    // No `answer` alias: that verb now answers a PENDING form (`tools question answer <id>`),
    // matching `genesis qa answer`. Nothing referenced the alias — the skill calls `record`.
    program
        .command("record")
        .description("Record a Q→A entry after the fact (used by the question_answer MCP tool / scripts)")
        .requiredOption("--q <question>", "the question")
        .option("--a <answer>", "the answer (markdown)")
        .option("--a-file <path>", "read answer from file")
        .option(
            "--attachments-file <path>",
            "JSON array of local image attachments, including optional comparison roles"
        )
        .option("--image <path>", "a PNG/JPEG/WebP screenshot to attach (repeatable)", collect, [])
        .option("--json", "return the receipt and durable attachment paths as JSON")
        .option("--tag <tag>", "question|action|directive|message", "question")
        .option("--agent <label>", "subagent attribution label")
        .option("--session <id>", "override session id")
        .option("--project <name>", "override project")
        .option("--project-path <path>", "source worktree directory for repository context")
        .option(
            "--source-message-file <path>",
            "JSON object containing only known native messageId, turnId or toolCallId"
        )
        .action(async (o: Record<string, string> & { image: string[] }) => {
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
                attachments: imageInputs({
                    images: o.image,
                    attachments: o.attachmentsFile
                        ? parseImageAttachmentInputs(SafeJSON.parse(readFileSync(o.attachmentsFile, "utf8")))
                        : undefined,
                    cwd: o.projectPath,
                }),
                agentLabel: o.agent,
                sessionId: o.session,
                project: o.project,
                projectPath: o.projectPath,
                source: "cli",
                sourceMessage: o.sourceMessageFile
                    ? sourceMessageSchema.parse(SafeJSON.parse(readFileSync(o.sourceMessageFile, "utf8")))
                    : undefined,
            });
            if (o.json) {
                out.result(res);
            } else {
                out.print(`recorded ${res.id}\n`);
            }

            // One-shot command: a sink (e.g. the grammy Telegram client) can
            // leave an open handle that keeps the event loop alive, so a bare
            // `bun run … record` would hang. Exit explicitly once done.
            process.exit(0);
        });
}
