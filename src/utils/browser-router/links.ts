export interface RunLink {
    url: string;
    markdown: string;
}

export interface RouterStatus {
    installed: boolean;
    presets: string[];
}

/** True when the user has saved a route tagged with this preset id. */
export function presetEnabled(presetId: string, presets: string[]): boolean {
    return presets.includes(presetId);
}

/**
 * One door for clickable links. Returns null when the router is not installed or the preset is off,
 * so callers print the plain command instead of a dead link.
 */
export function linkFor(presetId: string, status: RouterStatus, url: string, label: string): RunLink | null {
    if (!status.installed || !presetEnabled(presetId, status.presets)) {
        return null;
    }

    return { url, markdown: `[${label}](${url})` };
}
