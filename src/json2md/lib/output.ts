import { isInteractive } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import clipboardy from "clipboardy";

export type Destination = "stdout" | "file" | "clipboard";

export interface DeliverOptions {
    markdown: string;
    /** An explicit `--output` path. */
    file?: string;
    clipboard?: boolean;
    /** Ask where to put it when nothing was chosen and the session is interactive. */
    ask?: boolean;
}

/**
 * Sends the rendered markdown to its destination.
 *
 * `out.print` is the only writer to stdout here, so piping `tools json2md x.json > x.md`
 * yields the document and nothing else. Every status line goes to stderr.
 */
export async function deliver(options: DeliverOptions): Promise<Destination> {
    if (options.file) {
        await Bun.write(options.file, options.markdown);
        logger.debug({ file: options.file, bytes: options.markdown.length }, "json2md: written");
        out.log.success(`Written to ${options.file}`);

        return "file";
    }

    if (options.clipboard) {
        await clipboardy.write(options.markdown);
        out.log.success("Copied to clipboard");

        return "clipboard";
    }

    if (options.ask && isInteractive()) {
        const choice = await p.select({
            message: "Where should the markdown go?",
            options: [
                { value: "stdout" as const, label: "stdout" },
                { value: "clipboard" as const, label: "clipboard" },
                { value: "file" as const, label: "a file" },
            ],
            initialValue: "stdout" as const,
        });

        if (p.isCancel(choice)) {
            return "stdout";
        }

        if (choice === "clipboard") {
            return deliver({ ...options, clipboard: true, ask: false });
        }

        if (choice === "file") {
            const path = await p.text({ message: "File path", placeholder: "./out.md" });

            if (!p.isCancel(path) && typeof path === "string" && path.trim() !== "") {
                return deliver({ ...options, file: path.trim(), ask: false });
            }
        }
    }

    out.print(options.markdown);

    return "stdout";
}
