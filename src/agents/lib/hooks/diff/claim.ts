import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { hookDiag } from "../log";
import { claimsRoot } from "../paths";

/**
 * One render per change, across every session on the machine.
 *
 * Several Claude sessions routinely share one repository: three of them write notes into the
 * same Obsidian vault. A command's window is the time between its own pre and post phase, so
 * a file another session writes DURING that window is dirty, is newer than the stamp, and
 * lands in this command's diff as though this command had written it. With three sessions
 * appending to sibling notes in one vault, every session ends up printing every note.
 *
 * 🛑 What this fixes and what it cannot. It guarantees one file STATE is printed at most
 * once, by whichever post phase reaches it first, in ANY session and on any later call. It cannot split a single file that two
 * sessions both wrote inside overlapping windows: the hook only ever sees a before copy and
 * an after copy, so those two sets of edits are one diff and no amount of bookkeeping
 * separates them. That case is rare (it needs two writers of the SAME file within about a
 * second) and is called out rather than papered over.
 *
 * The claim is an exclusive create (`wx`), so two post phases racing for the same state
 * cannot both win. Every failure path returns `true`: a broken ledger must never be able to
 * silence the diff.
 */
export interface ClaimKey {
    path: string;
    /** `0` for a file that is gone, which still needs its own claim. */
    mtimeMs: number;
    size: number;
}

interface ClaimRecord {
    path: string;
    mtimeMs: number;
    size: number;
    session: string;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
let ready = false;

function claimPath(key: ClaimKey): string {
    if (!ready) {
        mkdirSync(claimsRoot(), { recursive: true, mode: DIR_MODE });
        ready = true;
    }

    return join(claimsRoot(), `${Bun.hash(key.path).toString(36)}.json`);
}

function sameChange(record: ClaimRecord, key: ClaimKey): boolean {
    // The path is compared too, not just the hash: two paths CAN hash alike, and a collision
    // that silenced an unrelated file would be almost impossible to diagnose.
    return record.path === key.path && record.mtimeMs === key.mtimeMs && record.size === key.size;
}

export function claimChange(key: ClaimKey, session: string | undefined): boolean {
    if (!session) {
        return true;
    }

    const record: ClaimRecord = { ...key, session };
    const file = claimPath(key);
    const line = SafeJSON.stringify(record);

    try {
        writeFileSync(file, line, { flag: "wx", mode: FILE_MODE });
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
            hookDiag("Could not write a render claim, so the change is rendered unclaimed", { err, file });
            return true;
        }
    }

    let held: ClaimRecord;

    try {
        held = SafeJSON.parse(readFileSync(file, "utf8")) as ClaimRecord;
    } catch (err) {
        hookDiag("Could not read a render claim, so the change is rendered unclaimed", { err, file });
        return true;
    }

    if (sameChange(held, key)) {
        // 🛑 The holder's session is deliberately NOT consulted. It used to be, so a session
        // never deduped against itself, and the guarantee in this file's header held only
        // between sessions. Nothing proved that allowance: disabling it on 2026-09-21 left
        // all 83 tests green, while the one test named for it passed on the `since` filter
        // instead. An edit changes the mtime and so never lands here; the state that DOES
        // repeat is a deletion, whose key is a fixed sentinel.
        return false;
    }

    try {
        // A claim for an OLDER state of this path, or a hash collision. Either way this is a
        // change nobody has printed, so it is taken over.
        writeFileSync(file, line, { mode: FILE_MODE });
    } catch (err) {
        hookDiag("Could not take over a stale render claim", { err, file });
    }

    return true;
}
