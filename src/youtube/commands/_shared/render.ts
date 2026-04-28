import { copyToClipboard } from "@app/utils/clipboard";
import { SafeJSON } from "@app/utils/json";

export interface RenderFlags {
    json?: boolean;
    clipboard?: boolean;
}

export interface RenderOpts {
    text: string;
    json: unknown;
    flags: RenderFlags;
}

export async function renderOrEmit(opts: RenderOpts): Promise<void> {
    const output = opts.flags.json ? SafeJSON.stringify(opts.json, null, 2) : opts.text;

    if (opts.flags.clipboard) {
        await copyToClipboard(output, { label: "youtube" });
        return;
    }

    if (output.length > 0) {
        process.stdout.write(`${output}\n`);
    }
}
