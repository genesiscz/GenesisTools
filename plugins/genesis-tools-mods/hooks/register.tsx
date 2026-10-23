import type {
    ElementTable,
    EngineInterface,
    HookStream,
    Register,
    RenderElement,
    Timer,
    TurnStepChunk,
    TurnStepResult,
} from "claude-code";
import { atom, read, update } from "claude-code";
import type { FlippedFiles, ShownCalls } from "../types";
import { agentModelStep, spawnWithModel } from "./agent-model";
import { agentsBand, agentsRow, noteTranscript, recordSpawn } from "./agents-band";
import { askOnRow } from "./ask-row";
import { bandTree } from "./band";
import { cacheBand, cacheRow, markEnded } from "./cache-band";
import { decisions } from "./decisions";
import { primeGenesisProbe } from "./genesis";
import { gitBand, gitRows } from "./git-band";
import { hookLedger, hooksChip, hooksChipWidth, ledgerClassic } from "./hook-ledger";
import { compactionEndsIdleWait, idleCompactSettings, idleCompactSkip, idleNotice, setIdleDueAt } from "./idle";
import { linksStep, rememberToolPaths } from "./links";
import { startLiveClock } from "./live";
import {
    type CallSection,
    collapseGitSyncEnabled,
    commandOf,
    fullDiffEnabled,
    gitSyncOf,
    isDeletion,
    openByDefault,
    sectionsOfCalls,
} from "./sections";
import { agentsDir, type Feature, type Host, readHooksFile, settingsOf } from "./shared";
import { focusOf, forgetFocus, noteFocus } from "./sidebar";
import { progressSuffix, spinner } from "./spinner";
import { clearStall, noteStop, stallCatcher, stallRow } from "./stall";
import { tmpRow, tmpUsage } from "./tmp-usage";

// The full-diff mod. When the diff hook (`tools agents hooks`) cut a Bash call's message, it wrote the
// whole diff to ~/.genesis-tools/agents/hook-diffs/<tool_use_id>.md. This draws those hunks with Claude
// Code's own Code element under the call's row, so the colours, the gutters and the wrapping are the
// engine's and nothing counts against the 10,000-character hook message.
//
// 🛑 Two rows, two hooks. Outside `--verbose` and the ctrl+o transcript the engine draws a group of calls
// as ONE `ToolGroup` line ("ran 3 shell commands") and no `ToolUse` row at all (`ToolGroup.isExpanded`
// in the engine types), so the diffs go under that line. An expanded group draws each call as its own
// `ToolUse` row, and the diff goes under the call. A spike that hooked only `ToolResult`, then only
// `ToolUse`, drew nothing in the normal view (checked on screen 2026-10-15).

// One drawing may hold 100,000 characters in all (CodeProps.source); stay well inside it.
const MAX_CHARS = 60_000;

interface Diffs {
    sections: CallSection[];
    /** The calls that run a git sync (`git pull`, …), each with that command, while `mods.diff.collapseGitSync` is on. */
    syncs: Map<string, string>;
    /** The notes of the calls past `MAX_CHARS` (`sectionsOfCalls`), named under the diffs so none goes without a trace. */
    omitted: string[];
}

/**
 * A call's diff note never changes once the diff hook wrote it, and a tool row draws again on every redraw (the live
 * clock's included), so a note read once is kept; a missing one is asked for again. The hooks file is read at most
 * every 5 seconds.
 */
const noteText = new Map<string, string>();
const NOTES_KEPT = 80;
let hooksFileHeld: { at: number; dir: string; text: string | undefined } | undefined;

async function hooksFileOf(host: Host, dir: string): Promise<string | undefined> {
    const held = hooksFileHeld;

    if (held && held.dir === dir && Date.now() - held.at < 5_000) {
        return held.text;
    }

    const text = await readHooksFile(host, dir);
    hooksFileHeld = { at: Date.now(), dir, text };

    return text;
}

async function fullDiffs($: EngineInterface, calls: readonly { id: string; input: unknown }[]): Promise<Diffs> {
    const none: Diffs = { sections: [], syncs: new Map(), omitted: [] };
    const host = hostOf($);
    const dir = calls.length > 0 ? await agentsDir(host) : undefined;

    if (!dir) {
        return none;
    }

    const hooksFile = await hooksFileOf(host, dir);

    if (!fullDiffEnabled(hooksFile)) {
        return none;
    }

    const ids = calls.map((call) => call.id);
    const note = (id: string) => `${dir}/hook-diffs/${id}.md`;
    const { sections, omitted } = await sectionsOfCalls({
        ids,
        read: async (id) => {
            const held = noteText.get(id);

            if (held !== undefined) {
                return held;
            }

            const text = await $.fs.read(note(id));
            noteText.set(id, text);

            // The rows on screen are a few dozen; the oldest note goes first.
            if (noteText.size > NOTES_KEPT) {
                noteText.delete(noteText.keys().next().value ?? id);
            }

            return text;
        },
        maxChars: MAX_CHARS,
    });
    const syncs = new Map<string, string>();

    if (collapseGitSyncEnabled(hooksFile)) {
        for (const call of calls) {
            const sync = gitSyncOf(commandOf(call.input));

            if (sync !== undefined) {
                syncs.set(call.id, sync);
            }
        }
    }

    return { sections, syncs, omitted: omitted.map(note) };
}

// The idle-compaction mod. Claude Code's own idle compaction fires once, 54 minutes after the last
// request, and gives up at the first gate that refuses (`near_limit` refuses while the account's last reply
// carried a rate-limit warning, even after the window reset). Then the 1-hour cache expires and the next
// prompt pays for the whole context again. This timer compacts at `mods.idleCompact.minutes` (56) after the
// last main-loop turn, unless a compaction already happened. A reload of the mod drops the timer; the next
// turn arms it again.
let idleTimer: Timer | undefined;

function stopIdleTimer(): void {
    idleTimer?.cancel();
    idleTimer = undefined;
    setIdleDueAt(undefined);
}

async function compactIfIdle($: EngineInterface): Promise<void> {
    idleTimer = undefined;
    setIdleDueAt(undefined);

    // Read again at the fire time, so `config set mods.idleCompact.enabled false` stops a timer already armed.
    const host = hostOf($);
    const settings = idleCompactSettings(await readHooksFile(host, await agentsDir(host)));
    const [surfaces, usage] = await Promise.all([$.session.surfaces(), $.session.usage()]);

    if (idleCompactSkip({ settings, surfaces: surfaces.length, tokens: usage.context.tokens }) !== undefined) {
        return;
    }

    try {
        // A full compaction: only the engine's threshold path uses a ready precomputed summary, so this one
        // makes its own summary request (over the still-warm cache) and a ready precompute is dropped.
        const compacted = await $.session.compact({});

        if (compacted.skip !== undefined) {
            return;
        }

        const text = idleNotice({
            minutes: settings.minutes,
            tokensBefore: compacted.tokensBefore,
            tokensAfter: compacted.tokensAfter,
        });

        await $.session.append({ message: { type: "system", content: [{ type: "text", text }] } });
    } catch {
        // `compact` rejects while a turn runs: the person came back, and that turn arms the timer again.
    }
}

/**
 * The files the person folded or opened against their default (`openByDefault`), each as `fileKey`: its row
 * (a ToolGroup's `requestId`, or a call's `tool_use_id` in an expanded group), its call and its path. Session
 * state, so a fold survives a redraw and a reload of the mod. The newest 500 are kept.
 */
const flipped = atom({ plugin: "genesis-tools-mods", key: "flipped" } as const, [] as FlippedFiles);

function fileKey(row: string, section: CallSection): string {
    return `${row}|${section.call}|${section.path}`;
}

/** The git-sync calls whose hidden diff the person opened, as `<row>|<call>`; the newest 500. */
const shownCalls = atom({ plugin: "genesis-tools-mods", key: "shown" } as const, [] as ShownCalls);

/**
 * The full diffs under a row. The diff of a call that runs a git sync (`git pull`, …) starts hidden behind one
 * `show diff from git pull` Button, and a `hide diff from git pull` Button folds it back. Each file has its own `[-]`/`[+]` Button that folds its diff to its name and
 * back; the row's Button folds every file, or opens them all once every file is folded. A click elsewhere on the
 * drawing reaches the engine's row, which opens the group's calls (the person's "expansion in expansion").
 *
 * The inner Box's `width="100%"` stretches the diffs to the transcript's width: without it they were as wide as
 * the engine's row line, and the Code element wrapped them there. The width cannot sit on the outer Box: the
 * engine refuses a tree that puts its own row under a Box with a `width` (seen live 2026-10-18).
 */
async function drawDiffs(
    $: EngineInterface,
    ui: ElementTable,
    row: string,
    diffs: Diffs,
    drawn: RenderElement
): Promise<RenderElement> {
    const { Box, Button, Code, Text } = ui;
    const shown = new Set(await read($, shownCalls));
    const callKey = (call: string) => `${row}|${call}`;
    const isHidden = (call: string) => diffs.syncs.has(call) && !shown.has(callKey(call));
    const sections = diffs.sections.filter((section) => !isHidden(section.call));
    const hidden = [...new Set(diffs.sections.map((section) => section.call))].filter(isHidden);
    const setShown = (call: string, on: boolean) => {
        const key = callKey(call);

        void update($, shownCalls, (list) =>
            [...list.filter((item) => item !== key), ...(on ? [key] : [])].slice(-500)
        );
    };
    const flips = new Set(await read($, flipped));
    const keys = sections.map((section) => fileKey(row, section));
    const defaults = openByDefault(sections);
    const isOpen = (index: number) => (defaults[index] ?? true) !== flips.has(keys[index] ?? "");
    const isAllFolded = keys.every((_, index) => !isOpen(index));
    const totals = (of: readonly CallSection[]) => ({
        files: new Set(of.map((section) => section.path)).size,
        added: of.reduce((sum, section) => sum + section.added, 0),
        removed: of.reduce((sum, section) => sum + section.removed, 0),
    });
    const counts = ({ files, added, removed }: ReturnType<typeof totals>) => [
        <Text key="files" dimColor>
            {files} {files === 1 ? "file" : "files"}
        </Text>,
        <Text key="added" color="diffAdded">
            +{added}
        </Text>,
        <Text key="removed" color="diffRemoved">
            -{removed}
        </Text>,
    ];
    /** Opens or folds the files at `indexes`: a file is flipped exactly when that differs from its default. */
    const setOpen = (indexes: readonly number[], open: boolean) => {
        const targets = indexes.map((index) => keys[index] ?? "");
        const flip = indexes.filter((index) => open !== (defaults[index] ?? true)).map((index) => keys[index] ?? "");

        void update($, flipped, (list) => [...list.filter((key) => !targets.includes(key)), ...flip].slice(-500));
    };
    const all = keys.map((_, index) => index);

    return (
        <Box flexDirection="column">
            {drawn}
            <Box flexDirection="column" width="100%">
                {hidden.map((call) => (
                    <Box key={`${callKey(call)}:sync`} flexDirection="row" gap={1}>
                        <Button key={`${callKey(call)}:show`} dimColor onPress={() => setShown(call, true)}>
                            show diff from {diffs.syncs.get(call)}
                        </Button>
                        {counts(totals(diffs.sections.filter((section) => section.call === call)))}
                    </Box>
                ))}
                {sections.length === 0 ? null : (
                    <Box flexDirection="row" gap={1}>
                        <Button key={`${row}:fold`} dimColor onPress={() => setOpen(all, isAllFolded)}>
                            {isAllFolded ? "show diff" : "files only"}
                        </Button>
                        {counts(totals(sections))}
                    </Box>
                )}
                {sections.map((section, index) => {
                    const key = keys[index] ?? fileKey(row, section);
                    const isFolded = !isOpen(index);
                    const sync = diffs.syncs.get(section.call);
                    const isFirstOfCall = sections.findIndex((other) => other.call === section.call) === index;

                    return (
                        <Box key={key} flexDirection="column">
                            {sync !== undefined && isFirstOfCall ? (
                                <Button
                                    key={`${callKey(section.call)}:hide`}
                                    dimColor
                                    onPress={() => setShown(section.call, false)}
                                >
                                    hide diff from {sync}
                                </Button>
                            ) : null}
                            <Box flexDirection="row" gap={1}>
                                <Button key={`${key}:fold`} plain dimColor onPress={() => setOpen([index], isFolded)}>
                                    {isFolded ? "[+]" : "[-]"}
                                </Button>
                                <Text dimColor={!isFolded}>{section.path}</Text>
                                <Text color="diffAdded">+{section.added}</Text>
                                <Text color="diffRemoved">-{section.removed}</Text>
                                {isDeletion(section) ? <Text dimColor>deleted</Text> : null}
                            </Box>
                            {isFolded ? null : <Code source={section.patch} format="diff" path={section.path} />}
                        </Box>
                    );
                })}
                {diffs.omitted.map((path) => (
                    <Text key={`${row}|${path}:omitted`} dimColor>
                        past the view's budget, full diff: {path}
                    </Text>
                ))}
            </Box>
        </Box>
    );
}

/**
 * The diff hook leaves a call's diff to this mod only in a session that set `GENESIS_TOOLS_MODS_SESSION` to its own
 * id (`MODS_SESSION_VAR` in src/agents/lib/hooks/diff/run.ts; mods-plugin.test.ts keeps the two equal). The hooks of
 * the session see a mod's `env.set`, so a session that never loaded the mod keeps the hook's own diff message. The
 * engine wants the name as a literal, so it can list the variables a module writes.
 */
let announcedSession: string | undefined;

/** Marks this session as one the mod draws in; again when the id changes (a resumed or forked session). */
async function announceSession($: EngineInterface): Promise<void> {
    try {
        const id = String(await $.session.id());

        if (id !== announcedSession) {
            await $.env.set("GENESIS_TOOLS_MODS_SESSION", id);
            announcedSession = id;
        }
    } catch {
        // No mark means the hook draws the diff itself: never worse than before the mark existed.
    }
}

/** A stage's generator as a stream the next stage reads, with the `result` a `next(e)` stream carries. */
function streamOf<C, R>(stage: AsyncGenerator<C, R>): HookStream<C, R> {
    let settle: (value: R) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const result = new Promise<R>((resolve, reject) => {
        settle = resolve;
        fail = reject;
    });

    // An unread result must not surface as an unhandled rejection; a stage that reads it still sees the error.
    result.catch(() => undefined);

    async function* run(): AsyncGenerator<C, R> {
        try {
            const value = yield* stage;
            settle(value);

            return value;
        } catch (error) {
            fail(error);
            throw error;
        }
    }

    return Object.assign(run(), { result });
}

/**
 * The engine as the feature files reach it. Built here because only this file may hand `$` on (see `shared.ts`);
 * each closure spells the call it makes, so `claude plugin validate` reads every capability the plugin uses.
 */
function hostOf($: EngineInterface): Host {
    return {
        run: (argv, init) => $.process.run(argv, init),
        read: (path) => $.fs.read(path),
        write: (path, text) => $.fs.write(path, text),
        // `$.fs.write` replaces a file and the engine has no append, so this is the one place an append runs `cat >>`
        // in `sh` (making the folder first). When `$.fs` gets an append, only these lines change.
        append: async (path, text) => {
            const done = await $.process.run(
                ["/bin/sh", "-c", 'mkdir -p "$(dirname "$1")" && cat >> "$1"', "sh", path],
                {
                    stdin: text,
                    timeoutMs: 5_000,
                }
            );

            if (done.exitCode !== 0) {
                throw new Error(`append to ${path} failed (exit ${done.exitCode}): ${done.stderr.trim()}`);
            }
        },
        list: (path) => $.fs.list(path),
        exists: (path) => $.fs.exists(path),
        stat: (path) => $.fs.stat(path),
        env: (name) => (name === "HOME" ? $.env.get("HOME") : $.env.get("GENESIS_TOOLS_HOME")),
        cwd: () => $.session.cwd(),
        sessionId: () => $.session.id(),
        messages: () => $.session.messages(),
        agents: () => $.agent.list(),
        every: (ms, fn) => {
            $.clock.every(ms, fn);
        },
        storeGet: (key) => $.store.get(key),
        storeSet: (key, value) => $.store.set(key, value),
        status: (text) => $.ui.status(text),
        fill: (args) => $.prompt.fill(args),
        submit: (text) => $.prompt.submit({ text }),
        openPane: (id, title, from) => openSidebar($, id, title, from),
        togglePane: async (id, title, from) => {
            const isShown = (await $.ui.panes()).some((pane) => pane.id === id && pane.isShown);

            return isShown ? $.ui.close({ id }) : openSidebar($, id, title, from);
        },
        closePane: (id) => $.ui.close({ id }),
        copy: (text) => $.ui.copy({ text }),
        openUrl: (url) => $.process.run(["open", url], { timeoutMs: 10_000 }),
        toast: (text) => $.ui.toast(text),
        redraw: () => $.ui.invalidate("ui.render"),
    };
}

/** Whether the terminal docks panes (fullscreen), and its height, as the band's last drawing said. */
let docksPanes: boolean | undefined;
let terminalRows = 30;

/**
 * Docked beside the transcript, a sidebar leaves the keyboard on the prompt; as a dialog above the prompt it takes the
 * keyboard and closes on Escape, as the diff mod's dialog does.
 */
/**
 * Opens a sidebar. Above the prompt it takes the keys, and Esc closes it. Docked beside the transcript it takes them
 * only as `mods.sidebar.focus` says (`command`: when a slash command opened it, typed at the keyboard; `always`;
 * `never`), so a click on the band leaves the prompt typing; there Esc gives the keys back and the sidebar stays.
 */
async function openSidebar($: EngineInterface, id: string, title: string, from: "command" | "band" = "band") {
    const rows = Math.max(12, Math.floor(terminalRows * 0.6));
    forgetFocus(id);

    if (docksPanes !== true) {
        return $.ui.open({ id, title, focus: true, closeOnEscape: true, rows });
    }

    const focus = (await settingsOf(hostOf($))).sidebar.focus;

    return $.ui.open(
        focus === "always" || (focus === "command" && from === "command") ? { id, title, focus: true } : { id, title }
    );
}

// The features that share events. The engine takes one unmatched hook per event from a plugin, so each event
// below has one hook that calls every feature's part in this order.
const FEATURES: Feature[] = [decisions, gitBand, spinner, cacheBand, tmpUsage, agentsBand, hookLedger, stallCatcher];

export const register: Register = (on) => {
    on("session.start", async ($, e, next) => {
        const host = hostOf($);
        // A reload runs `session.start` again in the middle of a turn: mark the session at once, not at the next turn.
        await announceSession($);
        // Times drawn with `liveAgo` / `liveLeft` redraw when their text changes.
        startLiveClock(host);
        // Which genesis.tools links open here, asked outside any render (a newer render aborts an older one's runs).
        primeGenesisProbe(host);

        for (const feature of FEATURES) {
            for (const command of feature.commands ?? []) {
                await $.command.register({
                    name: command.name,
                    description: command.description,
                    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
                });
            }

            await feature.start?.(host);
        }

        return next(e);
    });

    on("session.end", async ($, e, next) => {
        await markEnded(hostOf($));

        return next(e);
    });

    on("command.run", async ($, e, next) => {
        const command = FEATURES.flatMap((feature) => feature.commands ?? []).find((held) => held.name === e.command);

        return command ? command.run(hostOf($), e.args ?? "") : next(e);
    });

    on("tool.call", async ($, e, next) => {
        const host = hostOf($);
        // Before the call runs, so its PostToolUse hook sees the mark; a no-op once this module set it.
        await announceSession($);
        rememberToolPaths(e);
        const ends = FEATURES.flatMap((feature) => feature.beforeTool?.(host, e) ?? []);

        try {
            const result = await next(e);

            for (const feature of FEATURES) {
                await feature.afterTool?.(host, e);
            }

            return result;
        } finally {
            for (const end of ends) {
                end();
            }
        }
    });

    // Two stages over the model's stream: the Agent arguments get the model, the main loop's reply text its links.
    on("turn.step", async function* ($, e, next) {
        const host = hostOf($);
        const settings = await settingsOf(host);
        let stream: HookStream<TurnStepChunk, TurnStepResult | undefined> = next(e);

        if (settings.agentModel.enabled) {
            stream = streamOf(agentModelStep(stream, settings.agentModel.format));
        }

        if (settings.links.enabled && e.agentId === undefined) {
            stream = streamOf(linksStep(host, e, stream));
        }

        return yield* stream;
    });

    on("agent.spawn", async ($, e, next) => {
        const host = hostOf($);
        const settings = (await settingsOf(host)).agentModel;
        const result = await next(settings.enabled ? spawnWithModel(e, settings.format) : e);
        recordSpawn(host, e, result);

        return result;
    });

    on("classic.*", async ($, e, next) => {
        noteTranscript(e);
        await noteStop(hostOf($), e);
        const result = await next(e);
        const kept = await ledgerClassic(hostOf($), e, result);

        return kept ? { ...result, additionalContext: kept } : result;
    });

    on("turn.start", async ($, e, next) => {
        stopIdleTimer();
        clearStall(hostOf($), "new turn");
        await announceSession($);

        return next(e);
    });

    on("turn.complete", async ($, e, next) => {
        const done = await next(e);
        const host = hostOf($);

        if (e.agentId === undefined) {
            stopIdleTimer();

            const settings = idleCompactSettings(await readHooksFile(host, await agentsDir(host)));

            if (settings.enabled) {
                const ms = settings.minutes * 60_000;
                idleTimer = $.clock.after(ms, () => {
                    void compactIfIdle($);
                });

                // The band shows the countdown only when the timer will compact: a small context is skipped at fire time.
                const tokens = (await $.session.usage().catch(() => undefined))?.context.tokens;
                setIdleDueAt(tokens === undefined || tokens >= settings.minTokens ? Date.now() + ms : undefined);
            }
        }

        for (const feature of FEATURES) {
            await feature.afterTurn?.(host, e);
        }

        return done;
    });

    on("session.compact", async ($, e, next) => {
        const result = await next(e);
        const host = hostOf($);

        // The person's /compact, the engine's own auto or idle compaction: nothing is left to save.
        if (compactionEndsIdleWait({ agentId: e.agentId, trigger: e.trigger, skipped: result.skip !== undefined })) {
            stopIdleTimer();
        }

        if (result.skip === undefined) {
            for (const feature of FEATURES) {
                await feature.compacted?.(host, e.agentId);
            }
        }

        return result;
    });

    on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
        if (e.props.hasSurvey) {
            return next(e);
        }

        docksPanes = e.viewport?.isFullscreen ?? docksPanes;
        terminalRows = e.viewport?.rows ?? terminalRows;
        const host = hostOf($);
        const ui = $.ui.resolve(e);
        const columns = e.props.bodyColumns;
        const [hooks, ...rest] = await Promise.all([
            hooksChip(host, ui),
            stallRow(host, ui),
            cacheRow(host, ui),
            agentsRow(host, ui, columns),
            tmpRow(host, ui),
        ]);
        // The first row gives the hooks chip its text and its left margin. `bodyColumns` already leaves out the
        // engine's five columns at the right end, which hold its `[-]`.
        const git = await gitRows(host, ui, { columns, firstReserve: hooks ? hooksChipWidth() + 1 : 0 });

        // The hooks chip shares the first git row; every other checkout's row has the whole width.
        return bandTree(ui, [topRow(ui, git[0] ?? null, hooks), ...git.slice(1), ...rest], await next(e));
    });

    // Every feature's sidebar (`Feature.sidebars`), by the pane's id; another plugin's panes pass on.
    on("ui.render", { component: "Pane" }, async ($, e, next) => {
        const sidebar = FEATURES.flatMap((feature) => feature.sidebars ?? []).find((held) => held.id === e.requestId);

        if (!sidebar) {
            return next(e);
        }

        const host = hostOf($);
        const kit = {
            ui: $.ui.resolve(e),
            columns: Math.max(1, e.props.bodyColumns - (e.props.placement === "dock" ? 1 : 0)),
            rows: e.props.scroll.bodyRows,
            placement: e.props.placement,
            isFocused: e.props.isFocused,
            focused: focusOf(e.requestId).key,
            isOnEngineStop: focusOf(e.requestId).onEngineStop,
            hints: (await settingsOf(host)).sidebar.hints,
            pressables: [],
        };

        return sidebar.draw(host, kit);
    });

    // Where a sidebar's focus ring is, so the line under a row of Buttons says what the focused one does.
    on("ui.focus", { component: "Pane" }, async ($, e, next) => {
        const result = await next(e);

        if (!result.deny && FEATURES.some((feature) => feature.sidebars?.some((held) => held.id === e.requestId))) {
            noteFocus(e.requestId, e.element);
            $.ui.invalidate("ui.render");
        }

        return result;
    });

    on("prompt.autocomplete", async ($, e, next) => {
        const host = hostOf($);
        const mine = (await Promise.all(FEATURES.map((feature) => feature.autocomplete?.(host, e) ?? []))).flat();
        const below = await next(e);

        return mine.length > 0 ? { suggestions: [...mine, ...below.suggestions] } : below;
    });

    on("ui.render", { component: "Spinner" }, async ($, e, next) => {
        if (!(await settingsOf(hostOf($))).spinner.enabled) {
            return next(e);
        }

        return next({ ...e, props: { ...e.props, suffix: progressSuffix(e.props.suffix, Date.now()) } });
    });

    on("ui.render", { component: "ToolGroup" }, async ($, e, next) => {
        const ui = $.ui.resolve(e);
        const drawn = await withGroupDiffs($, e.props, e.requestId, ui, await next(e));
        const calls = e.props.calls.map((call) => ({ tool: call.tool, input: call.input }));

        return askOnRow(hostOf($), ui, drawn, {
            id: e.requestId,
            isRunning: e.props.isActive || e.props.isExpanded,
            calls,
        });
    });

    on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
        const ui = $.ui.resolve(e);
        const { tool, input, output, tool_use_id, isRunning } = e.props;
        const drawn = await withCallDiffs($, e.props, ui, await next(e));

        return askOnRow(hostOf($), ui, drawn, { id: tool_use_id, isRunning, calls: [{ tool, input, output }] });
    });
};
/** The band's first row: the git row at the left, the hooks chip at the right edge; either may be missing. */
function topRow(ui: ElementTable, git: RenderElement | null, hooks: RenderElement | null): RenderElement | null {
    if (!hooks) {
        return git;
    }

    const { Box } = ui;

    return (
        <Box key="band-top" flexDirection="row">
            <Box flexShrink={1} minWidth={0} overflow="hidden">
                {git}
            </Box>
            <Box flexGrow={1} />
            <Box flexShrink={0} marginLeft={1}>
                {hooks}
            </Box>
        </Box>
    );
}

async function withGroupDiffs(
    $: EngineInterface,
    props: {
        isExpanded: boolean;
        calls: readonly { tool: string; input: unknown; isRunning: boolean; tool_use_id?: string }[];
    },
    row: string,
    ui: ElementTable,
    drawn: RenderElement
): Promise<RenderElement> {
    if (props.isExpanded) {
        return drawn;
    }

    const calls = props.calls.flatMap((call) =>
        call.tool === "Bash" && !call.isRunning && call.tool_use_id ? [{ id: call.tool_use_id, input: call.input }] : []
    );
    const diffs = await fullDiffs($, calls);

    if (diffs.sections.length === 0 && diffs.omitted.length === 0) {
        return drawn;
    }

    return drawDiffs($, ui, row, diffs, drawn);
}

async function withCallDiffs(
    $: EngineInterface,
    props: { tool: string; isRunning: boolean; tool_use_id: string; input: unknown },
    ui: ElementTable,
    drawn: RenderElement
): Promise<RenderElement> {
    if (props.tool !== "Bash" || props.isRunning) {
        return drawn;
    }

    const diffs = await fullDiffs($, [{ id: props.tool_use_id, input: props.input }]);

    if (diffs.sections.length === 0 && diffs.omitted.length === 0) {
        return drawn;
    }

    return drawDiffs($, ui, props.tool_use_id, diffs, drawn);
}
