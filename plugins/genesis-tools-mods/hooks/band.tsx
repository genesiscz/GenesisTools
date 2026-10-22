// The band above the prompt: every feature's row (git, cache, agents, /tmp) stacked in a fixed order above what
// the engine and the plugins beneath draw there. A row is null when its feature is off or has nothing to say.
import type { ElementTable, RenderElement } from "claude-code";

export function bandTree(
    ui: ElementTable,
    rows: readonly (RenderElement | null)[],
    below: RenderElement
): RenderElement {
    const shown = rows.filter((row) => row !== null);

    if (shown.length === 0) {
        return below;
    }

    const { Box } = ui;

    return (
        <Box key="genesis-band" flexDirection="column">
            {shown}
            {below}
        </Box>
    );
}
