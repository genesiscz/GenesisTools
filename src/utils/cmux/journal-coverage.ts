import { loadAllSessionCmuxRefs } from "./session-refs";

export interface CoverageTab {
    /** The cmux surface UUID: the key the journal records a tab by. */
    surfaceId: string;
    /** An agent (Claude, Codex, Grok) runs on the tab's tty now. */
    agent?: boolean;
    /** What names the tab to a person (`surface:12`). Defaults to the UUID. */
    label?: string;
}

export interface JournalCoverage {
    /** Live terminal tabs checked. */
    tabs: number;
    /** Tabs with a trusted journal record; null when the journal could not be read. */
    recorded: number | null;
    agentTabs: number;
    /** Labels of the agent tabs the journal has no record for: a restore cannot place their sessions. */
    unrecordedAgentTabs: string[];
}

/**
 * How much of the live tabs the surface journal knows. Read-only: it reads the journal and never writes it.
 *
 * A record is any line a reader keeps for the tab's UUID, ended or not. The hook writes it when an agent starts
 * or takes a prompt in the tab, so a running agent tab without one is invisible to a restore after a restart,
 * `agents list` and `who` (the genesis-tools plugin did not load, or the agent runs under a harness without it).
 */
export function journalCoverage({
    tabs,
    refsPath,
    beforeMs,
}: {
    tabs: readonly CoverageTab[];
    refsPath?: string;
    beforeMs?: number;
}): JournalCoverage {
    const known = new Set<string>();
    let unavailable = false;
    const refs = loadAllSessionCmuxRefs(refsPath, {
        beforeMs,
        onReadError: () => {
            unavailable = true;
        },
    });

    for (const entry of refs.values()) {
        if (entry.surfaceId) {
            known.add(entry.surfaceId.toLowerCase());
        }
    }

    const seen = new Set<string>();
    const coverage: JournalCoverage = {
        tabs: 0,
        recorded: unavailable ? null : 0,
        agentTabs: 0,
        unrecordedAgentTabs: [],
    };

    for (const tab of tabs) {
        const id = tab.surfaceId.toLowerCase();

        if (seen.has(id)) {
            continue;
        }

        seen.add(id);
        coverage.tabs += 1;

        const recorded = known.has(id);

        if (recorded && coverage.recorded !== null) {
            coverage.recorded += 1;
        }

        if (tab.agent) {
            coverage.agentTabs += 1;

            if (!unavailable && !recorded) {
                coverage.unrecordedAgentTabs.push(tab.label ?? tab.surfaceId);
            }
        }
    }

    return coverage;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The `cmux doctor` line. */
export function describeJournalCoverage(coverage: JournalCoverage): string {
    if (coverage.recorded === null) {
        return "not checked (the surface journal could not be read)";
    }

    const head = `${coverage.recorded} of ${plural(coverage.tabs, "live tab")} ${coverage.tabs === 1 ? "has" : "have"} a surface-journal record`;
    const missing = coverage.unrecordedAgentTabs.length;

    if (coverage.agentTabs === 0) {
        return `${head}; no agent runs in a tab now`;
    }

    if (missing === 0) {
        return coverage.agentTabs === 1
            ? `${head}; the agent tab is recorded`
            : `${head}; all ${coverage.agentTabs} agent tabs are recorded`;
    }

    return `${head}; ${missing} of ${plural(coverage.agentTabs, "agent tab")} ${missing === 1 ? "has" : "have"} none`;
}

/** The restore plan line: how many of the tabs to restore the journal could be joined to. */
export function describeJournalJoin(coverage: JournalCoverage): string {
    if (coverage.recorded === null) {
        return "not checked (the surface journal could not be read)";
    }

    if (coverage.tabs === 0) {
        return "no terminal tabs to find in the surface journal";
    }

    return `${coverage.recorded} of ${plural(coverage.tabs, "tab")} found in the surface journal`;
}

const WARNING_LABELS = 5;

/** The `agents list` warning for agent tabs the journal has no record of, or null when there are none. */
export function journalCoverageWarning(coverage: JournalCoverage): string | null {
    if (coverage.recorded === null) {
        return "Surface-journal coverage not checked (the journal could not be read).";
    }

    const missing = coverage.unrecordedAgentTabs;

    if (missing.length === 0) {
        return null;
    }

    const shown = missing.slice(0, WARNING_LABELS).join(", ");
    const more = missing.length > WARNING_LABELS ? `, and ${missing.length - WARNING_LABELS} more` : "";

    const agents = missing.length === 1 ? "its agent" : "their agents";

    return `No surface-journal record for ${plural(missing.length, "live agent tab")} (${shown}${more}). A restore cannot place ${agents}. Run \`claude plugin list\` to check that the hook loaded.`;
}
