/**
 * The GenesisTools.app launcher binary, as other processes and logs name it. The Swift link relay checks the same
 * suffix on its own (`LocalNetworkWatch.promptPid`); change both together.
 */
export const GENESIS_TOOLS_LAUNCHER_SUFFIX = "/GenesisTools.app/Contents/MacOS/GenesisTools";

/**
 * The launcher of the installed app or of a retired build. nehelper logs every app's Local Network prompt, and another
 * app's is not ours to describe (its dialog names that app).
 */
export function isGenesisToolsBinary(executable: string): boolean {
    return executable.endsWith(GENESIS_TOOLS_LAUNCHER_SUFFIX);
}

/** When the build behind `executable` was retired, or null for the installed app. */
export function retiredAtOf(executable: string): Date | null {
    const match = /retired(?:\.noindex)?\/(\d+)\//.exec(executable);
    return match ? new Date(Number(match[1])) : null;
}
