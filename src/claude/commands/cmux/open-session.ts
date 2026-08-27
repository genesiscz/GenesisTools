import { type OpenSessionTarget, openSessionAt } from "@app/claude/lib/cmux/open-session";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

export interface OpenSessionOptions {
    window?: string;
    workspace?: string;
    pane?: string;
    surface?: string;
    enter?: boolean;
    json?: boolean;
}

/** Exactly one target level; pane and surface need the workspace that owns them. */
export function resolveTarget(opts: OpenSessionOptions): OpenSessionTarget | string {
    const picked = [opts.window, opts.workspace, opts.pane, opts.surface].filter((v) => v !== undefined).length;

    if (opts.pane !== undefined && opts.workspace !== undefined && picked === 2) {
        return { kind: "pane", workspaceRef: opts.workspace, paneRef: opts.pane };
    }

    if (opts.surface !== undefined && opts.workspace !== undefined && picked === 2) {
        return { kind: "surface", workspaceRef: opts.workspace, surfaceRef: opts.surface };
    }

    if (picked !== 1) {
        return "pass exactly one target: --window, --workspace, --workspace + --pane, or --workspace + --surface";
    }

    if (opts.window !== undefined) {
        return { kind: "window", windowRef: opts.window };
    }

    if (opts.workspace !== undefined) {
        return { kind: "workspace", workspaceRef: opts.workspace };
    }

    return "--pane and --surface need the owning --workspace";
}

export async function openSessionCommand(sessionId: string, opts: OpenSessionOptions): Promise<void> {
    const target = resolveTarget(opts);

    if (typeof target === "string") {
        out.printlnErr(pc.red(target));
        process.exitCode = 2;
        return;
    }

    try {
        const result = await openSessionAt(sessionId, target, { enter: opts.enter });

        if (opts.json) {
            out.result(result);
            return;
        }

        out.println(
            `${pc.green("✔")} ${result.sessionId.slice(0, 8)} → ${result.workspaceRef} ${result.surfaceRef} ` +
                pc.dim(`(${result.target})`)
        );
        out.println(pc.dim(result.command));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (opts.json) {
            out.result({ ok: false, error: message });
        } else {
            out.printlnErr(pc.red(message));
        }

        process.exitCode = 1;
    }
}
