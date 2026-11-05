import type { MobilePlatformId, MobileProject } from "@genesiscz/utils/mobile/project";

export type DeviceState = "booted" | "shutdown" | "offline" | "unknown";

/** A simulator, emulator or physical device of one platform, as the device commands list and pick it. */
export interface MobileDevice {
    platform: MobilePlatformId;
    /** The udid (iOS) or adb serial (Android); an Android AVD that is not running is `avd:<name>`. */
    id: string;
    name: string;
    state: DeviceState;
    /** What the platform itself calls the state (`Booted`, `unauthorized`, …). */
    rawState: string;
    osVersion: string;
    kind: "simulator" | "emulator" | "device";
}

/** The project's app on one platform: what `install`, `launch` and `url` need. */
export interface PlatformApp {
    /** The bundle id (iOS) or package name (Android). */
    id: string;
    /** The Android activity `launch` starts; iOS has none. */
    activity?: string;
    /** The build `install` uses when no path is given; null when the project names none. */
    artifact: string | null;
}

/**
 * Device control for one platform. Every device command goes through this table and never compares platform names;
 * a new platform is one implementation file and one table entry.
 */
export interface MobilePlatform {
    readonly id: MobilePlatformId;
    readonly title: string;
    /** The OS name in a device line: `iOS 26.5`, `Android 15`. */
    readonly osName: string;
    /** The project's app on this platform; throws when the project has no entry for it. */
    app(project: MobileProject): PlatformApp;
    listDevices(): Promise<MobileDevice[]>;
    /** Boots a device by id (a udid, an adb serial, or an Android AVD name) and returns it once it is ready. */
    boot(target: string, options: { timeoutMs: number }): Promise<MobileDevice>;
    shutdown(device: MobileDevice): Promise<void>;
    install(device: MobileDevice, artifact: string): Promise<void>;
    uninstall(device: MobileDevice, app: PlatformApp): Promise<void>;
    isInstalled(device: MobileDevice, app: PlatformApp): Promise<boolean>;
    launch(device: MobileDevice, app: PlatformApp): Promise<void>;
    terminate(device: MobileDevice, app: PlatformApp): Promise<void>;
    /** Opens a link on the device, for the app when one is given. */
    openUrl(device: MobileDevice, url: string, app?: PlatformApp): Promise<void>;
    screenshot(device: MobileDevice, file: string): Promise<void>;
}
