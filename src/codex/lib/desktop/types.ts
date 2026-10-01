export interface DesktopPatchRender {
    css: string;
    script: string;
}

/** One injectable desktop patch. Register it from `registry.ts`. */
export interface DesktopPatch {
    id: string;
    description: string;
    /** Byte strings that must still exist in the packed app before anything is written. */
    needles: readonly string[];
    render(options: Record<string, string>): DesktopPatchRender;
}

export interface DesktopPatchSelection {
    id: string;
    options: Record<string, string>;
}

export interface DesktopPatchManifest {
    appliedAt: string;
    appVersion: string;
    bundleVersion: string;
    patches: DesktopPatchSelection[];
}

export interface DesktopAppInfo {
    appPath: string;
    plistPath: string;
    asarPath: string;
    executablePath: string;
    codeResourcesPath: string;
    bundleId: string;
    version: string;
    bundleVersion: string;
    executable: string;
}

export interface DesktopStatus {
    app: DesktopAppInfo;
    headerHash: string;
    patched: boolean;
    manifest: DesktopPatchManifest | null;
    backupDir: string | null;
    running: boolean;
    asarBytes: number;
}
