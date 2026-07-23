/**
 * Per-test auth isolation. Mutating dashboard specs (devices / settings / subdomain / billing) each
 * need their OWN account so state from one spec never bleeds into another's assertions (the shared
 * storageState user is fine only for read-only specs). `freshUserContext` creates a brand-new browser
 * context, programmatically signs up a unique user against the REAL Better-Auth API (same endpoint the
 * UI uses, highest fidelity, zero app-source changes), and hands back an already-authed context.
 */

import { type Browser, type BrowserContext, type Locator, expect } from "@playwright/test";

export interface FreshUser {
    context: BrowserContext;
    email: string;
    password: string;
}

let counter = 0;

/** A process-unique email so parallel workers never collide on the unique-email constraint. */
function uniqueEmail(): string {
    counter += 1;
    return `e2e+${Date.now()}-${process.pid}-${counter}@devdashboard.app`;
}

/**
 * Sign up a fresh user via the API and return an authed context. The caller owns the context and must
 * `await user.context.close()` in afterEach (or rely on Playwright closing it at test end).
 */
export async function freshUserContext(browser: Browser): Promise<FreshUser> {
    const context = await browser.newContext({ baseURL: "http://127.0.0.1:7251" });
    const email = uniqueEmail();
    const password = "supersecret123";

    const res = await context.request.post("/api/auth/sign-up/email", {
        data: { email, password, name: "E2E Tester" },
    });

    expect(res.ok(), `sign-up should return 2xx, got ${res.status()}: ${await res.text()}`).toBeTruthy();

    return { context, email, password };
}

/**
 * Set a CONTROLLED input robustly against the vite dev server's slow per-route hydration.
 *
 * The trap: Playwright can set the DOM value BEFORE React hydrates the route. The DOM keeps the value
 * (so a naive `toHaveValue` passes), but React's `onChange` never fired, so the component's STATE stays
 * empty — and a tick later hydration resets the controlled input to that empty state. A subsequent
 * submit then reads "". So we must (a) drive change events that React will pick up once listeners are
 * attached, and (b) prove the value SURVIVES a hydration tick (not just that it's momentarily in the
 * DOM). The double-check with a gap catches the async controlled-reset; `pressSequentially` fires a
 * real `input` event per keystroke so `onChange` runs once hydrated.
 */
async function setHydrated(locator: Locator, apply: () => Promise<void>, value: string): Promise<void> {
    await locator.page().waitForLoadState("networkidle").catch(() => {});

    await expect(async () => {
        await apply();
        await expect(locator).toHaveValue(value);
        // If React hasn't bound state yet, hydration resets the field within a tick → second check fails.
        await locator.page().waitForTimeout(200);
        await expect(locator).toHaveValue(value);
    }).toPass({ timeout: 20_000 });
}

/** Fill a controlled text input and guarantee the value reached React state (see {@link setHydrated}). */
export async function fillHydrated(locator: Locator, value: string): Promise<void> {
    await setHydrated(
        locator,
        async () => {
            await locator.fill("");
            await locator.pressSequentially(value, { delay: 8 });
        },
        value,
    );
}

/** `selectOption` variant of {@link fillHydrated} — same hydration race on a controlled `<select>`. */
export async function selectHydrated(locator: Locator, value: string): Promise<void> {
    await setHydrated(locator, async () => void (await locator.selectOption(value)), value);
}

/**
 * Click a control and wait for an expected effect, retrying the click to absorb the dev server's
 * hydration lag (a click before the handler hydrates is a silent no-op). ONLY for IDEMPOTENT actions
 * (e.g. billing checkout in demo mode just re-renders a note) — never for create/delete.
 */
export async function clickUntil(locator: Locator, assertEffect: () => Promise<void>): Promise<void> {
    await expect(async () => {
        await locator.click();
        await assertEffect();
    }).toPass({ timeout: 15_000 });
}
