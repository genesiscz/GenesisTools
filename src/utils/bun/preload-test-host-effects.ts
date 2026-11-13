import { mock } from "bun:test";
import * as trashStaging from "@genesiscz/utils/prompts/clack/trash-staging";

/**
 * Put the user's own machine out of reach of `bun test`, for the surfaces that cannot refuse by themselves.
 *
 * The sandbox preload already redirects everything that lands on DISK, and the keyring preload blocks the one
 * piece of machine-global state a test could corrupt. This covers the third family: surfaces that belong to
 * whoever is sitting at the keyboard, which no `GENESIS_TOOLS_HOME` can redirect. A test that reaches one of these
 * does not corrupt state — it interrupts a person.
 *
 * Our own surfaces refuse at their own entry now (`hostEffectRefusal` in `@genesiscz/utils/test-process`):
 * `Browser.open`, `runJxa`, the System Settings panes, the Full Disk Access dialog, `postNotification`, the app RPC
 * and every notification channel. That also covers a `tools` child a test spawns, which this preload never reached.
 * What stays here is what cannot carry that refusal:
 *
 * - `clipboardy`, a third-party package. Two tests on 2026-09-09 nearly overwrote the user's clipboard on every run.
 * - the Finder Trash staging, which this package left as it was. It is a second layer for the `tools rm` trash
 *   refusal, not a replacement for one.
 *
 * Wired ONLY into bunfig.toml `[test].preload`, never the top-level `preload`, so a real `tools` invocation keeps
 * every one of these behaviours.
 *
 * RUN_HOST_EFFECTS=1 opts the whole file out (and the in-code refusals too), for a deliberate end-to-end check
 * against the real machine. Nothing in CI should ever set it.
 *
 * Uses process.env directly on purpose: preloads are test infrastructure and must not drag the app env facade into
 * every test's module graph before the mocks are installed.
 */
if (process.env.RUN_HOST_EFFECTS !== "1") {
    installHostEffectGuards();
}

/** Names the surface, the reason, and the way to write the test properly. */
function refusal(surface: string, remedy: string): Error {
    return new Error(
        `${surface} is blocked under bun test — it reaches the machine the user is sitting at. ${remedy} ` +
            `Set RUN_HOST_EFFECTS=1 only for a deliberate end-to-end check against the real machine.`
    );
}

/**
 * A rejected promise, not a synchronous throw: the guarded functions are async, and a synchronous throw would change
 * the shape of every fire-and-forget call site it stands in for.
 */
function blockedAsync(surface: string, remedy: string): (...args: never[]) => Promise<never> {
    return () => Promise.reject(refusal(surface, remedy));
}

function installHostEffectGuards(): void {
    // Snapshotted BEFORE any mock is installed. `mock.module` rewrites the live namespace binding, so a factory that
    // spread `...trashStaging` at call time could spread the replacement over itself.
    const realTrashStaging = { ...trashStaging };

    // The clipboard is the one surface here with a meaningful in-memory equivalent: it holds a string and gives it
    // back. Faking it rather than blocking it keeps a copy-then-read test honest while the real clipboard is
    // untouched, and a test that wants to assert what was copied reads it back through the same API.
    let clipboard = "";
    const fakeClipboard = {
        read: async () => clipboard,
        readSync: () => clipboard,
        write: async (value: string) => {
            clipboard = value;
        },
        writeSync: (value: string) => {
            clipboard = value;
        },
    };
    mock.module("clipboardy", () => ({ ...fakeClipboard, default: fakeClipboard }));

    // These shell out to `tell application "Finder" to move …` and, worse, `empty trash`. Emptying the user's Trash
    // cannot be undone by anything in this process. The two script BUILDERS stay real — they are pure string
    // functions with their own tests, and faking them would only hide bugs.
    mock.module("@genesiscz/utils/prompts/clack/trash-staging", () => ({
        ...realTrashStaging,
        stageItems: blockedAsync("stageItems", "Assert the paths instead of moving real files to the Trash."),
        emptyTrash: blockedAsync(
            "emptyTrash",
            "Never empty the user's Trash from a test; assert the decision instead."
        ),
        stageAndConfirm: blockedAsync("stageAndConfirm", "Assert the staged items instead of moving and prompting."),
    }));
}
