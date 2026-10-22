import type { ElementTable, EngineInterface, Register, RenderElement, Timer } from "claude-code";
import { atom, read, update } from "claude-code";
import type { FlippedFiles, ShownCalls } from "../types";
import { compactionEndsIdleWait, idleCompactSettings, idleCompactSkip, idleNotice } from "./idle";
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

/** `<home>/.genesis-tools/agents`; `GENESIS_TOOLS_HOME` replaces the home, as it does for every tool. */
async function agentsDir($: EngineInterface): Promise<string | undefined> {
    const home = (await $.env.get("GENESIS_TOOLS_HOME")) ?? (await $.env.get("HOME"));

    return home ? `${home}/.genesis-tools/agents` : undefined;
}

async function readHooksFile($: EngineInterface, dir: string | undefined): Promise<string | undefined> {
    return dir ? $.fs.read(`${dir}/hooks.json`).catch(() => undefined) : undefined;
}

interface Diffs {
    sections: CallSection[];
    /** The calls that run a git sync (`git pull`, …), each with that command, while `mods.collapseGitSync` is on. */
    syncs: Map<string, string>;
    /** The notes of the calls past `MAX_CHARS` (`sectionsOfCalls`), named under the diffs so none goes without a trace. */
    omitted: string[];
}

async function fullDiffs($: EngineInterface, calls: readonly { id: string; input: unknown }[]): Promise<Diffs> {
    const none: Diffs = { sections: [], syncs: new Map(), omitted: [] };
    const dir = calls.length > 0 ? await agentsDir($) : undefined;

    if (!dir) {
        return none;
    }

    const hooksFile = await readHooksFile($, dir);

    if (!fullDiffEnabled(hooksFile)) {
        return none;
    }

    const ids = calls.map((call) => call.id);
    const note = (id: string) => `${dir}/hook-diffs/${id}.md`;
    const { sections, omitted } = await sectionsOfCalls({
        ids,
        read: (id) => $.fs.read(note(id)),
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
// prompt pays for the whole context again. This timer compacts at `mods.idleCompactMinutes` (56) after the
// last main-loop turn, unless a compaction already happened. A reload of the mod drops the timer; the next
// turn arms it again.
let idleTimer: Timer | undefined;

function stopIdleTimer(): void {
    idleTimer?.cancel();
    idleTimer = undefined;
}

async function compactIfIdle($: EngineInterface): Promise<void> {
    idleTimer = undefined;

    // Read again at the fire time, so `config set mods.idleCompact false` stops a timer already armed.
    const settings = idleCompactSettings(await readHooksFile($, await agentsDir($)));
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

export const register: Register = (on) => {
    on("turn.start", async ($, e, next) => {
        stopIdleTimer();
        await announceSession($);

        return next(e);
    });

    on("turn.complete", async ($, e, next) => {
        const done = await next(e);

        if (e.agentId === undefined) {
            stopIdleTimer();

            const settings = idleCompactSettings(await readHooksFile($, await agentsDir($)));

            if (settings.enabled) {
                idleTimer = $.clock.after(settings.minutes * 60_000, () => {
                    void compactIfIdle($);
                });
            }
        }

        return done;
    });

    on("session.compact", async (_$, e, next) => {
        const result = await next(e);

        // The person's /compact, the engine's own auto or idle compaction: nothing is left to save.
        if (compactionEndsIdleWait({ agentId: e.agentId, trigger: e.trigger, skipped: result.skip !== undefined })) {
            stopIdleTimer();
        }

        return result;
    });

    on("ui.render", { component: "ToolGroup" }, async ($, e, next) => {
        const drawn = await next(e);

        if (e.props.isExpanded) {
            return drawn;
        }

        const calls = e.props.calls.flatMap((call) =>
            call.tool === "Bash" && !call.isRunning && call.tool_use_id
                ? [{ id: call.tool_use_id, input: call.input }]
                : []
        );
        const diffs = await fullDiffs($, calls);

        if (diffs.sections.length === 0 && diffs.omitted.length === 0) {
            return drawn;
        }

        return drawDiffs($, $.ui.resolve(e), e.requestId, diffs, drawn);
    });

    on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
        const drawn = await next(e);

        if (e.props.tool !== "Bash" || e.props.isRunning) {
            return drawn;
        }

        const diffs = await fullDiffs($, [{ id: e.props.tool_use_id, input: e.props.input }]);

        if (diffs.sections.length === 0 && diffs.omitted.length === 0) {
            return drawn;
        }

        return drawDiffs($, $.ui.resolve(e), e.props.tool_use_id, diffs, drawn);
    });
};
