import { candidateHint, candidateLabel, labelWidths } from "@app/claude/lib/cmux/display";
import { loadPins } from "@app/claude/lib/cmux/pins";
import { listCandidates } from "@app/claude/lib/cmux/sessions";
import {
    defaultSnapshotName,
    deleteSnapshot,
    isValidSnapshotName,
    listSnapshots,
    saveSnapshot,
    toSnapshotEntries,
} from "@app/claude/lib/cmux/snapshot";
import type { RestoreCandidate } from "@app/claude/lib/cmux/types";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { cancelSymbol, searchMultiselect } from "@genesiscz/utils/prompts/clack/search-multiselect";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

export interface SnapshotOptions {
    last: string;
    within: string;
    thisProject?: boolean;
    yes?: boolean;
}

/**
 * Capture the sessions that are currently in play so a crashed machine can get them
 * back verbatim. "In play" is transcript activity inside --within, which is the only
 * signal that survives the crash you are protecting against: a process list does not.
 */
export async function snapshotCommand(name: string | undefined, opts: SnapshotOptions): Promise<void> {
    const snapshotName = name ?? defaultSnapshotName(new Date());

    if (!isValidSnapshotName(snapshotName)) {
        out.error(pc.red(`Invalid snapshot name "${snapshotName}" — letters, digits, dot, dash, underscore.`));
        process.exit(1);
    }

    const hours = Number.parseFloat(opts.within);

    if (!Number.isFinite(hours) || hours <= 0) {
        out.error(pc.red(`--within must be a positive number of hours (got "${opts.within}").`));
        process.exit(1);
    }

    const spinner = p.spinner();
    spinner.start("Scanning recent sessions...");
    const candidates = await listCandidates({
        limit: Number.parseInt(opts.last, 10) || 20,
        thisProjectOnly: opts.thisProject === true,
        maxAgeMs: hours * 3_600_000,
    });
    spinner.stop(
        `Found ${candidates.length} session${candidates.length === 1 ? "" : "s"} active in the last ${hours}h`
    );

    if (candidates.length === 0) {
        out.printlnErr(pc.yellow("Nothing to snapshot."));
        return;
    }

    const picked = await pick(candidates, opts);

    if (picked.length === 0) {
        out.printlnErr(pc.yellow("Nothing selected — no snapshot written."));
        return;
    }

    const pins = await loadPins();
    const workspaceIds = new Map(picked.map((c) => [c.sessionId, pins.get(c.sessionId)?.workspaceId ?? null]));
    const path = await saveSnapshot({
        name: snapshotName,
        capturedAt: new Date().toISOString(),
        entries: toSnapshotEntries(picked, workspaceIds),
    });

    out.printlnErr(`${pc.green("✔")} Saved ${pc.bold(snapshotName)} — ${picked.length} sessions`);
    out.printlnErr(pc.dim(`  ${path}`));
    out.printlnErr(pc.dim(`  Restore with: ${pc.cyan(`tools claude cmux restore ${snapshotName}`)}`));
}

async function pick(candidates: RestoreCandidate[], opts: SnapshotOptions): Promise<RestoreCandidate[]> {
    if (opts.yes || !isInteractive()) {
        if (!opts.yes) {
            out.error(pc.red("Non-interactive: pass -y to snapshot everything found."));
            out.printlnErr(suggestCommand("tools claude cmux snapshot", { add: ["-y"] }));
            process.exit(1);
        }

        return candidates;
    }

    const columns = process.stdout.columns ?? 120;
    const widths = labelWidths(candidates);
    const selected = await searchMultiselect({
        message: "Sessions to capture (space toggles)",
        items: candidates.map((candidate) => ({
            value: candidate,
            label: candidateLabel(candidate, widths, columns),
            hint: candidateHint(candidate, columns),
        })),
        initialSelected: candidates,
        maxVisible: 14,
    });

    if (selected === cancelSymbol) {
        p.cancel("Cancelled — no snapshot written.");
        process.exit(0);
    }

    return selected as RestoreCandidate[];
}

export interface ListOptions {
    json?: boolean;
}

export async function listCommand(opts: ListOptions = {}): Promise<void> {
    const snapshots = await listSnapshots();

    if (opts.json) {
        out.result(SafeJSON.stringify(snapshots, null, 2));
        return;
    }

    if (snapshots.length === 0) {
        out.printlnErr(pc.yellow("No snapshots saved yet."));
        out.printlnErr(pc.dim(`  Capture one with: ${pc.cyan("tools claude cmux snapshot")}`));
        return;
    }

    renderCliHeader("Claude session snapshots", "restorable sets of sessions");

    const table = createBoxTable(["NAME", "CAPTURED", "SESSIONS", "PROJECTS"]);

    for (const snapshot of snapshots) {
        table.push([
            pc.white(snapshot.name),
            pc.dim(snapshot.capturedAt.replace("T", " ").slice(0, 16)),
            String(snapshot.entries),
            truncateDisplay(snapshot.projects.join(", "), 46),
        ]);
    }

    out.println(table.toString());
    out.printlnErr(pc.dim(`Restore: ${pc.cyan("tools claude cmux restore <name>")}`));
}

export async function forgetCommand(name: string): Promise<void> {
    await deleteSnapshot(name);
    out.printlnErr(`${pc.green("✔")} Deleted snapshot ${pc.bold(name)}`);
}
