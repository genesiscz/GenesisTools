import type { EngineInterface, Register } from "claude-code";
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

async function fullDiffs($: EngineInterface, ids: readonly string[]): Promise<CallSection[]> {
    const dir = ids.length > 0 ? await agentsDir($) : undefined;

    if (!dir) {
        return [];
    }

    const hooksFile = await $.fs.read(`${dir}/hooks.json`).catch(() => undefined);

    if (!fullDiffEnabled(hooksFile)) {
        return [];
    }

    return sectionsOfCalls({ ids, read: (id) => $.fs.read(`${dir}/hook-diffs/${id}.md`), maxChars: MAX_CHARS });
}

export const register: Register = (on) => {
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
