import type { EngineInterface, Register, Timer } from "claude-code";
import { idleCompactSettings, idleCompactSkip, idleNotice } from "./idle";
import { type CallSection, fullDiffEnabled, sectionsOfCalls } from "./sections";

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

async function fullDiffs($: EngineInterface, ids: readonly string[]): Promise<CallSection[]> {
    const dir = ids.length > 0 ? await agentsDir($) : undefined;

    if (!dir) {
        return [];
    }

    const hooksFile = await readHooksFile($, dir);

    if (!fullDiffEnabled(hooksFile)) {
        return [];
    }

    return sectionsOfCalls({ ids, read: (id) => $.fs.read(`${dir}/hook-diffs/${id}.md`), maxChars: MAX_CHARS });
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

export const register: Register = (on) => {
    on("turn.start", (_$, e, next) => {
        stopIdleTimer();

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
        if (e.agentId === undefined && result.skip === undefined) {
            stopIdleTimer();
        }

        return result;
    });

    on("ui.render", { component: "ToolGroup" }, async ($, e, next) => {
        const drawn = await next(e);

        if (e.props.isExpanded) {
            return drawn;
        }

        const ids = e.props.calls.flatMap((call) =>
            call.tool === "Bash" && !call.isRunning && call.tool_use_id ? [call.tool_use_id] : []
        );
        const sections = await fullDiffs($, ids);

        if (sections.length === 0) {
            return drawn;
        }

        const { Box, Code, Text } = $.ui.resolve(e);

        return (
            <Box flexDirection="column">
                {drawn}
                {sections.map((section) => (
                    <Box key={`${section.call}:${section.path}`} flexDirection="column">
                        <Text dimColor>{section.path}</Text>
                        <Code source={section.patch} format="diff" path={section.path} />
                    </Box>
                ))}
            </Box>
        );
    });

    on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
        const drawn = await next(e);

        if (e.props.tool !== "Bash" || e.props.isRunning) {
            return drawn;
        }

        const sections = await fullDiffs($, [e.props.tool_use_id]);

        if (sections.length === 0) {
            return drawn;
        }

        const { Box, Code, Text } = $.ui.resolve(e);

        return (
            <Box flexDirection="column">
                {drawn}
                {sections.map((section) => (
                    <Box key={section.path} flexDirection="column">
                        <Text dimColor>{section.path}</Text>
                        <Code source={section.patch} format="diff" path={section.path} />
                    </Box>
                ))}
            </Box>
        );
    });
};
