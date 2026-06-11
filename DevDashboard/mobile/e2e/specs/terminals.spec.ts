import { appPage } from "@e2e/pages/app.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { terminalsPage } from "@e2e/pages/TerminalsPage.page";

/**
 * Terminals — bug-fix verification (real assertions against the live testIDs).
 *
 * Once the connect gate is cleared in `before()`, the LIVE test Agent backs the session lists (the
 * mock client only serves before a transport connects — see client-provider). So session/ttyd names
 * are NOT deterministic; each `it` DISCOVERS the rendered names from the a11y tree (page object's
 * `tmuxSessionNames()` / `ttydSessionIds()` / `cmuxPaneIds()`) and asserts affordances against the
 * discovered names — never a hard-coded one. The suite requires at least one live tmux + one ttyd
 * session on the paired Agent (the spec header documents this prereq).
 *
 * WebView surfaces (Driver A ttyd / Driver B xterm.js) get generous waits — a cold WKWebView + ttyd
 * socket can take several seconds. The WebView inner DOM is opaque to Appium, so assertions target
 * the CONTAINER testID (`terminal-surface`), never terminal contents.
 *
 * AUTHORED, NOT RUN here. The orchestrator runs the suite serially on a real iOS dev-client. Prereqs
 * (device run): a booted iOS device/sim with the dev-client (DD_APP_PATH), a running Appium server
 * (`bun run e2e:appium`), a test Agent reachable at the paired baseUrl with auth satisfied, and at
 * least one live tmux + ttyd session on that Agent. `DD_BUNDLE_ID` overrides the deep-link id.
 */
describe("Terminals — bug-fix verification", () => {
    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.pairWithTestAgent();
        }

        await appPage.openTab("Terminals");
        await terminalsPage.isShown();
    });

    // Fix 1: every tmux row is attachable — attached>0 → "Attach", else "Open" (canAttachInTtyd gate gone).
    it("exposes an attach-or-open action on every tmux row", async () => {
        const names = await terminalsPage.tmuxSessionNames();
        expect(names.length).toBeGreaterThan(0);

        // EVERY listed session — regardless of attach state — must expose an attach OR open action.
        for (const name of names) {
            expect(await terminalsPage.hasAttachOrOpenAction(name)).toBe(true);
        }
    });

    // Fix 2: each tmux row exposes a rename action btn-rename-tmux-<name>.
    it("exposes a rename action on every tmux row", async () => {
        const names = await terminalsPage.tmuxSessionNames();
        expect(names.length).toBeGreaterThan(0);

        // Assert existence rather than tapping — tapping raises a native Alert.prompt (flaky).
        for (const name of names) {
            expect(await terminalsPage.tmuxRenameButtonExists(name)).toBe(true);
        }
    });

    // Fix 3: open a session in Driver A (ttyd WebView) — surface + key bar both render.
    it("opens a terminal in Driver A (ttyd WebView) with a surface and key bar", async () => {
        await terminalsPage.selectDriver("webview-ttyd");
        expect(await terminalsPage.isDriverOptionVisible("webview-ttyd")).toBe(true);

        const [name] = await terminalsPage.tmuxSessionNames();
        expect(name).toBeDefined();

        await terminalsPage.openTmuxSession(name);

        expect(await terminalsPage.terminalSurfaceVisible(15_000)).toBe(true);
        expect(await terminalsPage.keyBarVisible(15_000)).toBe(true);
    });

    // Fix 4: in-terminal rename pencil (btn-rename-terminal) is present while a terminal is open.
    it("shows the in-terminal rename pencil when a terminal is open", async () => {
        expect(await terminalsPage.renameTerminalVisible(10_000)).toBe(true);
    });

    // Fix 5: connected glowing dot — the StatusPill reflects connected state.
    it("shows the terminal status pill reflecting the connected state", async () => {
        expect(await terminalsPage.statusVisible()).toBe(true);
        // "connected" is the only state that lights the StatusPill's glowing dot (dot={status==="connected"}).
        await terminalsPage.waitForConnected(15_000);
        const label = await terminalsPage.statusText();
        expect(label.toLowerCase()).toContain("connected");
    });

    // Fix 6 (KEY): xterm.js Driver B opens — the binary-frame fix means the surface appears, no error.
    it("opens a terminal in Driver B (xterm.js WebView) after switching engines", async () => {
        await terminalsPage.closeTerminal();
        expect(await terminalsPage.isDriverSwitcherShown()).toBe(true);

        await terminalsPage.selectDriver("webview-html");
        expect(await terminalsPage.isDriverOptionVisible("webview-html")).toBe(true);

        const [name] = await terminalsPage.tmuxSessionNames();
        expect(name).toBeDefined();

        // Generous wait: cold xterm.js host page + ttyd socket. The fix makes this surface appear
        // (previously a malformed-base64 throw left Driver B erroring instead of rendering).
        await terminalsPage.openTmuxSession(name, { surfaceTimeout: 25_000 });
        expect(await terminalsPage.terminalSurfaceVisible(25_000)).toBe(true);
    });

    // Fix 7: swipe-to-reveal actions exist (table rows render) with always-present inline fallbacks.
    it("renders table-style ttyd rows with reachable inline actions (swipe fallback)", async () => {
        await terminalsPage.closeTerminal();
        expect(await terminalsPage.isShown()).toBe(true);

        const ids = await terminalsPage.ttydSessionIds();
        expect(ids.length).toBeGreaterThan(0);
        const [id] = ids;

        // The table row surface renders (the swipe gesture path wraps this same row).
        expect(await terminalsPage.ttydRowExists(id)).toBe(true);

        // Inline action buttons are always in the tree (hidden swipe Pressables share the testID),
        // so they are reachable without performing the gesture.
        expect(await terminalsPage.ttydOpenButtonExists(id)).toBe(true);
    });

    // Fix 8: cmux panes useful — the cmux section + (when present) workspace selector and pane rows render.
    it("renders a useful cmux section (header + pane rows / workspace selector when multi-workspace)", async () => {
        expect(await terminalsPage.cmuxHeaderVisible()).toBe(true);

        // The workspace tab selector renders ONLY with >1 workspace; when present, each id is reachable.
        const workspaceIds = await terminalsPage.cmuxWorkspaceIds();
        for (const wsId of workspaceIds) {
            expect(await terminalsPage.cmuxWorkspaceExists(wsId)).toBe(true);
        }

        // The active workspace's panes are the visible rows; if cmux is available at least one renders.
        const paneIds = await terminalsPage.cmuxPaneIds();
        if (paneIds.length > 0) {
            expect(await terminalsPage.cmuxPaneRowExists(paneIds[0])).toBe(true);
        }
    });
});
