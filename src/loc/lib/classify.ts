import { commentSyntaxForExt } from "./languages";

export interface ClassifyInput {
    content: string;
    ext: string;
}

export interface LineCounts {
    code: number;
    comment: number;
    blank: number;
}

export function classifyFile({ content, ext }: ClassifyInput): LineCounts {
    const counts: LineCounts = { code: 0, comment: 0, blank: 0 };

    if (content.length === 0) {
        return counts;
    }

    const { line: linePrefixes, block } = commentSyntaxForExt(ext);
    const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
    const lines = normalized.split("\n");
    let activeBlock: { close: string } | null = null;

    for (const raw of lines) {
        const trimmed = raw.trim();

        if (trimmed.length === 0) {
            counts.blank += 1;
            continue;
        }

        const result = classifyLine({ trimmed, linePrefixes, block, activeBlock });
        activeBlock = result.activeBlock;

        if (result.kind === "comment") {
            counts.comment += 1;
        } else {
            counts.code += 1;
        }
    }

    return counts;
}

interface ClassifyLineInput {
    trimmed: string;
    linePrefixes: string[];
    block: { open: string; close: string }[];
    activeBlock: { close: string } | null;
}

interface ClassifyLineResult {
    kind: "code" | "comment";
    activeBlock: { close: string } | null;
}

function classifyLine({ trimmed, linePrefixes, block, activeBlock }: ClassifyLineInput): ClassifyLineResult {
    let cursor = 0;
    let sawCode = false;
    let sawComment = false;
    let open = activeBlock;

    while (cursor < trimmed.length) {
        if (open) {
            const closeIdx = trimmed.indexOf(open.close, cursor);
            if (closeIdx === -1) {
                sawComment = true;
                return { kind: sawCode ? "code" : "comment", activeBlock: open };
            }

            sawComment = true;
            cursor = closeIdx + open.close.length;
            open = null;
            continue;
        }

        const rest = trimmed.slice(cursor);

        if (rest.trim().length === 0) {
            break;
        }

        const linePrefix = linePrefixes.find((p) => rest.startsWith(p));
        if (linePrefix) {
            sawComment = true;
            break;
        }

        const blockStart = block.find((b) => rest.startsWith(b.open));
        if (blockStart) {
            sawComment = true;
            open = { close: blockStart.close };
            cursor += blockStart.open.length;
            continue;
        }

        sawCode = true;
        cursor += 1;
    }

    if (sawCode) {
        return { kind: "code", activeBlock: open };
    }

    if (sawComment) {
        return { kind: "comment", activeBlock: open };
    }

    return { kind: "code", activeBlock: open };
}
