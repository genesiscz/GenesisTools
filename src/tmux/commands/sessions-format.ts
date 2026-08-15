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

/** Colorization, injected so the CLI and the test share ONE formatter instead of two copies. */
export interface TtydBranchStyle {
    head: (value: string) => string;
    label: (value: string) => string;
    command: (value: string) => string;
    separator: (value: string) => string;
}

const PLAIN_STYLE: TtydBranchStyle = {
    head: (value) => value,
    label: (value) => value,
    command: (value) => value,
    separator: (value) => value,
};

export function formatTtydBranch(tabs: TtydSessionBinding[], style: TtydBranchStyle = PLAIN_STYLE): string {
    const parts = tabs.map((t) => {
        const bits = [`:${t.port}`, style.label(t.label)];

        if (t.lastCommand) {
            bits.push(style.command(t.lastCommand));
        }

        return bits.join(" ");
    });

    return `${style.head("ttyd")} ${parts.join(style.separator(" · "))}`;
}
