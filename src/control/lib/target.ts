import type { Command } from "commander";

/** Adds the shared element-targeting options used by every interaction/inspection command. */
export function addTargetOptions(cmd: Command): Command {
    return cmd
        .option("--id <axId>", "target by AXIdentifier")
        .option("--role <role>", "target by AXRole")
        .option("--title <title>", "target by AXTitle")
        .option("--desc <desc>", "target by AXDescription")
        .option("--q <query>", "universal search — checks id, title, desc, value, role, subrole")
        .option("--subrole <subrole>", "target by AXSubrole (e.g. AXCloseButton)")
        .option("--window <title>", "scope search to window with this title")
        .option("--exact", "force strict role/subrole matching (default is fuzzy)")
        .option("--depth <n>", "max search depth (default 15 — browser page content may need 40)");
}

/** Converts commander opts into ax-tool targeting flags. */
export function targetArgs(opts: Record<string, string | undefined>): string[] {
    const a: string[] = [];
    if (opts.q) {
        a.push("--q", opts.q);
    }
    if (opts.id) {
        a.push("--id", opts.id);
    }
    if (opts.role) {
        a.push("--role", opts.role);
    }
    if (opts.title) {
        a.push("--title", opts.title);
    }
    if (opts.desc) {
        a.push("--desc", opts.desc);
    }
    if (opts.subrole) {
        a.push("--subrole", opts.subrole);
    }
    if (opts.window) {
        a.push("--window", opts.window);
    }
    if (opts.exact) {
        a.push("--exact");
    }
    if (opts.depth) {
        a.push("--depth", opts.depth);
    }
    return a;
}

/** Best human-readable label for the targeted element. */
export function targetLabel(opts: Record<string, string | undefined>, result: Record<string, unknown>): string {
    return String(result.axId ?? result.desc ?? opts.q ?? opts.id ?? opts.desc ?? opts.title ?? "?");
}
