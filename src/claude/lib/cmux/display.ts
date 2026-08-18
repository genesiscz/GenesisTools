import type { RestoreCandidate } from "@app/claude/lib/cmux/types";
import pc from "picocolors";

/** "12m ago" / "2h ago" / "3d ago" — coarse on purpose, it is a disambiguator. */
export function agePhrase(mtimeMs: number, now = Date.now()): string {
    const minutes = Math.max(0, Math.round((now - mtimeMs) / 60_000));

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.round(minutes / 60);

    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Where the session was working: `GenesisTools/.worktrees/fix` or just the project. */
export function placeOf(candidate: RestoreCandidate): string {
    return candidate.subdir ? `${candidate.project}/${candidate.subdir}` : candidate.project;
}

/** `max-primary` / `max-primary · fable` / `keychain` / `unpinned`. */
export function accountPhrase(candidate: RestoreCandidate): string {
    if (!candidate.pinned) {
        return "unpinned";
    }

    const account = candidate.account ?? "keychain";

    return candidate.model ? `${account} · ${candidate.model}` : account;
}

function truncate(text: string, max: number): string {
    if (max <= 1) {
        return "";
    }

    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface LabelWidths {
    place: number;
    branch: number;
    account: number;
}

/** Column widths that fit the widest value in the set, so the rows line up. */
export function labelWidths(candidates: RestoreCandidate[]): LabelWidths {
    const widest = (values: string[], cap: number) => Math.min(cap, Math.max(0, ...values.map((v) => v.length)));

    return {
        place: widest(candidates.map(placeOf), 34),
        branch: widest(
            candidates.map((c) => c.branch ?? ""),
            22
        ),
        account: widest(candidates.map(accountPhrase), 26),
    };
}

/**
 * One picker row: `12m ago · GenesisTools/.worktrees/fix · feat/x · max-primary · ⚠ limit · title`.
 *
 * The identity columns are padded to a common width so the list scans vertically, and
 * the title takes whatever the terminal has left. Colour is applied after padding, so
 * the escape codes never count against the column width.
 */
export function candidateLabel(candidate: RestoreCandidate, widths: LabelWidths, columns: number): string {
    const pad = (value: string, width: number) => truncate(value, width).padEnd(width);
    const cells = [pc.cyan(pad(agePhrase(candidate.mtimeMs), 8)), pc.white(pad(placeOf(candidate), widths.place))];

    if (widths.branch > 0) {
        cells.push(pc.green(pad(candidate.branch ?? "", widths.branch)));
    }

    const account = pad(accountPhrase(candidate), widths.account);
    cells.push(candidate.pinned ? pc.magenta(account) : pc.dim(account));
    cells.push(candidate.limitStop ? pc.yellow("⚠ limit") : "       ");

    // 3 per separator, plus the prompt's own gutter, checkbox and selection marker.
    const used = cells.length * 3 + 8 + widths.place + widths.branch + widths.account + 7 + 12;
    const room = columns - used;
    const title = candidate.title?.replace(/\s+/g, " ").trim();

    if (title && room >= 16) {
        cells.push(truncate(title, room));
    }

    return cells.join(pc.dim(" · "));
}

/** The dim trailer on each row: the last thing you said in that session. */
export function candidateHint(candidate: RestoreCandidate, columns: number): string | undefined {
    const prompt = candidate.lastPrompt?.replace(/\s+/g, " ").trim();

    if (!prompt) {
        return undefined;
    }

    return truncate(prompt, Math.max(20, Math.floor(columns / 3)));
}
