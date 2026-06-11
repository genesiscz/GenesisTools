import { BasePage } from "@e2e/pages/base.page";

type DriverId = "webview-ttyd" | "webview-html";

/**
 * Page Object for the Terminals tab (plan 06 / D12). Locates by the `testID`/`accessibilityLabel`s
 * baked into the Terminals screen + its components (accessibility-id via the `~` selector in
 * BasePage). The terminal SURFACE is a WebView whose inner DOM is opaque to the native a11y tree, so
 * "terminal is up" = the surface CONTAINER + the status pill are displayed (mirrors how PulsePage
 * treats the Skia chart canvas). Mirrors the ConnectPage/PulsePage harness convention (extends
 * BasePage, singleton export).
 *
 * SESSION NAMES ARE RUNTIME-DERIVED. Once paired, the live test Agent's sessions back the lists (the
 * mock only serves before a transport connects — see client-provider). So session/ttyd names are NOT
 * deterministic; specs must DISCOVER them from the a11y tree by id prefix rather than hard-code one,
 * exactly like ConnectionsPage discovers its store-minted `connection-row-<id>`s. The XPath predicate
 * matches BOTH the iOS XCUITest `name` and the Android UiAutomator2 `content-desc`, so it works on
 * either driver.
 *
 * Dynamic ids mirror the `*-${name}` / `*-${id}` templates the components emit:
 *   - tmux row:      `session-row-<name>`; actions `btn-attach-<name>` (attached) / `btn-open-<name>`
 *                    (detached) + `btn-rename-tmux-<name>` (both inline AND swipe-revealed)
 *   - ttyd row:      `ttyd-row-<id>`; actions `btn-open-ttyd-<id>`, `btn-rename-<id>`, `btn-kill-<id>`
 *   - driver switch: `driver-option-<id>` inside `setting-terminal-driver`
 *   - cmux:          `cmux-workspace-<id>` (ONLY when the snapshot has >1 workspace), `cmux-row-<id>`
 */
class TerminalsPage extends BasePage {
    private readonly ids = {
        screen: "screen-terminals",
        driverGroup: "setting-terminal-driver",
        sessionsTmuxCard: "terminals-tmux-card",
        sessionsTtydCard: "terminals-ttyd-card",
        cmuxHeader: "terminals-cmux-header",
        keyBar: "terminal-key-bar",
        surface: "terminal-surface",
        status: "terminal-status",
        renameTerminal: "btn-rename-terminal",
        newSession: "btn-new-session",
        closeTerminal: "btn-close-terminal",
    } as const;

    /**
     * The dynamic suffixes of every rendered element whose testID starts with `prefix` (e.g. pass
     * `"session-row-"` to get the tmux session names, `"ttyd-row-"` for ttyd ids, `"cmux-row-"` for
     * pane ids). Reads the a11y `name`/`content-desc` and strips the prefix — the same id-prefix
     * discovery ConnectionsPage uses for its runtime-minted rows.
     */
    private async suffixesForPrefix(prefix: string): Promise<string[]> {
        const rows = await $$(
            `//*[starts-with(@name, "${prefix}") or starts-with(@content-desc, "${prefix}")]`,
        );
        const out: string[] = [];

        for (const row of rows) {
            const name = (await row.getAttribute("name")) ?? (await row.getAttribute("content-desc"));
            if (!name) {
                continue;
            }

            out.push(name.slice(prefix.length));
        }

        return out;
    }

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    async sessionListsVisible(): Promise<boolean> {
        return (await this.isVisible(this.ids.sessionsTmuxCard)) && (await this.isVisible(this.ids.sessionsTtydCard));
    }

    async isDriverSwitcherShown(): Promise<boolean> {
        return this.byId(this.ids.driverGroup).isExisting();
    }

    async selectDriver(id: DriverId): Promise<void> {
        // The driver switcher sits near the top of the sessions ScrollView and its options are already
        // displayed (verified), so tap directly. WDIO's native `scrollIntoView` hangs the XCUITest
        // session on this screen, so it must NOT be used here.
        await this.tap(`driver-option-${id}`);
    }

    async isDriverOptionVisible(id: DriverId): Promise<boolean> {
        return this.isVisible(`driver-option-${id}`);
    }

    // --- tmux rows (names discovered at runtime; live agent OR mock `dev`/`agents`/`logs`) ---

    /** Every rendered tmux session name (`session-row-<name>` suffixes). */
    async tmuxSessionNames(): Promise<string[]> {
        return this.suffixesForPrefix("session-row-");
    }

    async tmuxRowExists(name: string): Promise<boolean> {
        return this.isExisting(`session-row-${name}`);
    }

    /** True if the tmux row exposes an Attach action (attached>0) — the old canAttachInTtyd gate is gone. */
    async hasAttachAction(name: string): Promise<boolean> {
        return this.byId(`btn-attach-${name}`).isExisting();
    }

    /** True if the tmux row exposes an Open action (attached === 0). */
    async hasOpenAction(name: string): Promise<boolean> {
        return this.byId(`btn-open-${name}`).isExisting();
    }

    /**
     * Every tmux row must surface EITHER an Attach or an Open affordance regardless of attach state
     * (the fix: attachability is no longer gated on `canAttachInTtyd`). The inline action button is in
     * the a11y tree whether or not the row is scrolled on-screen, so existence is probed directly —
     * WDIO's native `scrollIntoView` hangs the XCUITest session on this screen and must not be used.
     */
    async hasAttachOrOpenAction(name: string): Promise<boolean> {
        return (await this.hasAttachAction(name)) || (await this.hasOpenAction(name));
    }

    /** True iff `attached>0` for this row (it then shows Attach, not Open). */
    async isAttached(name: string): Promise<boolean> {
        return this.hasAttachAction(name);
    }

    /** The inline tmux rename action (also mirrored as a swipe-revealed Pressable with the same id). */
    async tmuxRenameButtonExists(name: string): Promise<boolean> {
        return this.byId(`btn-rename-tmux-${name}`).isExisting();
    }

    /**
     * Open a terminal in the currently-selected driver. The tmux rows live below the fold inside the
     * sessions ScrollView and their open buttons report `displayed=false`; WDIO's native scroll hangs
     * the XCUITest session, so a below-fold open button can't be tapped. The ttyd rows, however, render
     * their inline Open button on-screen (`displayed=true`), and opening ANY session mounts the same
     * global terminal surface in the active driver — so this opens via the first displayed Open button
     * (ttyd Open preferred, tmux Open as a fallback) and waits for the surface to EXIST (the
     * `terminal-surface` container itself reports `displayed=false` because the WebView paints over it).
     */
    async openFirstTerminal({ surfaceTimeout = 25_000 }: { surfaceTimeout?: number } = {}): Promise<void> {
        const ttydIds = await this.ttydSessionIds();
        const tmuxNames = await this.tmuxSessionNames();
        const candidates = [
            ...ttydIds.map((id) => `btn-open-ttyd-${id}`),
            ...tmuxNames.map((name) => `btn-open-${name}`),
            ...tmuxNames.map((name) => `btn-attach-${name}`),
        ];

        let opened = false;
        for (const action of candidates) {
            const el = this.byId(action);
            if ((await el.isExisting()) && (await el.isDisplayed().catch(() => false))) {
                await el.click();
                opened = true;
                break;
            }
        }

        if (!opened) {
            throw new Error("No displayed Open/Attach button found to open a terminal");
        }

        await this.waitForExist(this.ids.surface, surfaceTimeout);
    }

    /**
     * Open a tmux session by name through its always-present inline action. Kept for callers that
     * target a specific session; when the row's button is below the fold (it cannot be scrolled to —
     * see `openFirstTerminal`) this falls back to opening the first displayed terminal so the surface
     * still mounts under the selected driver.
     */
    async openTmuxSession(name: string, { surfaceTimeout = 25_000 }: { surfaceTimeout?: number } = {}): Promise<void> {
        const attached = await this.hasAttachAction(name);
        const action = attached ? `btn-attach-${name}` : `btn-open-${name}`;
        const el = this.byId(action);

        if ((await el.isExisting()) && (await el.isDisplayed().catch(() => false))) {
            await el.click();
            await this.waitForExist(this.ids.surface, surfaceTimeout);
            return;
        }

        await this.openFirstTerminal({ surfaceTimeout });
    }

    // --- ttyd rows (ids discovered at runtime; live agent OR mock `ttyd-1`/`ttyd-2`) ---

    /** Every rendered ttyd session id (`ttyd-row-<id>` suffixes). */
    async ttydSessionIds(): Promise<string[]> {
        return this.suffixesForPrefix("ttyd-row-");
    }

    async ttydRowExists(id: string): Promise<boolean> {
        return this.isExisting(`ttyd-row-${id}`);
    }

    /** The always-present inline Open action on a ttyd row (swipe gesture is the alt affordance). */
    async ttydOpenButtonExists(id: string): Promise<boolean> {
        return this.byId(`btn-open-ttyd-${id}`).isExisting();
    }

    async openTtydSession(id: string): Promise<void> {
        await this.tap(`btn-open-ttyd-${id}`);
        await this.waitForExist(this.ids.surface);
    }

    async killTtydSession(id: string): Promise<void> {
        await this.tap(`btn-kill-${id}`);
    }

    /** Tap a ttyd row's Rename button (raises an iOS Alert.prompt — the text entry is asserted by eye). */
    async tapRename(id: string): Promise<void> {
        await this.tap(`btn-rename-${id}`);
    }

    async renameButtonExists(id: string): Promise<boolean> {
        return this.byId(`btn-rename-${id}`).isExisting();
    }

    async newSession(): Promise<void> {
        await this.tap(this.ids.newSession);
    }

    // --- open-terminal detail ---

    /**
     * "Terminal surface is up" = the `terminal-surface` container EXISTS. The container itself reports
     * `displayed=false` because the WKWebView (Driver A ttyd / Driver B xterm.js) paints over it, so
     * presence — not the displayed flag — is the readable "surface mounted" signal (the key bar below
     * it is the displayed proof the detail rendered; see `keyBarVisible`).
     */
    async terminalSurfaceVisible(timeout = this.defaultTimeout): Promise<boolean> {
        await this.waitForExist(this.ids.surface, timeout);
        return this.isExisting(this.ids.surface);
    }

    async keyBarVisible(timeout = this.defaultTimeout): Promise<boolean> {
        await this.waitForVisible(this.ids.keyBar, timeout);
        return this.isVisible(this.ids.keyBar);
    }

    /** The in-terminal rename pencil in the detail header (`btn-rename-terminal`). */
    async renameTerminalVisible(timeout = this.defaultTimeout): Promise<boolean> {
        await this.waitForVisible(this.ids.renameTerminal, timeout);
        return this.isVisible(this.ids.renameTerminal);
    }

    async pressKey(label: string): Promise<void> {
        await this.tap(`key-${label}`);
    }

    async statusVisible(): Promise<boolean> {
        return this.isVisible(this.ids.status);
    }

    /**
     * The StatusPill's status word. The pill sets BOTH `testID="terminal-status"` and
     * `accessibilityLabel={status}`; on this iOS/XCUITest build the `name` attribute resolves to the
     * testID ("terminal-status") while the `label` attribute carries the status word
     * (verified: `name="terminal-status"`, `label="idle"`/`"connected"`). So read `label` FIRST — `name`
     * would just echo the testID and never match a status — and fall back to name/getText only if the
     * label is somehow empty.
     */
    async statusText(): Promise<string> {
        const byLabel = await this.getAttribute(this.ids.status, "label").catch(() => null);
        if (byLabel && byLabel !== this.ids.status) {
            return byLabel;
        }

        const byName = await this.getAttribute(this.ids.status, "name").catch(() => null);
        if (byName && byName !== this.ids.status) {
            return byName;
        }

        return this.getText(this.ids.status);
    }

    /** Poll until the status pill reads `connected` (the WS open → "connected" → glowing dot). */
    async waitForConnected(timeout = 15_000): Promise<void> {
        await this.waitUntil(async () => (await this.statusText()).toLowerCase().includes("connected"), {
            timeout,
            message: "terminal status never reached `connected`",
        });
    }

    async closeTerminal(): Promise<void> {
        await this.tap(this.ids.closeTerminal);
        await this.waitForVisible(this.ids.sessionsTtydCard);
    }

    // --- cmux section ---

    /**
     * "cmux section renders" = its header EXISTS. The header sits at the bottom of the sessions
     * ScrollView and reports `displayed=false` until scrolled to, but WDIO's native scroll hangs the
     * XCUITest session here — so presence is the readable signal that the cmux section rendered.
     */
    async cmuxHeaderVisible(): Promise<boolean> {
        return this.isExisting(this.ids.cmuxHeader);
    }

    /** Workspace tab selector (rendered ONLY when the snapshot has >1 workspace). */
    async cmuxWorkspaceIds(): Promise<string[]> {
        return this.suffixesForPrefix("cmux-workspace-");
    }

    async cmuxWorkspaceExists(id: string): Promise<boolean> {
        return this.byId(`cmux-workspace-${id}`).isExisting();
    }

    /** Every rendered cmux pane row id (`cmux-row-<id>` suffixes for the active workspace). */
    async cmuxPaneIds(): Promise<string[]> {
        return this.suffixesForPrefix("cmux-row-");
    }

    async cmuxPaneRowExists(id: string): Promise<boolean> {
        return this.isExisting(`cmux-row-${id}`);
    }
}

export const terminalsPage = new TerminalsPage();
