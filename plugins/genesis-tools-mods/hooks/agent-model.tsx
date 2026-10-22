// The model each subagent ran on, at the right edge of its Agent row. A folded group draws the models of
// its Agent calls on its line; an expanded group draws its rows, and each Agent row carries its own model.
import type { On } from "claude-code";

interface AgentCall {
    input: unknown;
    output?: unknown;
    isRunning: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** `claude-sonnet-5-5` shows as `sonnet-5-5`; a dated id such as `claude-haiku-4-5-20251001` loses its date. */
function modelLabel(id: string): string {
    return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** The model an Agent result names: the one it runs on, or every model of a mid-run swap, in order. */
function modelsOf(output: unknown): string[] {
    if (!isRecord(output)) {
        return [];
    }

    const used = Array.isArray(output.modelsUsed)
        ? output.modelsUsed.filter((id): id is string => typeof id === "string")
        : [];
    const current = typeof output.resolvedModel === "string" ? [output.resolvedModel] : [];

    return used.length > 1 ? used : current;
}

function agentModel(call: AgentCall): string {
    const models = modelsOf(call.output).map(modelLabel);

    if (models.length > 0) {
        return models.join(" → ");
    }

    return call.isRunning ? "pending" : "unknown";
}

export function agentModelHooks(on: On): void {
    on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
        const drawn = await next(e);

        if (e.props.tool !== "Agent") {
            return drawn;
        }

        const { Box, Text } = $.ui.resolve(e);

        return (
            <Box flexDirection="row" gap={1}>
                <Box flexGrow={1}>{drawn}</Box>
                <Text dimColor>{agentModel(e.props)}</Text>
            </Box>
        );
    });

    on("ui.render", { component: "ToolGroup" }, async ($, e, next) => {
        const drawn = await next(e);

        if (e.props.isExpanded) {
            return drawn;
        }

        const agents = e.props.calls.filter((call) => call.tool === "Agent");

        if (agents.length === 0) {
            return drawn;
        }

        const { Box, Text } = $.ui.resolve(e);

        return (
            <Box flexDirection="row" gap={1}>
                <Box flexGrow={1}>{drawn}</Box>
                <Text dimColor>{agents.map((call) => agentModel(call)).join(" · ")}</Text>
            </Box>
        );
    });
}
