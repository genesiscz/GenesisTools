import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Api } from "@app/azure-devops/api";
import { formatJSON } from "@app/azure-devops/cache";
import { handleCliError } from "@app/azure-devops/cli.utils";
import { resolveWorkItemId } from "@app/azure-devops/lib/comments";
import {
    executeWorkItemUpdate,
    localImageSources,
    parseFieldSpec,
    parseReuseFile,
    sha256Hex,
    type WorkItemUpdateImage,
    type WorkItemUpdateResult,
} from "@app/azure-devops/lib/work-item-update";
import { requireConfig } from "@app/azure-devops/utils";
import { isInsideDir } from "@genesiscz/utils/fs/canonical";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

export function resolveImages(values: string[], imageRoot: string): WorkItemUpdateImage[] {
    const sources = [...new Set(values.flatMap((value) => localImageSources(value)))];
    const images: WorkItemUpdateImage[] = [];

    for (const src of sources) {
        const path = resolve(imageRoot, decodeURI(src));

        if (!existsSync(path)) {
            throw new Error(`local image not found: ${path}`);
        }

        // A field value can come from a draft another tool or agent wrote; only files under the image root upload.
        if (!isInsideDir(imageRoot, path)) {
            throw new Error(`local image ${path} is outside --image-root ${imageRoot}`);
        }

        const bytes = new Uint8Array(readFileSync(path));

        images.push({ src, name: src.slice(src.lastIndexOf("/") + 1), sha256: sha256Hex(bytes), bytes });
    }

    return images;
}

function printResult(result: WorkItemUpdateResult, asJson: boolean): void {
    if (!result.ok) {
        if (asJson) {
            out.println(formatJSON(result));
        } else {
            out.error(result.error);

            for (const mismatch of result.mismatches ?? []) {
                out.error(`${mismatch.field}: sent and stored differ`);
            }
        }

        process.exitCode = 1;
        return;
    }

    if (asJson) {
        out.println(formatJSON(result));
        return;
    }

    if (result.dryRun) {
        out.println(`dry run, rev ${result.plan.rev}, nothing sent`);
        out.println(formatJSON(result.plan.operations));

        for (const upload of result.plan.uploads) {
            out.println(`would upload ${upload.src}`);
        }

        return;
    }

    out.println(`updated work item to rev ${result.rev}`);
}

export function registerWorkItemUpdateCommand(program: Command): void {
    program
        .command("workitem-update")
        .alias("update")
        .description(
            "Read a work item, including multilineFieldsFormat, and update fields in one JSON Patch. Without --confirm, print the patch and send nothing."
        )
        .argument("<workitem>", "Work item id or URL")
        .option(
            "--field <name=value>",
            "Set this field. Repeat for each field. A value that starts with @ is a file path (Name=@./text.html).",
            collect,
            []
        )
        .option(
            "--markdown <field>",
            "Switch this multiline field to Markdown when it is not already. Repeat for each field. The name is the caller's; Markdown cannot be switched back.",
            collect,
            []
        )
        .option(
            "--rev <n>",
            "Refuse the update unless the work item is still at this rev. The patch tests /rev either way."
        )
        .option("--image-root <dir>", "Directory that relative <img src> paths are resolved against.", process.cwd())
        .option(
            "--reuse <file>",
            'JSON { "<file name>": { "sha256": "<hex>", "url": "<attachment url>" } }. A local image with the same sha256 is not uploaded again.'
        )
        .option("--confirm", "Send the patch. Without it, the command only prints what it would send.")
        .option("--json", "Print the live work item, the dry-run plan, or the verify result as JSON.")
        .action(
            async (
                workitem: string,
                options: {
                    field: string[];
                    markdown: string[];
                    rev?: string;
                    imageRoot: string;
                    reuse?: string;
                    confirm?: boolean;
                    json?: boolean;
                }
            ) => {
                try {
                    const config = requireConfig();
                    const api = new Api(config);
                    const id = resolveWorkItemId(workitem, config.org);
                    const asJson = options.json === true;

                    if (options.field.length === 0 && options.markdown.length === 0) {
                        const item = await api.getWorkItemLive(id);
                        out.println(asJson ? formatJSON(item) : `work item ${item.id} rev ${item.rev}`);

                        if (!asJson) {
                            out.println(formatJSON(item.multilineFieldsFormat));
                        }

                        return;
                    }

                    const rev = options.rev === undefined ? undefined : Number(options.rev);

                    if (rev !== undefined && !Number.isInteger(rev)) {
                        throw new Error(`--rev must be an integer, got '${options.rev}'`);
                    }

                    const fields = options.field.map((spec) =>
                        parseFieldSpec(spec, (path) => readFileSync(path, "utf8"))
                    );
                    const reuse = options.reuse ? parseReuseFile(readFileSync(options.reuse, "utf8")) : new Map();
                    const images = resolveImages(
                        fields.map((field) => field.value),
                        options.imageRoot
                    );
                    const result = await executeWorkItemUpdate(
                        {
                            read: (itemId) => api.getWorkItemLive(itemId),
                            upload: (fileName, bytes) => api.uploadAttachment(fileName, bytes),
                            update: (itemId, operations) =>
                                api.updateWorkItem(itemId, operations).then(() => undefined),
                        },
                        {
                            id,
                            rev,
                            fields,
                            markdownFields: options.markdown,
                            images,
                            reuse,
                            confirm: options.confirm === true,
                        }
                    );
                    printResult(result, asJson);
                } catch (error) {
                    handleCliError(error);
                }
            }
        );
}
