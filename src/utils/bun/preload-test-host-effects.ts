import { mock } from "bun:test";
import { Browser } from "@genesiscz/utils/browser";
import * as fullDiskAccess from "@genesiscz/utils/macos/full-disk-access";
import * as jxa from "@genesiscz/utils/macos/jxa";
import * as macosNotifications from "@genesiscz/utils/macos/notifications";
import { settings as macosSettings } from "@genesiscz/utils/macos/system-settings";
import type { NotificationEvent, WebhookChannelConfig } from "@genesiscz/utils/notifications";
import * as notifications from "@genesiscz/utils/notifications";
import * as trashStaging from "@genesiscz/utils/prompts/clack/trash-staging";

/**
 * Put the user's own machine out of reach of `bun test`.
 *
 * The sandbox preload already redirects everything that lands on DISK, and the
 * keyring preload blocks the one piece of machine-global state a test could
 * corrupt. This covers the third family: surfaces that belong to whoever is
 * sitting at the keyboard, which no `GENESIS_TOOLS_HOME` can redirect. A test
 * that reaches one of these does not corrupt state — it interrupts a person.
 *
 * Both of these shipped for real on 2026-09-09, hours apart, in one file:
 *
 * - Two tests set `chooseUrlAction: "open"` without injecting `openUrl`, and
 *   `presentAuthorizationUrl` falls through to `Browser.open`. Every run opened
 *   two tabs on the live OpenAI authorization page; about sixteen tabs appeared
 *   in the user's browser before anyone connected them to a test run.
 * - The fix for that then reached for `ctx.copyUrl`, which does not exist on
 *   the context, so the fallback would have run the real `copyToClipboard` and
 *   overwritten the user's clipboard on every run. Only `tsgo` caught it.
 *
 * Per-file spies caught neither, because a per-file spy protects the file whose
 * author already thought about it. This is that guard installed once for every
 * test process, so a file whose author never heard of the rule is covered too.
 * The existing spies in the login-flow suites stay: `spyOn` saves and restores
 * whatever it finds, so they layer over this cleanly, and a guard is allowed to
 * be redundant.
 *
 * Wired ONLY into bunfig.toml `[test].preload`, never the top-level `preload`,
 * so a real `tools` invocation keeps every one of these behaviours.
 *
 * RUN_HOST_EFFECTS=1 opts the whole file out, for a deliberate end-to-end check
 * against the real machine. Nothing in CI should ever set it.
 *
 * Uses process.env directly on purpose: preloads are test infrastructure and
 * must not drag the app env facade into every test's module graph before the
 * mocks are installed.
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

function blocked(surface: string, remedy: string): (...args: never[]) => never {
    return () => {
        throw refusal(surface, remedy);
    };
}

/**
 * The async half of the same guard, and not interchangeable with it.
 * `dispatchNotification` is called without `await` in `src/claude/lib/usage/watch.ts`
 * and `src/telegram/lib/actions/notify.ts`, so a synchronous throw would escape
 * into a caller that never expects one and fail somewhere unrelated to the
 * mistake. A rejected promise keeps the guarded function's real shape; the side
 * effect is prevented either way, which is the guarantee that matters.
 */
function blockedAsync(surface: string, remedy: string): (...args: never[]) => Promise<never> {
    return () => Promise.reject(refusal(surface, remedy));
}

/**
 * A webhook aimed at a server the test itself started is not a host effect, so
 * that one keeps working. Everything else leaves the machine, including the
 * plausible-looking placeholder domains already sitting in fixtures, which
 * belong to somebody and would receive a real POST.
 */
function isLoopbackUrl(url: string | undefined): boolean {
    if (!url) {
        return false;
    }

    try {
        const { hostname } = new URL(url);
        // `new URL("http://[::1]:3000").hostname` keeps the brackets, so the
        // bare "::1" form never appears here. The whole 127.0.0.0/8 range is
        // loopback, not just .1, and a test is free to bind anywhere in it.
        return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    } catch {
        // An unparseable URL reaches no server, so the real dispatcher's own
        // error path is the honest thing to let it hit.
        return true;
    }
}

function installHostEffectGuards(): void {
    // Snapshotted BEFORE any mock is installed. `mock.module` rewrites the live
    // namespace binding, so a factory that spread `...notifications` at call
    // time could spread the replacement over itself, and a guard that read
    // `notifications.dispatchWebhook` from inside its own replacement would
    // recurse forever — the run hangs rather than failing, which is the worst
    // way to learn this. Copying first makes the order impossible to get wrong.
    const realJxa = { ...jxa };
    const realMacosNotifications = { ...macosNotifications };
    const realNotifications = { ...notifications };
    const realFullDiskAccess = { ...fullDiskAccess };
    const realTrashStaging = { ...trashStaging };

    // A class static is a writable property on one shared object, so assigning
    // it reaches every importer. `mock.module` would have to re-export the rest
    // of the module by hand, and `getPreferred`/`setPreferred` are legitimately
    // under test in browser.preferred.test.ts.
    Browser.open = blockedAsync("Browser.open", "Inject the opener and assert the URL that would have been opened.");
    Browser.openAll = blockedAsync(
        "Browser.openAll",
        "Inject the opener and assert the URLs that would have been opened."
    );

    // The clipboard is the one surface here with a meaningful in-memory
    // equivalent: it holds a string and gives it back. Faking it rather than
    // blocking it keeps a copy-then-read test honest while the real clipboard
    // is untouched, and a test that wants to assert what was copied reads it
    // back through the same API.
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

    // ESM exports are read-only bindings, so these cannot be assigned the way a
    // class static can. Spreading the real namespace keeps every other export
    // intact, which matters: `escapeJxa` is a pure string function and a second
    // copy here would be a second copy to get wrong.
    mock.module("@genesiscz/utils/macos/jxa", () => ({
        ...realJxa,
        // Drives real applications through osascript: Notes, Reminders, Finder,
        // System Settings. A test reaching this one edits the user's own data.
        runJxa: blocked("runJxa", "Fake the script result; do not drive a real application."),
    }));

    mock.module("@genesiscz/utils/macos/notifications", () => ({
        ...realMacosNotifications,
        sendNotification: blockedAsync("sendNotification", "Assert the notification payload instead of delivering it."),
    }));

    // A plain object, so the same assignment trick as the Browser class works
    // and reaches `MacOS.settings` too, which is the same object. Every member
    // shells out to `open x-apple.systempreferences:…` and raises a window over
    // whatever the user is doing.
    for (const pane of Object.keys(macosSettings)) {
        Reflect.set(macosSettings, pane, blocked(`MacOS.settings.${pane}`, "Assert that the pane would be opened."));
    }

    mock.module("@genesiscz/utils/macos/full-disk-access", () => ({
        ...realFullDiskAccess,
        // Shows a MODAL `display dialog` through osascript and waits for a
        // click. Under `bun test` there is nobody to click it, so a test that
        // reaches this does not fail — it hangs until the timeout, and takes a
        // window over the user's screen with it.
        requestFullDiskAccess: blocked(
            "requestFullDiskAccess",
            "Assert the decision instead of raising a modal dialog nobody is there to answer."
        ),
    }));

    // The most destructive surface in the repo that a test can reach: these
    // shell out to `tell application "Finder" to move …` and, worse,
    // `empty trash`. Emptying the user's Trash cannot be undone by anything in
    // this process. The two script BUILDERS stay real — they are pure string
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

    // The barrel, not `./dispatch`, because every consumer in the repo imports
    // `@genesiscz/utils/notifications` and a mock has to sit on the specifier
    // that is actually resolved. The channels are blocked beside the dispatcher
    // that calls them, so importing one directly is guarded too.
    mock.module("@genesiscz/utils/notifications", () => ({
        ...realNotifications,
        dispatchNotification: blockedAsync(
            "dispatchNotification",
            "Assert the event instead of delivering it to Telegram, a webhook or the system."
        ),
        dispatchSay: blockedAsync("dispatchSay", "Assert the message instead of speaking it out loud."),
        // The highest-stakes pair of the set. A stray browser tab can be closed
        // and a stray clipboard write can be replaced; a message delivered to a
        // real chat or a real endpoint cannot be taken back.
        dispatchTelegram: blockedAsync("dispatchTelegram", "Assert the event instead of posting it to a real chat."),
        dispatchSystem: blockedAsync("dispatchSystem", "Assert the event instead of raising a real notification."),
        // The one exception in the file, and it earns it: src/monitor spins up
        // its own `Bun.serve` on 127.0.0.1 and asserts a real redelivery
        // against it. A loopback POST reaches nobody, so blocking it would
        // trade a genuine test for no safety at all.
        dispatchWebhook: (event: NotificationEvent, config: WebhookChannelConfig) => {
            // A disabled channel or a missing URL is the real dispatcher's own
            // no-op, so refusing it would invent a failure where there is no
            // request at all.
            const inert = !config?.enabled || !config?.url;

            if (inert || isLoopbackUrl(config.url)) {
                return realNotifications.dispatchWebhook(event, config);
            }

            return Promise.reject(
                refusal(
                    "dispatchWebhook",
                    "Point it at a loopback server the test starts, or assert the event instead of posting it."
                )
            );
        },
    }));
}
