/** The harness file tools, by the `via` they produce. Codex/Grok names are folded in lower case. */
const FILE_TOOLS: Readonly<Record<string, "edit" | "write" | "notebook">> = {
    edit: "edit",
    multiedit: "edit",
    write: "write",
    notebookedit: "notebook",
};

export function fileToolVia(name: string): "edit" | "write" | "notebook" | null {
    return FILE_TOOLS[name.toLowerCase().replace(/_/g, "")] ?? null;
}

export function isShellTool(name: string): boolean {
    const normalized = name.toLowerCase();
    return normalized === "bash" || normalized === "shell" || normalized === "exec_command";
}

/** `old` replaced by `next` without `String.replace`, whose `$&` patterns would corrupt the text. */
export function applyReplacement(source: string, old: string, next: string, all: boolean): string | null {
    if (old.length === 0) {
        return null;
    }

    if (all) {
        return source.includes(old) ? source.split(old).join(next) : null;
    }

    const at = source.indexOf(old);
    return at === -1 ? null : source.slice(0, at) + next + source.slice(at + old.length);
}
