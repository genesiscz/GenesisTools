import { type CmuxTree, fetchCmuxTree } from "@app/claude/lib/cmux/tree";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

export interface TreeOptions {
    json?: boolean;
}

function renderHuman(tree: CmuxTree): void {
    if (!tree.available) {
        out.printlnErr(pc.yellow(`cmux is not reachable: ${tree.error ?? "unknown error"}`));
        return;
    }

    for (const window of tree.windows) {
        const windowLabel = window.ref ?? window.id;
        out.println(pc.bold(`${windowLabel}${window.key ? pc.dim(" (key)") : ""}`));

        for (const workspace of window.workspaces) {
            out.println(`  ${pc.cyan(workspace.id)} ${workspace.name}`);

            for (const pane of workspace.panes) {
                const activeMark = pane.active ? pc.green(" · active") : "";
                out.println(`    ${pc.magenta(pane.id)} ${pane.title}${activeMark}${pc.dim(pane.cwd ? ` — ${pane.cwd}` : "")}`);

                for (const surface of pane.surfaces) {
                    const session = surface.sessionId ?? surface.sessionHint;
                    const sessionLabel = session ? pc.yellow(` · ${session.slice(0, 8)}`) : "";
                    const selectedMark = surface.selected ? pc.green("●") : pc.dim("○");
                    out.println(
                        `      ${selectedMark} ${pc.dim(surface.id)} [${surface.type}] ${surface.title}${sessionLabel}`
                    );
                }
            }
        }
    }

    out.println(pc.dim(`${Math.round(tree.totalMs)}ms`));
}

/** `tools claude cmux tree` — the live window → workspace → pane → surface hierarchy. */
export async function treeCommand(opts: TreeOptions): Promise<void> {
    const tree = await fetchCmuxTree();

    if (opts.json) {
        out.result(tree);
        return;
    }

    renderHuman(tree);
}
