/** One screen of an app, reached by a deep link. */
export interface MobileRoute {
    /** A file-safe name, used in the screenshot name: `03-qa.png`. */
    name: string;
    url: string;
    /** The accessibility id (React Native testID) of the screen's root, which the Appium driver waits for. */
    rootId?: string;
}

import type { SimctlPrivacyService } from "@genesiscz/utils/mobile/simulator";

export const IOS_CONFIGURATIONS = ["Debug", "Release"] as const;

/** How to build the app for a simulator with `xcodebuild` (Expo's `run:ios` cannot find DeviceHub on Xcode 27). */
export interface IosBuild {
    /** The workspace, relative to the app folder. */
    workspace: string;
    scheme: string;
    configuration: (typeof IOS_CONFIGURATIONS)[number];
    /** The `.app` name under `Build/Products/<configuration>-iphonesimulator/`. */
    productName: string;
    /** Extra `KEY=value` build settings, e.g. a deployment target a dependency needs. */
    buildSettings?: Record<string, string>;
}

/**
 * One app `tools mobile` knows. Adding an app is one folder under `src/mobile/apps/<id>/` and one line in the
 * registry; nothing else in the tool names an app.
 */
export interface MobileApp {
    id: string;
    title: string;
    /** The app's absolute folder (the one holding `app.json` and `ios/`). */
    locate(): string;
    bundleId(appDir: string): string;
    ios: IosBuild;
    /** Every screen in the order a user meets them. */
    routes(appDir: string): MobileRoute[];
    /** The phone width in points `up` sizes a simulator for when `--width` is not given. */
    defaultWidth: number;
    /** A React Native app whose Debug build loads its JavaScript from Metro; absent for an app without Metro. */
    metro?: MetroSetup;
    /** What decides that a build is out of date (`up` rebuilds then). */
    buildInputs: BuildInputs;
    /** What a fresh install needs before it runs unattended (`first-run`, `up`). */
    firstRun: FirstRunSetup;
    /** The app's own e2e suite, run by `tools mobile e2e`. */
    e2e?: E2eSetup;
}

export interface MetroSetup {
    /** The port `up` starts Metro on when `--metro-port` is not given. */
    defaultPort: number;
}

/**
 * Globs relative to the app folder. `native` files go into every build; `js` files only into a build that carries its
 * JavaScript (Release). A build is stale when any matched file changed since it was built.
 */
export interface BuildInputs {
    native: string[];
    js: string[];
}

export interface FirstRunSetup {
    /** `simctl privacy grant` services. */
    privacy: SimctlPrivacyService[];
    /** `idb approve` services (camera, notifications, url) that simctl cannot grant; used only where idb is installed. */
    idbApprove: string[];
    /** The URL scheme `idb approve … url` pre-approves, so a plain `simctl openurl` raises no "Open in" alert. */
    scheme?: string;
    /** User defaults written into the app's domain, e.g. a dev menu that would open at launch. */
    defaults: Array<{ key: string; value: string[] }>;
}

/** What `tools mobile e2e` passes a run of one spec file. */
export interface E2eContext {
    udid: string;
    deviceName: string;
    osVersion: string;
    appiumPort: number;
    wdaPort: number;
    bundleId: string;
    /** The folder this spec's screenshots, results and logs go to. */
    runDir: string;
    /** The server the app pairs with during the run, when the suite needs one. */
    agentUrl?: string;
}

export interface E2eSetup {
    /** The runner's config, relative to the app folder; specs run with `bunx wdio run <config> --spec <file>`. */
    config: string;
    /** The spec folder, relative to the app folder; every `*.spec.ts` under it is a spec. */
    specsDir: string;
    /** Named spec sets (`tools mobile e2e suite <app> <name>`); file names without `.spec.ts`. */
    suites: Record<string, string[]>;
    /** The environment the runner reads its device, ports and output folder from. */
    env(context: E2eContext): Record<string, string>;
    /** The file name, in the spec's run folder, the runner appends one JSON line per test to. */
    resultsFile: string;
}
