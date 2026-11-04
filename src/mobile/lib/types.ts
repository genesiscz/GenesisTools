/** One screen of an app, reached by a deep link. */
export interface MobileRoute {
    /** A file-safe name, used in the screenshot name: `03-qa.png`. */
    name: string;
    url: string;
    /** The accessibility id (React Native testID) of the screen's root, which the Appium driver waits for. */
    rootId?: string;
}

/** How to build the app for a simulator with `xcodebuild` (Expo's `run:ios` cannot find DeviceHub on Xcode 27). */
export interface IosBuild {
    /** The workspace, relative to the app folder. */
    workspace: string;
    scheme: string;
    configuration: "Debug" | "Release";
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
}
