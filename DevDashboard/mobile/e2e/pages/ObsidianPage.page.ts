import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Obsidian tab (plan 08 feature). Locates by the `testID`s baked into the screen
 * + its components (accessibility-id via the `~` selector in BasePage). Mirrors the `PulsePage`
 * harness convention (extends BasePage, singleton export).
 *
 * Tab navigation: the shared `app.page.ts` `TabName`/`TAB_SCREEN` map now includes "Obsidian"
 * (`appPage.openTab("Obsidian")` is valid), but this page keeps its own `~Obsidian` label navigation
 * via `open()` for encapsulation.
 *
 * INLINE-TREE FIX (narrow layout): when no note is selected on a phone, `obsidian.tsx` renders the
 * vault tree (`obsidian-tree-list`) INLINE in the body — NOT the `obsidian-empty` placeholder. The
 * empty placeholder only appears in two cases: the wide split layout with no note selected, or the
 * narrow layout while the modal vault browser is open. The helpers below let a spec assert the inline
 * tree is reachable WITHOUT first opening the modal browser.
 */
class ObsidianPage extends BasePage {
    private readonly ids = {
        screen: "screen-obsidian",
        empty: "obsidian-empty",
        openBrowser: "obsidian-open-browser",
        vaultBrowser: "obsidian-vault-browser",
        closeBrowser: "obsidian-close-browser",
        treeList: "obsidian-tree-list",
        treeSearch: "obsidian-tree-search",
        reader: "obsidian-reader",
        readerPath: "obsidian-reader-path",
        noteWebViewWrap: "obsidian-note-webview-wrap",
        webview: "obsidian-note-webview",
        publish: "obsidian-publish",
        unpublish: "obsidian-unpublish",
        shareUrl: "obsidian-share-url",
        addFolder: "obsidian-add-folder",
        newFolderInput: "obsidian-new-folder-input",
        newFolderCreate: "obsidian-new-folder-create",
        newFolderCancel: "obsidian-new-folder-cancel",
    } as const;

    /**
     * Open the Obsidian tab via an expo-router deep link, then wait on the screen. The
     * `unstable-native-tabs` bar is not introspectable by XCUITest (no tappable element for a
     * `~Obsidian` label), so a deep link is the reliable navigation path (see app.page.ts).
     */
    async open(): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: "devdashboard:///obsidian",
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForVisible(this.ids.screen);
    }

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    /** Narrow layout: open the bottom-sheet vault browser. No-op safe on the wide split layout. */
    async openBrowserIfNarrow(): Promise<void> {
        const opener = this.byId(this.ids.openBrowser);

        if (await opener.isExisting()) {
            await opener.click();
            await this.byId(this.ids.vaultBrowser).waitForDisplayed({ timeout: 5000 });
        }
    }

    /** True only on the phone/narrow layout (the modal-browser opener exists there, not on wide). */
    async isNarrowLayout(): Promise<boolean> {
        return this.byId(this.ids.openBrowser).isExisting();
    }

    /**
     * Wait for the vault tree to render. The inline-tree fix means this works on a phone WITHOUT first
     * opening the modal browser (when no note is selected) — call this straight after `open()`.
     */
    async waitForTree(): Promise<void> {
        await this.byId(this.ids.treeList).waitForExist({ timeout: 10000 });
    }

    /** True when the vault tree list is displayed (visible in the viewport), not merely in the tree. */
    async treeDisplayed(): Promise<boolean> {
        return this.byId(this.ids.treeList).isDisplayed();
    }

    /** True when the search box of the inline/modal tree is displayed (a second tree affordance). */
    async treeSearchDisplayed(): Promise<boolean> {
        return this.byId(this.ids.treeSearch).isDisplayed();
    }

    /** True when the "no note selected" empty placeholder is in the a11y tree. */
    async emptyPlaceholderShown(): Promise<boolean> {
        return this.byId(this.ids.empty).isExisting();
    }

    async expandFolder(relativePath: string): Promise<void> {
        const folder = this.byId(`obsidian-folder-${relativePath}`);
        await folder.waitForDisplayed({ timeout: 5000 });
        await folder.click();
    }

    /** True when a given note row is present in the rendered tree (inline or modal). */
    async noteRowExists(relativePath: string): Promise<boolean> {
        return this.byId(`obsidian-note-${relativePath}`).isExisting();
    }

    async openNote(relativePath: string): Promise<void> {
        const item = this.byId(`obsidian-note-${relativePath}`);
        await item.waitForDisplayed({ timeout: 5000 });
        await item.click();
    }

    /**
     * Wait for the reader to mount after opening a note. The `obsidian-reader` container and its
     * `obsidian-note-webview-wrap` both report `displayed=false` on iOS (the WKWebView paints over
     * them), so gate on the reader root EXISTING plus the inner `obsidian-note-webview` being
     * displayed — the one element in the reader subtree the XCUITest tree reports as on-screen
     * (verified: reader/wrap `displayed=false`, inner webview `displayed=true`).
     */
    async waitForReader(): Promise<void> {
        await this.byId(this.ids.reader).waitForExist({ timeout: 10000 });
        await this.byId(this.ids.webview).waitForDisplayed({ timeout: 10000 });
    }

    async search(query: string): Promise<void> {
        await this.byId(this.ids.treeSearch).setValue(query);
    }

    /**
     * "Reader is up" = the reader root exists and its inner WebView is displayed. The reader/wrap
     * Views themselves report `displayed=false` (the WKWebView covers them), so visibility is asserted
     * via the displayed child rather than the container.
     */
    async readerVisible(): Promise<boolean> {
        return (await this.byId(this.ids.reader).isExisting()) && (await this.byId(this.ids.webview).isDisplayed());
    }

    async readerExists(): Promise<boolean> {
        return this.byId(this.ids.reader).isExisting();
    }

    /** True when the note WebView render surface is displayed (the inner `obsidian-note-webview`). */
    async noteWebViewVisible(): Promise<boolean> {
        return this.byId(this.ids.webview).isDisplayed();
    }

    /** True when the inner WebView element exists (the markdown-parity render surface). */
    async noteWebViewExists(): Promise<boolean> {
        return this.byId(this.ids.webview).isExisting();
    }

    async readerPath(): Promise<string> {
        return (await this.byId(this.ids.readerPath).getText()).trim();
    }

    async tapPublish(): Promise<void> {
        await this.byId(this.ids.publish).click();
    }

    async waitForPublished(): Promise<void> {
        await this.byId(this.ids.unpublish).waitForDisplayed({ timeout: 8000 });
    }

    async tapUnpublish(): Promise<void> {
        await this.byId(this.ids.unpublish).click();
    }

    async waitForUnpublished(): Promise<void> {
        await this.byId(this.ids.publish).waitForDisplayed({ timeout: 8000 });
    }

    async createFolder(name: string): Promise<void> {
        await this.byId(this.ids.addFolder).click();
        await this.byId(this.ids.newFolderInput).setValue(name);
        await this.byId(this.ids.newFolderCreate).click();
    }
}

export const obsidianPage = new ObsidianPage();
