export interface TtydSessionBinding {
    id: string;
    port: number;
    label: string;
    cwd?: string;
    lastCommand?: string;
}

/** Pure pieces of the session header line — kept separate so tests don't need picocolors. */
export function printSessionHeaderParts(
    _name: string,
    _attached: boolean,
    windowCount: number,
    ttydTabs: TtydSessionBinding[] | undefined
): { windows: string; ttyd: string } {
    return {
        windows: `${windowCount} window${windowCount === 1 ? "" : "s"}`,
        ttyd: ttydTabs && ttydTabs.length > 0 ? ` · ttyd ${ttydTabs.map((t) => `:${t.port}`).join(" ")}` : "",
    };
}

export function formatTtydBranchForTest(tabs: TtydSessionBinding[]): string {
    const parts = tabs.map((t) => {
        const bits = [`:${t.port}`, t.label];

        if (t.lastCommand) {
            bits.push(t.lastCommand);
        }

        return bits.join(" ");
    });

    return `ttyd ${parts.join(" · ")}`;
}
