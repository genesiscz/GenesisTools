import { Api } from "@app/azure-devops/api";
import type { CommentFormat } from "@app/azure-devops/api.types";
import { commentPreview, parseCommentId, resolveCommentBody, resolveWorkItemId } from "@app/azure-devops/lib/comments";
import { requireConfig } from "@app/azure-devops/utils";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const TOOL = "tools azure-devops";
const LIST_FORMATS = ["table", "json"] as const;

interface BodyOptions {
    file?: string;
    text?: string;
    html?: boolean;
}

function formatOf(options: BodyOptions): CommentFormat {
    return options.html ? "html" : "markdown";
}

function addBodyOptions(command: Command): Command {
    return command
        .option("--file <path>", "Read the comment from a file ('-' reads stdin)")
        .option("--text <text>", "The comment text")
        .option("--html", "Send the text as HTML instead of markdown");
}

export function registerCommentCommand(program: Command): void {
    const comment = program.command("comment").description("Work item comments: list, add, edit, delete");

    comment
        .command("list")
        .alias("ls")
        .description("List the comments of a work item, newest first")
        .argument("<workitem>", "Work item id or URL")
        .option("--format <format>", "Output format: table|json", "table")
        .action(async (input: string, options: { format: string }) => {
            if (!(LIST_FORMATS as readonly string[]).includes(options.format)) {
                out.error(
                    suggestEnumFlag(`${TOOL} comment list`, "--format", LIST_FORMATS, {
                        subcommand: ["comment", "list"],
                        given: options.format,
                    })
                );
                process.exitCode = 1;
                return;
            }

            const workItemId = resolveWorkItemId(input);
            const comments = await new Api(requireConfig()).getComments(workItemId);

            if (options.format === "json") {
                out.result(comments);
                return;
            }

            renderCliHeader(`Comments on #${workItemId}`, `${comments.length} shown`);
            const table = createBoxTable(["ID", "AUTHOR", "CREATED", "EDITED", "FORMAT", "TEXT"]);

            for (const item of comments) {
                table.push([
                    pc.white(String(item.id)),
                    item.createdBy.displayName,
                    item.createdDate.slice(0, 16).replace("T", " "),
                    item.modifiedDate && item.modifiedDate !== item.createdDate ? pc.yellow("yes") : "",
                    item.format ?? "",
                    commentPreview(item.text),
                ]);
            }

            out.println(table.toString());
        });

    addBodyOptions(
        comment
            .command("add")
            .description("Add a comment to a work item (markdown unless --html)")
            .argument("<workitem>", "Work item id or URL")
    ).action(async (input: string, options: BodyOptions) => {
        const workItemId = resolveWorkItemId(input);
        const text = await resolveCommentBody(options);
        const config = requireConfig();
        const created = await new Api(config).addComment({ workItemId, text, format: formatOf(options) });

        out.println(`${pc.green("Added")} comment ${created.id} to #${workItemId}`);
        out.println(Api.workItemWebUrl(config, workItemId));
        out.println(pc.dim(`\nEdit it: ${TOOL} comment edit ${workItemId} ${created.id} --file <path>`));
    });

    addBodyOptions(
        comment
            .command("edit")
            .description("Replace the text of an existing comment")
            .argument("<workitem>", "Work item id or URL")
            .argument("<commentId>", "Comment id (see: comment list)")
    ).action(async (input: string, commentIdValue: string, options: BodyOptions) => {
        const workItemId = resolveWorkItemId(input);
        const commentId = parseCommentId(commentIdValue);
        const text = await resolveCommentBody(options);
        const config = requireConfig();
        const updated = await new Api(config).updateComment({
            workItemId,
            commentId,
            text,
            format: formatOf(options),
        });

        out.println(`${pc.green("Edited")} comment ${updated.id} on #${workItemId} (version ${updated.version})`);
        out.println(Api.workItemWebUrl(config, workItemId));
    });

    comment
        .command("delete")
        .alias("rm")
        .description("Delete a comment")
        .argument("<workitem>", "Work item id or URL")
        .argument("<commentId>", "Comment id (see: comment list)")
        .action(async (input: string, commentIdValue: string) => {
            const workItemId = resolveWorkItemId(input);
            const commentId = parseCommentId(commentIdValue);

            await new Api(requireConfig()).deleteComment({ workItemId, commentId });
            out.println(`${pc.green("Deleted")} comment ${commentId} on #${workItemId}`);
        });
}
