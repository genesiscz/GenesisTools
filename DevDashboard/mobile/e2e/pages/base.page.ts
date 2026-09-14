import type { ChainablePromiseElement } from "webdriverio";

/**
 * Page Object base. Locates elements by accessibility id (the `~` selector) — the
 * preferred, most stable Appium locator. Screen roots and interactive elements in the app
 * set `accessibilityLabel`/`testID` (e.g. `screen-pulse`, `connect-submit`); native
 * tab-bar buttons are located by their visible label instead (see AppPage).
 *
 * Convention (D21): every feature gets a `*.page.ts` that extends this base + a singleton
 * export, and a `*.spec.ts` that drives it. Feature page objects should lean on the helpers
 * here (tap/type/getText/scrollIntoView/waitForVisible/retry) rather than re-deriving them,
 * so all specs share one set of timing/retry semantics.
 *
 * STABILITY CONTRACT: the four parallel feature agents (terminals/qa/obsidian/rest) subclass
 * this base and write specs off the same commit. Its public API is therefore append-only —
 * EXTEND with new helpers, never change/rename `byId`, `waitForVisible`, or `isVisible`.
 */
export abstract class BasePage {
    /** Default time (ms) helpers wait for an element before giving up. */
    protected readonly defaultTimeout = 10_000;

    /** Resolve an element by accessibility id (RN `testID`/`accessibilityLabel` → the `~` selector). */
    protected byId(id: string): ChainablePromiseElement {
        return $(`~${id}`);
    }

    /** Wait until the element with `id` is rendered AND displayed (visible in the viewport). */
    async waitForVisible(id: string, timeout = this.defaultTimeout): Promise<void> {
        await this.byId(id).waitForDisplayed({ timeout });
    }

    /** Wait until the element with `id` exists in the a11y tree (may be off-screen / not yet laid out). */
    async waitForExist(id: string, timeout = this.defaultTimeout): Promise<void> {
        await this.byId(id).waitForExist({ timeout });
    }

    /** Wait until the element with `id` is gone from the viewport (e.g. a spinner that finished). */
    async waitForGone(id: string, timeout = this.defaultTimeout): Promise<void> {
        await this.byId(id).waitForDisplayed({ timeout, reverse: true });
    }

    /** True if currently displayed. Does NOT wait — pair with `waitForVisible` when you need to gate. */
    async isVisible(id: string): Promise<boolean> {
        return this.byId(id).isDisplayed();
    }

    /** True if present in the a11y tree (rendered) regardless of on-screen visibility. */
    async isExisting(id: string): Promise<boolean> {
        return this.byId(id).isExisting();
    }

    /** Wait for the element to be displayed, then tap it. The default interaction for buttons/cells. */
    async tap(id: string, timeout = this.defaultTimeout): Promise<void> {
        await this.waitForVisible(id, timeout);
        await this.byId(id).click();
    }

    /**
     * Wait for a text input to be displayed, then set its value. Clears existing content first
     * (`setValue` replaces; use `addValue` via `appendText` to append). Dismisses the keyboard after.
     */
    async type(id: string, text: string, timeout = this.defaultTimeout): Promise<void> {
        await this.waitForVisible(id, timeout);
        await this.byId(id).setValue(text);
    }

    /** Append to a text input without clearing it. */
    async appendText(id: string, text: string, timeout = this.defaultTimeout): Promise<void> {
        await this.waitForVisible(id, timeout);
        await this.byId(id).addValue(text);
    }

    /** Read the visible text of an element (e.g. a KPI value, a badge label). */
    async getText(id: string, timeout = this.defaultTimeout): Promise<string> {
        await this.waitForExist(id, timeout);
        return this.byId(id).getText();
    }

    /** Read a single accessibility/native attribute (e.g. `value`, `label`, `enabled`). */
    async getAttribute(id: string, attribute: string, timeout = this.defaultTimeout): Promise<string | null> {
        await this.waitForExist(id, timeout);
        return this.byId(id).getAttribute(attribute);
    }

    /**
     * Scroll the element into view, then return it. WebdriverIO's `scrollIntoView` works on the
     * XCUITest/UiAutomator2 native context via element-relative scroll gestures; pair with `tap`
     * for off-screen controls (`await page.scrollIntoView(id); await page.tap(id)`).
     */
    async scrollIntoView(id: string, timeout = this.defaultTimeout): Promise<ChainablePromiseElement> {
        const el = this.byId(id);
        await el.waitForExist({ timeout });
        await el.scrollIntoView();
        return el;
    }

    /** Scroll an off-screen control into view and tap it, in one call. */
    async scrollAndTap(id: string, timeout = this.defaultTimeout): Promise<void> {
        await this.scrollIntoView(id, timeout);
        await this.byId(id).click();
    }

    /**
     * Generic retry around any flaky async predicate/action. Re-invokes `fn` until it resolves
     * without throwing (or returns a truthy value), backing off between attempts. Use for
     * inherently racy steps where `waitForVisible` does not fit (e.g. a probe that may need a
     * couple of polls). Throws the last error after `attempts`.
     */
    async retry<T>(fn: () => Promise<T>, { attempts = 3, delayMs = 500 }: { attempts?: number; delayMs?: number } = {}): Promise<T> {
        let lastError: unknown;
        for (let i = 0; i < attempts; i++) {
            try {
                return await fn();
            } catch (err) {
                lastError = err;
                if (i < attempts - 1) {
                    await browser.pause(delayMs);
                }
            }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /**
     * Poll `condition` until it returns true (WDIO's `waitUntil`, surfaced here so feature pages
     * get a consistent timeout default + message). Use for app-state transitions that are not a
     * single element appearing — e.g. "reachability flips to reachable".
     */
    async waitUntil(condition: () => Promise<boolean>, { timeout = this.defaultTimeout, message }: { timeout?: number; message?: string } = {}): Promise<void> {
        await browser.waitUntil(condition, { timeout, timeoutMsg: message });
    }
}
