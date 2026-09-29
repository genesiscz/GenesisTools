/**
 * The `play run` loop: attach to the user's logged-in browser over CDP, grab the web
 * player's own playerAPI, then sample every planned track across its windows, journaling
 * progress after each one so a killed run resumes where it stopped.
 *
 * Ported from the mcp-scripting `spotifyPreview` script. Every payload runs in ONE tab,
 * addressed by its CDP target id, so the user switching tabs mid-run no longer redirects
 * the calls. (Under chrome-devtools-mcp it did: the selected page followed the user, and a
 * tab switch read exactly like "the player died" and once cost a 175-track run.) The lesson
 * that still applies: losing the playerAPI handle usually means the tab changed (closed,
 * reloaded, replaced), not that Spotify died, so the tab is re-probed and re-found before
 * the destructive fallback of reopening the URL.
 */

import { cdpPortOf } from "@app/chrome-devtools/lib/cdp";
import { createTabDriver, type TabDriver } from "@app/chrome-devtools/lib/tab-driver";
import { SPOTIFY_HOST, SpotifyTab } from "@app/spotify/lib/browser/session";
import { appendJournal, progressFor, writeState } from "@app/spotify/lib/play/journal";
import {
    FIND_PLAYER,
    LOAD_QUEUE,
    PayloadStatusSchema,
    PLAY_ONE,
    parsePayload,
    previewValue,
    SAMPLE,
    SET_VOLUME,
    SKIP_NEXT,
    VolumeResultSchema,
} from "@app/spotify/lib/play/payloads";
import { loadTracks, type PlayTrack, type PlayWindow } from "@app/spotify/lib/play/plan";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "spotify:play" });

export interface RunPreviewOptions {
    tracksFile: string;
    /** Sample windows applied to tracks that carry no per-track override. */
    windows: PlayWindow[];
    queue: boolean;
    betweenMs: number;
    /** First and last track index, inclusive. */
    start: number;
    end?: number;
    /** Skip tracks the journal already marks ok for this tracks file. */
    resume: boolean;
    /** CDP endpoint of the logged-in browser. */
    browserUrl: string;
    /**
     * Player volume for the run, 0..1. Set BEFORE the first track and restored afterwards,
     * so previewing while watching something else does not mean blasting audio.
     */
    volume?: number;
    /** One human-readable progress line per event, already elapsed-stamped. */
    onLog: (line: string) => void;
    /**
     * The browser's tabs. Defaults to a CDP driver on `browserUrl`'s port, closed when the run
     * ends; a passed-in driver belongs to the caller. The tests pass a fake so the run loop —
     * queueing, skipping, sampling, resuming, and the recovery paths — can be exercised without
     * a browser or a Spotify account. Those 250 lines were otherwise reachable only by hand.
     */
    driver?: TabDriver;
}

export interface RunPreviewResult {
    total: number;
    ok: number;
    failed: string[];
    aborted: boolean;
}

/**
 * How long SAMPLE may run: each window can be tried twice with about 1.3 s of seeking and
 * settling around it, and playback gets up to 9 s to start first. A deadline that ignored
 * the windows would cut a long sample off and report a healthy track as failed.
 */
export function sampleDeadlineMs(windows: PlayWindow[]): number {
    const windowSeconds = windows.reduce((sum, [, duration]) => sum + (duration + 3) * 2, 0);

    return (windowSeconds + 15) * 1000;
}

export interface EmptyRangeInput {
    start: number;
    end: number;
    total: number;
    skipped: number;
}

/** Why the selection came out empty, in the user's terms rather than the loop's. */
export function emptyReason({ start, end, total, skipped }: EmptyRangeInput): string {
    if (!total) {
        return "the tracks file is empty";
    }

    // Checked BEFORE the inverted-range case on purpose. `--end` defaults to the last index, so
    // a bare `--start 5` on a two-track file would otherwise report "after --end 1", which is
    // true but compares against a number the user never typed. Naming the file's size is the
    // fact they need, and when start IS within the file an inverted range is the real problem.
    if (start > total - 1) {
        return `--start ${start} is past the last track (${total} in the file, so 0-${total - 1})`;
    }

    if (start > end) {
        return `--start ${start} is after --end ${end}`;
    }

    if (skipped >= total) {
        return `--resume skipped all ${total}; use --restart to play them again`;
    }

    return `nothing in ${start}-${end} is left to play`;
}

export async function runPreview(opts: RunPreviewOptions): Promise<RunPreviewResult> {
    const t0 = Date.now();
    const say = (m: string) => opts.onLog(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);

    const tracks = loadTracks(opts.tracksFile);
    const skip = opts.resume ? progressFor(opts.tracksFile).okIndexes : new Set<number>();
    const end = opts.end ?? tracks.length - 1;
    const queue = tracks.map((t, i) => ({ ...t, i })).filter((t) => t.i >= opts.start && t.i <= end && !skip.has(t.i));

    say(`tracks : ${opts.tracksFile}`);
    say(
        `config : windows ${opts.windows.map(([s, d]) => `${s}s+${d}s`).join(", ")} · ` +
            `${opts.queue ? "queued" : "standalone"} · ${queue.length}/${tracks.length} track(s)` +
            (skip.size ? ` (resumed, ${skip.size} already done)` : "")
    );
    log.info({ tracksFile: opts.tracksFile, browserUrl: opts.browserUrl, count: queue.length }, "play run starting");

    if (!queue.length) {
        // "nothing to do" on its own reads like success, and a mistyped range is the most
        // likely way to get here: `--start 5 --end 2` selects nothing, and so does `--start 5`
        // on a three-track list. Saying only that the queue is empty leaves the user to guess
        // whether the plan is wrong, the resume journal ate everything, or the flags did.
        say(`nothing to do — ${emptyReason({ start: opts.start, end, total: tracks.length, skipped: skip.size })}`);

        return { total: 0, ok: 0, failed: [], aborted: false };
    }

    const driver = opts.driver ?? createTabDriver(cdpPortOf(opts.browserUrl));

    try {
        // The SHARED tab handling, not a second copy: this file had its own finder that
        // took the first Spotify tab by URL, so a browser with a stale signed-out tab open
        // (one this tool had itself opened earlier) was driven instead of the live player.
        const tab = new SpotifyTab(driver);

        // A page error or a closed tab rejects; turning it into a failed status lets the
        // loop's own failure handling (journal, recovery ladder) run instead of the run dying.
        const call = async (source: string, deadlineMs?: number): Promise<unknown> => {
            try {
                return await tab.evaluate(source, { deadlineMs });
            } catch (error) {
                log.debug({ error, tabId: tab.id }, "a player payload failed in the page");

                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        };
        const status = async (source: string, deadlineMs?: number) =>
            parsePayload(PayloadStatusSchema, await call(source, deadlineMs));
        const findPlayer = () => status(FIND_PLAYER);

        if (await tab.pin({ rescan: true })) {
            say(`page   : pinned tab ${tab.id} (${SPOTIFY_HOST})`);
        }

        let found = await findPlayer();

        if (!found?.ok) {
            say(`playerAPI not reachable (${found?.error ?? "?"}) — opening Spotify`);
            await tab.open();
            found = await findPlayer();

            if (!found?.ok) {
                say(`FATAL: ${found?.error ?? "playerAPI unreachable"}`);

                return { total: queue.length, ok: 0, failed: [], aborted: true };
            }
        }

        say(`player : ready${found.cached ? " (cached handle)" : ""}`);

        // Before the queue loads, because loading it starts playback immediately.
        let restoreVolume: number | null = null;
        if (opts.volume !== undefined) {
            const set = parsePayload(VolumeResultSchema, await call(SET_VOLUME(opts.volume)));

            if (!set?.ok) {
                // Proceeding here means playing at whatever the volume already was, which is
                // the exact surprise asking for a volume is meant to prevent.
                say(`FATAL: could not set the volume — ${set?.error ?? "?"}`);

                return { total: queue.length, ok: 0, failed: [], aborted: true };
            }

            restoreVolume = typeof set.before === "number" ? set.before : null;
            // The ACTUAL value, not the requested one. The slider snaps to its step, so
            // asking for 1% lands on 0% or 10%, and printing the request would repeat the
            // original mistake in a quieter form.
            const actual = typeof set.after === "number" ? set.after : opts.volume;
            say(
                `volume : ${Math.round(actual * 100)}%` +
                    (Math.abs(actual - opts.volume) > 0.001
                        ? ` (asked ${Math.round(opts.volume * 100)}%, slider steps)`
                        : "") +
                    (restoreVolume === null ? "" : ` · was ${Math.round(restoreVolume * 100)}%, restored after`)
            );
        }

        if (opts.queue) {
            const loaded = await status(
                LOAD_QUEUE(
                    queue.map((t) => t.uri),
                    0
                )
            );

            if (!loaded?.ok) {
                say(`FATAL: could not load queue — ${loaded?.error ?? "?"}`);

                return { total: queue.length, ok: 0, failed: [], aborted: true };
            }

            say(`queue  : ${loaded.queued} track(s) loaded — Spotify's next/previous now walk this list`);
        }

        let ok = 0;
        const failed: string[] = [];
        let aborted = false;

        const journal = (t: PlayTrack & { i: number }, status: "ok" | "fail", heard: string) => {
            appendJournal({
                ts: new Date().toISOString(),
                tracksFile: opts.tracksFile,
                index: t.i,
                uri: t.uri,
                name: t.name ?? t.uri,
                status,
                heard,
            });
        };

        for (const [n, t] of queue.entries()) {
            const name = t.name ?? t.uri;
            say(`[${t.i}] ▶ ${name}${t.artists ? ` — ${t.artists}` : ""}`);

            if (opts.queue) {
                // already positioned on track 0; step forward for each subsequent one
                if (n > 0) {
                    const rawSkip = await call(SKIP_NEXT);
                    const skipped = parsePayload(PayloadStatusSchema, rawSkip);

                    if (!skipped?.ok) {
                        // never hide the real output behind a generic message
                        const detail = skipped?.error ?? `unparsable: ${previewValue(rawSkip)}`;
                        say(`       ✗ skipToNext — ${detail}`);
                        failed.push(`${t.i} ${name}: ${detail}`);
                        // Journalled like every other failure. Without this, a queued run's
                        // state.json counted the failure while `play status` (which reads the
                        // journal) reported none, and `--resume` would retry it silently.
                        journal(t, "fail", detail);
                        continue;
                    }
                }
            } else {
                const started = await status(PLAY_ONE(t.uri));

                if (!started?.ok) {
                    say(`       ✗ ${started?.error ?? "play failed"}`);
                    failed.push(`${t.i} ${name}: ${started?.error ?? "play failed"}`);
                    journal(t, "fail", started?.error ?? "play failed");
                    continue;
                }
            }

            const windows = t.windows?.length ? t.windows : opts.windows;
            const r = await status(SAMPLE(windows), sampleDeadlineMs(windows));

            if (r?.ok) {
                ok++;
                const heard = (r.heard ?? []).join("  ");
                say(`       ✓ ${heard}  (${r.track})${r.missed ? `   ! ${r.missed} window(s) MISSED` : ""}`);
                journal(t, "ok", heard);
            } else {
                const err = r?.error ?? "unparsable result";
                say(`       ✗ ${err}`);
                failed.push(`${t.i} ${name}: ${err}`);
                journal(t, "fail", err);
                let re = await findPlayer();

                // Losing the handle usually means the tab changed (closed, reloaded, replaced),
                // not that Spotify died. Re-find the tab before assuming the worst — another live
                // player keeps the queue and playback position, which reopening would destroy.
                if (!re?.ok && (await tab.pin({ rescan: true }))) {
                    say(`       tab changed, re-found tab ${tab.id}`);
                    re = await findPlayer();
                }

                // Only when no Spotify tab exists at all is a reopen justified. That loses the
                // queue, so rebuild it from the tracks still ahead of this one.
                if (!re?.ok) {
                    say("       no Spotify tab — reopening");
                    await tab.open();
                    re = await findPlayer();

                    if (re?.ok && opts.queue) {
                        const rest = queue.slice(queue.findIndex((q) => q.i === t.i) + 1).map((q) => q.uri);

                        if (rest.length) {
                            await status(LOAD_QUEUE(rest, 0));
                            say(`       queue  : ${rest.length} remaining track(s) reloaded`);
                        }
                    }
                }

                if (!re?.ok) {
                    say("       playerAPI still unreachable, aborting");
                    aborted = true;
                    break;
                }
            }

            writeState({
                tracksFile: opts.tracksFile,
                windows: opts.windows,
                queue: opts.queue,
                total: queue.length,
                done: ok,
                failed: failed.length,
                lastIndex: t.i,
                lastTrack: name,
                nextIndex: queue[n + 1]?.i ?? null,
                status: n + 1 < queue.length ? "running" : "finished",
            });

            await Bun.sleep(opts.betweenMs);
        }

        // The per-track write above leaves status "running"; a break out of the loop has to
        // correct that, otherwise a killed run looks like it is still going.
        const settled = ok + failed.length;
        const lastDone = queue[settled - 1];
        writeState({
            tracksFile: opts.tracksFile,
            windows: opts.windows,
            queue: opts.queue,
            total: queue.length,
            done: ok,
            failed: failed.length,
            lastIndex: lastDone?.i ?? null,
            lastTrack: lastDone?.name ?? lastDone?.uri ?? null,
            nextIndex: queue[settled]?.i ?? null,
            status: settled >= queue.length ? "finished" : "aborted",
        });

        if (restoreVolume !== null) {
            await call(SET_VOLUME(restoreVolume));
            say(`volume : restored to ${Math.round(restoreVolume * 100)}%`);
        }

        say(`done: ${ok}/${queue.length} previewed`);

        if (failed.length) {
            say(`failures (${failed.length}):`);
            for (const f of failed) {
                say(`  - ${f}`);
            }
        }

        log.info({ ok, failed: failed.length, aborted }, "play run finished");

        return { total: queue.length, ok, failed, aborted };
    } finally {
        if (!opts.driver) {
            driver.close();
        }
    }
}
