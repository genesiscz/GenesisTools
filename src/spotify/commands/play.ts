/**
 * `tools spotify play` — hear the library instead of reading about it.
 *
 * `plan` sets the sample windows and tracks file once; `run` drives the web player's own
 * playerAPI through them (queue, seek, resume journal); `status` answers "where was I";
 * `harvest` is the same library-download guide as the top-level pipeline command, here
 * because downloading the library is how a tracks file comes to exist.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { common, describeOption, emit, limitOf } from "@app/spotify/commands/_shared";
import { type CommonOpts, numberOption } from "@app/spotify/lib/context";
import { playDir } from "@app/spotify/lib/paths";
import { runPreview } from "@app/spotify/lib/play/driver";
import { clearJournal, progressFor, statePath } from "@app/spotify/lib/play/journal";
import {
    DEFAULT_PLAN,
    findPlan,
    listPlans,
    loadPlan,
    loadTracks,
    newestPlan,
    type PlayPlan,
    type PlayTrack,
    type PlayWindow,
    parseWindows,
    planPath,
    removePlan,
    safePlanName,
    savePlan,
    writePlan,
} from "@app/spotify/lib/play/plan";
import { parseSeedSource, SEED_HELP, SEED_SOURCES, seedTracks } from "@app/spotify/lib/play/seed";
import { renderHarvestGuide } from "@app/spotify/render/pipeline";
import { ui } from "@genesiscz/utils/cli/ui";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

interface WindowFlags {
    windows?: string;
    seek?: string;
    play?: string;
}

/** `--windows` wins; `--seek`/`--play` are the single-window shorthand (defaults 10s/10s). */
function windowsFromFlags(o: WindowFlags): PlayWindow[] | undefined {
    if (o.windows) {
        return parseWindows(o.windows);
    }

    if (o.seek !== undefined || o.play !== undefined) {
        return [
            [
                numberOption(o.seek, "seek", 10, { min: 0, integer: false }),
                numberOption(o.play, "play", 10, { min: 1, integer: false }),
            ],
        ];
    }

    return undefined;
}

function queueFromFlags(o: { queue?: boolean }): boolean | undefined {
    // commander turns --queue/--no-queue into one boolean; undefined means neither was passed
    return o.queue;
}

/**
 * Seeded tracks go beside the plan, not into it: the plan stays a small readable settings
 * file, and the track list is an ordinary JSON array the user can edit, re-point or share.
 */
function writeSeedFile(name: string, tracks: PlayTrack[]): string {
    const path = join(playDir(), `${new Date().toISOString().slice(0, 10)}-${name}.tracks.json`);
    mkdirSync(playDir(), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify(tracks, null, 2)}\n`);

    return path;
}

function showPlan(plan: PlayPlan): void {
    ui.header("playback plan");
    ui.kv("windows", plan.windows.map(([s, d]) => `${s}s+${d}s`).join(", "));
    ui.kv("queue", plan.queue ? "yes — next/previous walk the run" : "no — each track plays standalone");
    ui.kv("between", `${plan.betweenMs}ms`);

    if (plan.tracks) {
        let detail = plan.tracks;

        if (existsSync(plan.tracks)) {
            const tracks = loadTracks(plan.tracks);
            const overrides = tracks.filter((t) => t.windows?.length).length;
            detail += ` (${tracks.length} tracks${overrides ? `, ${overrides} with own windows` : ""})`;
            const progress = progressFor(plan.tracks);

            if (progress.entries.length) {
                detail += ` · ${progress.okIndexes.size} done, ${progress.failed} failed`;
            }
        } else {
            detail += pc.red(" (missing)");
        }

        ui.kv("tracks", detail);
    } else {
        ui.kv("tracks", pc.dim("unset — pass --tracks <file> here or on `play run`"));
    }

    ui.dim(`  plan     ${planPath()}`);
}

const log = logger.child({ component: "spotify:play" });

/**
 * The TRACKS cell for one row of `plan list`, which must never take the whole listing down.
 *
 * `loadTracks` throws on anything it cannot parse, and this ran inside the render loop, so a
 * single plan pointing at an empty or truncated tracks file made `plan list` fail outright
 * with `JSON Parse error: Unexpected EOF` and no indication of WHICH plan was at fault. The
 * one command a person uses to find their way out of a broken plan was the one the broken plan
 * disabled. A bad file is now just a red cell on its own row.
 */
function trackCountCell(tracks: string | undefined): string {
    if (!tracks || !existsSync(tracks)) {
        return pc.red("missing");
    }

    try {
        return String(loadTracks(tracks).length);
    } catch (error) {
        log.debug({ error, tracks }, "unreadable tracks file while listing plans");

        return pc.red("unreadable");
    }
}

export function registerPlay(program: Command): void {
    const play = program
        .command("play")
        .description("preview tracks through the web player itself — plan, run, resume");

    const planCmd = play.command("plan").description("playback plans: create one, list them, change one");

    describeOption(
        common(
            planCmd
                .command("new <name>")
                .description("create a plan and fill it with tracks — no JSON to write by hand")
                .option(
                    "--from <source>",
                    `which tracks to seed — ${SEED_SOURCES.map((s) => `${s}: ${SEED_HELP[s]}`).join("; ")}`,
                    "top"
                )
                .option("--windows <spec>", "sample windows as start:duration pairs, e.g. 10:3,20:3,30:3")
                .option("--seek <sec>", "start of a SINGLE window; replaces --windows (default 10)")
                .option("--play <sec>", "duration of that single window; replaces --windows (default 10)")
                .option("--tracks <path>", "use an existing tracks file instead of seeding one")
                .option("--quiet-months <n>", "for --from forgotten: months of silence that count as forgotten", "12")
                .option("--between <ms>", "pause between tracks")
                .option("--no-queue", "play each track standalone instead of queueing the run")
                .option("--note <text>", "a reminder of what this plan is for")
        ),
        "--top",
        "how many tracks to seed into the plan (default 30)"
    ).action(
        (
            name: string,
            o: CommonOpts &
                WindowFlags & {
                    from?: string;
                    tracks?: string;
                    quietMonths?: string;
                    between?: string;
                    queue?: boolean;
                    note?: string;
                }
        ) => {
            const safe = safePlanName(name);

            if (findPlan(safe)) {
                throw new Error(
                    `a plan named "${safe}" already exists. Change it with ` +
                        `\`tools spotify play plan set --plan ${safe} …\`, ` +
                        `or remove it: \`tools spotify play plan rm ${safe}\``
                );
            }

            const windows = windowsFromFlags(o) ?? DEFAULT_PLAN.windows;
            const limit = limitOf(o, 30);
            let tracksPath = o.tracks;
            let seeded = 0;

            if (!tracksPath) {
                const source = parseSeedSource(o.from);
                const tracks = seedTracks({
                    source,
                    limit,
                    options: o,
                    quietMonths: numberOption(o.quietMonths, "quiet-months", 12, { min: 0, integer: true }),
                });

                if (!tracks.length) {
                    throw new Error(
                        `--from ${source} selected no tracks. Widen the window, or try another source: ` +
                            SEED_SOURCES.join(" | ")
                    );
                }

                tracksPath = writeSeedFile(safe, tracks);
                seeded = tracks.length;
            }

            const created = writePlan(safe, {
                windows,
                queue: queueFromFlags(o) ?? DEFAULT_PLAN.queue,
                tracks: tracksPath,
                betweenMs: numberOption(o.between, "between", DEFAULT_PLAN.betweenMs, { min: 0, integer: true }),
                note: o.note ?? (seeded ? `${seeded} × ${parseSeedSource(o.from)}` : undefined),
            });

            // The newest plan is the one `play run` uses, and this one is newest by construction.
            const isDefaultNow = newestPlan()?.name === created.name;

            emit(o.json, { ...created, seeded, isDefaultNow }, (r) => {
                ui.ok(`plan "${r.name}" created`);

                if (seeded) {
                    ui.kv("tracks", `${seeded} seeded → ${r.plan.tracks}`);
                }

                showPlan(r.plan);
                // Always names the plan, even when it is currently the newest. The old message
                // promised "`play run` will use it", which is true only until something else
                // touches another plan: "newest" is most-recently-written, so EDITING an older
                // plan makes it newest again. A tester created a plan, saw that promise, and
                // then watched a different plan hold the newest marker. Naming the plan is
                // advice that stays true.
                ui.dim(`  next     tools spotify play run --plan ${r.name}`);
            });
        }
    );

    planCmd
        .command("list")
        .description("every plan, newest first")
        .option("--json", "machine-readable output")
        .action((o: { json?: boolean }) => {
            const plans = listPlans();

            emit(o.json, plans, (rows) => {
                if (!rows.length) {
                    ui.info("no plans yet");
                    ui.dim("  tools spotify play plan new gems --from gems --top 30 --seek 30 --play 20");

                    return;
                }

                renderCliHeader("Playback plans", playDir());
                const table = createBoxTable(["", "NAME", "CREATED", "TRACKS", "WINDOWS", "NOTE"]);
                for (const [i, p] of rows.entries()) {
                    table.push([
                        i === 0 ? formatDotStatus("ok", "") : "",
                        pc.white(p.name),
                        p.date,
                        trackCountCell(p.plan.tracks),
                        p.plan.windows.map(([s, d]) => `${s}:${d}`).join(","),
                        truncateDisplay(p.plan.note ?? "", 28),
                    ]);
                }

                out.println(table.toString());
                ui.dim("  ● = the newest, which `play run` uses · pick another with `play run --plan <name>`");
            });
        });

    planCmd
        .command("rm <name>")
        .alias("remove")
        .description("delete a plan (and the track list this tool seeded for it)")
        .option("--json", "machine-readable output")
        .action((name: string, o: { json?: boolean }) => {
            const removed = removePlan(name);

            emit(o.json, removed, (r) => {
                ui.ok(`removed plan "${r.name}"`);
                ui.dim(`  ${r.path}`);

                if (r.tracks) {
                    ui.dim(`  ${r.tracks}`);
                } else {
                    // Saying so out loud, because the alternative reading is that the tool
                    // deleted a curated track list the user pointed the plan at.
                    ui.dim("  its tracks file was not seeded by this tool, so it was left alone");
                }
            });
        });

    planCmd
        .command("set", { isDefault: true })
        // Deliberately says "newest", not "active". There is no active-plan pointer by design
        // (see the header of lib/play/plan.ts), so calling it active invites the reader to go
        // looking for the command that sets it. `play run` picks the newest by the same rule.
        //
        // The wording spells out that a bare call only READS, because "any flag updates it"
        // plus "--plan <name>" in the same breath gave no way to tell whether `--plan foo`
        // alone was safe to run out of curiosity. A tester ran it expecting a read-only view,
        // then spent real effort deciding whether it had rewritten someone else's plan.
        .description("show a plan; only --windows/--seek/--play/--tracks/--queue/--between change it")
        .option("--plan <name>", "which plan to show or change (default: the newest); alone, it only shows")
        .option("--windows <spec>", "sample windows as start:duration pairs, e.g. 10:3,20:3,30:3")
        .option("--seek <sec>", "single-window start (shorthand for --windows <sec>:<play>)")
        .option("--play <sec>", "single-window duration")
        .option("--tracks <path>", "JSON: [{uri, name?, artists?, windows?}] or {all: [...]}")
        .option("--queue", "load the whole run into the player queue (default)")
        .option("--no-queue", "play each track standalone instead")
        .option("--between <ms>", "pause between tracks")
        .option("--json", "machine-readable output")
        .action(
            (
                o: WindowFlags & {
                    plan?: string;
                    tracks?: string;
                    queue?: boolean;
                    between?: string;
                    json?: boolean;
                }
            ) => {
                const target = o.plan ? findPlan(o.plan) : newestPlan();

                if (o.plan && !target) {
                    throw new Error(`no plan named "${o.plan}". List them: tools spotify play plan list`);
                }

                const current = target?.plan ?? { ...DEFAULT_PLAN };
                const windows = windowsFromFlags(o);
                const queue = queueFromFlags(o);
                const touched =
                    windows !== undefined || queue !== undefined || o.tracks !== undefined || o.between !== undefined;

                const next: PlayPlan = {
                    windows: windows ?? current.windows,
                    queue: queue ?? current.queue,
                    tracks: o.tracks ?? current.tracks,
                    betweenMs: numberOption(o.between, "between", current.betweenMs, { min: 0, integer: true }),
                    note: current.note,
                };

                let path = target?.path;
                if (touched) {
                    path = target ? writePlan(target.name, next, target.date).path : savePlan(next);
                }

                emit(o.json, { ...next, name: target?.name ?? "default", path, saved: touched }, (p) => {
                    if (touched) {
                        ui.ok(`plan "${target?.name ?? "default"}" updated`);
                    }

                    showPlan(p);
                });
            }
        );

    play.command("harvest")
        .description("how to download the library out of a logged-in browser tab")
        .action(() => {
            renderHarvestGuide();
        });

    play.command("run")
        .description("play each planned track across its sample windows, journaling progress")
        .option("--plan <name>", "which plan to run (default: the newest)")
        .option("--tracks <path>", "tracks JSON (default: the plan's)")
        .option("--windows <spec>", "sample windows, e.g. 10:3,20:3,30:3 (default: the plan's)")
        .option("--seek <sec>", "single-window start")
        .option("--play <sec>", "single-window duration")
        .option("--queue", "load all tracks into the player queue (default: the plan's)")
        .option("--no-queue", "play each track standalone")
        .option("--start <i>", "first index, inclusive", "0")
        .option("--end <i>", "last index, inclusive")
        .option("--resume", "skip tracks already completed for this tracks file")
        .option("--restart", "wipe this tracks file's progress, then run")
        .option("--between <ms>", "pause between tracks (default: the plan's)")
        .option("--browser-url <url>", "CDP endpoint of the logged-in browser")
        .option("--volume <percent>", "player volume for the run, 0-100; restored afterwards")
        .action(
            async (
                o: WindowFlags & {
                    plan?: string;
                    tracks?: string;
                    queue?: boolean;
                    start: string;
                    end?: string;
                    resume?: boolean;
                    restart?: boolean;
                    between?: string;
                    browserUrl?: string;
                    volume?: string;
                }
            ) => {
                const plan = loadPlan(o.plan);
                const tracksFile = o.tracks ?? plan.tracks;

                if (!tracksFile) {
                    throw new Error(
                        "no tracks file. Pass --tracks <file>, or set one: tools spotify play plan --tracks <file>"
                    );
                }

                if (o.restart) {
                    const cleared = clearJournal(tracksFile);
                    ui.info(`restart: cleared ${cleared} progress entr(ies) for this tracks file`);
                }

                const result = await runPreview({
                    tracksFile,
                    windows: windowsFromFlags(o) ?? plan.windows,
                    queue: queueFromFlags(o) ?? plan.queue,
                    betweenMs: numberOption(o.between, "between", plan.betweenMs, { min: 0, integer: true }),
                    start: numberOption(o.start, "start", 0, { min: 0, integer: true }),
                    end: o.end === undefined ? undefined : numberOption(o.end, "end", 0, { min: 0, integer: true }),
                    resume: Boolean(o.resume) && !o.restart,
                    browserUrl: o.browserUrl ?? env.spotify.getBrowserUrl() ?? "http://127.0.0.1:9222",
                    volume:
                        o.volume === undefined
                            ? undefined
                            : numberOption(o.volume, "volume", 100, { min: 0, max: 100, integer: false }) / 100,
                    onLog: (line) => ui.raw(line),
                });

                ui.dim(`  state    ${statePath()} (play status to inspect, --resume to continue)`);

                // A run that finished but could not play some tracks is not a success. Exiting
                // 0 on it told any script that the preview was complete when it was not.
                if (result.aborted || result.failed.length > 0) {
                    process.exitCode = 1;
                }
            }
        );

    play.command("status")
        .description("progress for a plan or tracks file — done, failed, where to resume")
        // `--plan` is here because `run` and `plan set` both take it, and a user who has just
        // created a plan by name reaches for the same flag to check on it. Without it the only
        // way in was the tracks-file path, which nothing tells you unless you go back and
        // re-read the output of `plan set`. The mismatch surfaced only as `unknown option`.
        .option("--plan <name>", "which plan to report on (default: the newest)")
        .option("--tracks <path>", "tracks JSON (default: the plan's)")
        .option("--json", "machine-readable output")
        .action((o: { plan?: string; tracks?: string; json?: boolean }) => {
            const plan = loadPlan(o.plan);
            const tracksFile = o.tracks ?? plan.tracks;

            if (!tracksFile) {
                throw new Error(
                    "no tracks file. Pass --tracks <file>, or set one: tools spotify play plan --tracks <file>"
                );
            }

            const progress = progressFor(tracksFile);
            const total = existsSync(tracksFile) ? loadTracks(tracksFile).length : null;
            const remaining =
                total === null
                    ? null
                    : Array.from({ length: total }, (_, i) => i).filter((i) => !progress.okIndexes.has(i));

            emit(
                o.json,
                {
                    tracksFile,
                    journalled: progress.entries.length,
                    ok: progress.okIndexes.size,
                    failed: progress.failed,
                    total,
                    remaining: remaining?.length ?? null,
                    nextIndex: remaining?.[0] ?? null,
                    last: progress.last ?? null,
                },
                (s) => {
                    ui.header("play progress");
                    ui.kv("tracks", s.tracksFile);
                    ui.kv("journal", `${s.journalled} entr(ies), ${s.ok} ok, ${s.failed} failed`);

                    if (s.last) {
                        ui.kv(
                            "last",
                            `[${s.last.index}] ${s.last.name} — ${s.last.status} ${s.last.heard ?? ""} @ ${s.last.ts}`
                        );
                    }

                    if (s.total === null) {
                        ui.warn("tracks file missing — remaining count unknown");
                    } else {
                        ui.kv(
                            "remaining",
                            `${s.remaining}${s.remaining ? ` → resume at index ${s.nextIndex}` : " (all done)"}`
                        );
                    }

                    if (s.remaining) {
                        ui.dim(`  next     tools spotify play run --tracks ${s.tracksFile} --resume`);
                    }
                }
            );
        });
}
