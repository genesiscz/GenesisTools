import type { AppPartId } from "@genesiscz/utils/genesis-tools/capability/generated/app-surface";

/**
 * Builds GenesisTools.app for the engine's `fix` decisions. The build lives in the macos tool, which `src/utils` cannot
 * import, so the tool registers its implementation when it starts (`registerAppBuilder`). With none registered, a
 * `build` or `offer-build` decision degrades to a skip with the build command as the fix.
 */
export interface AppBuilder {
    /** Build and install the app with this part (null: the parts already installed). */
    build(part: AppPartId | null, progress?: { onStep?: (line: string) => void }): Promise<void>;
    /** Ask the person in the terminal; true when they accepted and the build ran. */
    offerBuild(part: AppPartId | null): Promise<boolean>;
    /** The command a person runs by hand. */
    buildCommand(part: AppPartId | null): string;
}

let registered: AppBuilder | null = null;

export function registerAppBuilder(builder: AppBuilder | null): void {
    registered = builder;
}

export function appBuilder(): AppBuilder | null {
    return registered;
}

/** The command when no builder is registered; the same words the macos tool prints. */
export function defaultBuildCommand(part: AppPartId | null): string {
    return part ? `tools macos permissions build --add-part ${part}` : "tools macos permissions build";
}
