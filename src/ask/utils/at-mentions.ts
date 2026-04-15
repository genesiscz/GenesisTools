import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

export interface ExpandedMention {
    original: string;
    path: string;
    content: string;
}

export interface AtMentionResult {
    text: string;
    mentions: ExpandedMention[];
}

/**
 * Expand @file references in user input.
 * Matches @path/to/file.ext patterns, reads the file,
 * and appends content as a code block.
 *
 * Only matches paths that contain a dot (file extension) to avoid
 * matching @-mentions in natural language (e.g. @someone).
 */
export function expandAtMentions(input: string): AtMentionResult {
    const mentionRegex = /@([\w./-]+\.\w+)/g;
    const mentions: ExpandedMention[] = [];
    let match: RegExpExecArray | null = mentionRegex.exec(input);

    while (match !== null) {
        const raw = match[1];
        const filePath = resolve(raw);

        if (!existsSync(filePath)) {
            continue;
        }

        try {
            const content = readFileSync(filePath, "utf-8");
            mentions.push({ original: match[0], path: filePath, content });
        } catch {
            // Skip unreadable files silently
        }

        match = mentionRegex.exec(input);
    }

    if (mentions.length === 0) {
        return { text: input, mentions: [] };
    }

    let expanded = input;

    for (const m of mentions) {
        const ext = extname(m.path).replace(".", "");
        expanded += `\n\n--- ${m.path} ---\n\`\`\`${ext}\n${m.content}\n\`\`\``;
    }

    return { text: expanded, mentions };
}
