import { SafeJSON } from "@genesiscz/utils/json";
import { type BrowserLocator, type BugRecording, parseExpectation, parseRecording } from "./types";

export const EXPECTATION_MARKER = "BUG_TO_TEST_EXPECTATION";
const literal = (value: string) =>
    SafeJSON.stringify(value, { strict: true }).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
export function locatorExpression(locator: BrowserLocator): string {
    if (locator.kind === "testId") {
        return `page.getByTestId(${literal(locator.value)})`;
    }
    if (locator.kind === "role") {
        return `page.getByRole(${literal(locator.value)} as Parameters<typeof page.getByRole>[0], { name: ${literal(locator.name ?? "")}, exact: true })`;
    }
    return `page.locator(${literal(locator.value)})`;
}
export function generateRepro(input: BugRecording): string {
    const recording = parseRecording(input);
    const expectation = parseExpectation(recording.expectation);
    const lines = [
        `import { test, expect } from '@playwright/test';`,
        ``,
        `test(${literal(recording.title)}, async ({ page }) => {`,
        `    const remap = (url: string) => {`,
        `        const target = process.env.BUG_TO_TEST_BASE_URL;`,
        `        if (!target) return url;`,
        `        const original = new URL(url);`,
        `        return original.origin === ${literal(new URL(recording.initialUrl).origin)} ? new URL(original.pathname + original.search + original.hash, target).toString() : url;`,
        `    };`,
        `    await page.goto(remap(${literal(recording.initialUrl)}));`,
    ];
    for (const [index, action] of recording.actions.filter((item) => !item.excluded).entries()) {
        if (action.kind === "navigate") {
            lines.push(`    await page.goto(remap(${literal(action.url ?? "")}));`);
            continue;
        }
        const locator = locatorExpression(action.locator as BrowserLocator);
        lines.push(
            `    const step${index} = ${locator};`,
            `    await expect(step${index}, 'Recorded action ${index + 1} must resolve uniquely').toHaveCount(1);`,
            `    await expect(step${index}, 'Recorded action ${index + 1} must be visible').toBeVisible();`
        );
        const fingerprint = action.locator?.fingerprint;
        if (fingerprint) {
            lines.push(
                `    await expect(step${index}, 'Recorded target tag changed').toHaveJSProperty('tagName', ${literal(fingerprint.tag)});`
            );
            lines.push(
                `    const role${index} = await step${index}.evaluate(el => el.getAttribute('role') || ({BUTTON:'button',A:'link',SELECT:'combobox',TEXTAREA:'textbox'} as Record<string,string>)[el.tagName] || (el.tagName === 'INPUT' ? ({checkbox:'checkbox',radio:'radio',submit:'button',button:'button'} as Record<string,string>)[(el as HTMLInputElement).type] || 'textbox' : ''));`,
                `    expect(role${index}, 'Recorded target role changed').toBe(${literal(fingerprint.role)});`
            );
            if (fingerprint.name) {
                lines.push(
                    `    const name${index} = await step${index}.evaluate(el => (el.getAttribute('aria-label') || (el as HTMLInputElement).labels?.[0]?.textContent || (el as HTMLElement).innerText || el.getAttribute('alt') || '').trim().slice(0, 160));`,
                    `    expect(name${index}, 'Recorded target identity changed').toBe(${literal(fingerprint.name)});`
                );
            }
        }
        if (action.kind !== "press") {
            lines.push(`    await expect(step${index}, 'Recorded action ${index + 1} must be enabled').toBeEnabled();`);
        }
        const call = action.kind === "select" ? "selectOption" : action.kind;
        lines.push(`    await step${index}.${call}(${action.kind === "click" ? "" : literal(action.value ?? "")});`);
    }
    lines.push(`    await test.step('User expectation: ' + ${literal(expectation.description)}, async () => {`);
    const target = expectation.kind === "url" ? "page" : "target";
    if (expectation.kind !== "url") {
        lines.push(
            `        const target = ${locatorExpression(expectation.locator as BrowserLocator)};`,
            expectation.kind === "visible" && expectation.expected === "false"
                ? `        await expect.poll(() => target.count(), { message: 'Assertion target must not be ambiguous' }).toBeLessThanOrEqual(1);`
                : `        await expect(target, 'Assertion target must resolve uniquely').toHaveCount(1);`
        );
    }
    if (expectation.kind === "value") {
        lines.push(
            `        const isControl = await target.evaluate(el => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));`,
            `        expect(isControl, 'Value assertion requires a form control').toBe(true);`
        );
    }
    const matcher = {
        text: "toHaveText",
        value: "toHaveValue",
        visible: expectation.expected === "true" ? "toBeVisible" : "toBeHidden",
        url: "toHaveURL",
    }[expectation.kind];
    const expected =
        expectation.kind === "visible"
            ? ""
            : expectation.kind === "url"
              ? `remap(${literal(expectation.expected)})`
              : literal(expectation.expected);
    lines.push(
        `        await expect(${target}, '${EXPECTATION_MARKER}').${matcher}(${expected});`,
        `    });`,
        `});`,
        ``
    );
    return lines.join("\n");
}
export const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'repro.spec.ts', timeout: 15000, globalTimeout: 25000,
    retries: 0, workers: 1, reporter: [['json', { outputFile: process.env.BUG_TO_TEST_RUN_DIR ? process.env.BUG_TO_TEST_RUN_DIR + '/report.json' : 'report.json' }]],
    expect: { timeout: 1500 }, outputDir: process.env.BUG_TO_TEST_RUN_DIR ? process.env.BUG_TO_TEST_RUN_DIR + '/test-results' : 'test-results',
    use: { browserName: 'chromium', headless: true, trace: 'on', screenshot: 'only-on-failure',
        launchOptions: process.env.BUG_TO_TEST_BROWSER ? { executablePath: process.env.BUG_TO_TEST_BROWSER } : {} }
});
`;
