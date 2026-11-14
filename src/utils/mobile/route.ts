// No imports on purpose: an app's e2e adapter imports this type under the app's own tsconfig, which resolves none of
// the package aliases `project.ts` needs.

/** One screen of an app, reached by a deep link. */
export interface MobileRoute {
    /** A file-safe name, used in screenshot names: `03-qa.png`. */
    name: string;
    url: string;
    /** The accessibility id (React Native testID) of the screen's root, which the Appium driver waits for. */
    rootId?: string;
}
