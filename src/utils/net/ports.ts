/**
 * DevTools ports of browsers GenesisTools attaches to or starts. They are not GenesisTools servers
 * (those are registered in `src/utils/ui/dashboards.ts`), so they are named here, once. No imports:
 * browser-side code may read this file too.
 */

/** The user's own browser started with `--remote-debugging-port` (Brave on this setup). */
export const BROWSER_DEVTOOLS_PORT = 9222;

/** A throwaway browser started with an extension loaded, for tests (`tools youtube extension devtools launch`). */
export const EXTENSION_TEST_BROWSER_PORT = 9333;
