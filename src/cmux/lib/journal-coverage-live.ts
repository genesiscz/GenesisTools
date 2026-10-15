import { liveTree } from "@app/cmux/lib/live-layout";
import { agentsByTty } from "@app/cmux/lib/session-close-live";
import { type CoverageTab, type JournalCoverage, journalCoverage } from "@genesiscz/utils/cmux/journal-coverage";

/**
 * The live terminal tabs of cmux against the surface journal. Read-only: one `cmux tree` call, one process-table
 * read and one read of the journal. A tab counts as an agent tab when a Claude, Codex or Grok process of this
 * user runs on its tty; an agent inside tmux shows as `tmux attach` there and is not counted.
 */
export async function liveJournalCoverage(): Promise<JournalCoverage> {
    const tree = await liveTree();
    const agents = agentsByTty();
    const tabs: CoverageTab[] = [];

    for (const surface of tree.surfaces.values()) {
        if (!surface.id) {
            continue;
        }

        tabs.push({
            surfaceId: surface.id,
            label: surface.ref,
            agent: surface.tty !== null && agents.has(surface.tty.replace(/^\/dev\//, "")),
        });
    }

    return journalCoverage({ tabs });
}
