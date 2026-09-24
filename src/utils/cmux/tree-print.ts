import type { AgentCmuxSurface } from "@genesiscz/utils/cmux/agent-tree";
import type { CmuxTree, CmuxTreeSurface } from "@genesiscz/utils/cmux/tree";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

type PrintableSurface = CmuxTreeSurface & Partial<Pick<AgentCmuxSurface, "sessionId" | "sessionHint" | "provider">>;

/** The indented listing `tools cmux tree`, `tools ai cmux tree` and `tools claude cmux tree` print. */
export function printCmuxTree(tree: CmuxTree<PrintableSurface>): void {
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
                out.println(
                    `    ${pc.magenta(pane.id)} ${pane.title}${activeMark}${pc.dim(pane.cwd ? ` — ${pane.cwd}` : "")}`
                );

                for (const surface of pane.surfaces) {
                    const session = surface.sessionId ?? surface.sessionHint;
                    const agent = surface.provider ? `${surface.provider} ` : "";
                    const sessionLabel = session ? pc.yellow(` · ${agent}${session.slice(0, 8)}`) : "";
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
