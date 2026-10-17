import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { probe } from "./cdp";
import { launchHeadlessChrome } from "./headless";
import { closeBrowserOnPort } from "./launch";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HAS_CHROME = process.platform === "darwin" && existsSync(CHROME);

/**
 * Chrome keeps its per-launch app copies beside the user's temp folder (`/var/folders/<a>/<b>/X`). Not `tmpdir()`:
 * the test wrapper points TMPDIR at a scratch folder.
 */
function clonesDir(): string {
    const temp = Bun.spawnSync(["getconf", "DARWIN_USER_TEMP_DIR"], { env: process.env }).stdout.toString().trim();
    return join(temp, "..", "X", "com.google.Chrome.code_sign_clone");
}

/** Runs both quit paths, checking that the browser exits and creates no per-launch app copy. */
async function copyDeletedAfter(quit: (port: number) => Promise<void>) {
    const CLONES = clonesDir();
    const clones = () => (existsSync(CLONES) ? readdirSync(CLONES) : []);
    const before = clones();
    const chrome = await launchHeadlessChrome();
    let made: string[];
    try {
        made = clones().filter((name) => !before.includes(name));
        expect(made).toEqual([]);
        await quit(chrome.port);
    } finally {
        await chrome.close();
    }

    return (await probe(chrome.port)) === null && made.every((name) => !existsSync(join(CLONES, name)));
}

describe.skipIf(!HAS_CHROME)("launchHeadlessChrome", () => {
    test("close quits Chrome without leaving a per-launch app copy", async () => {
        expect(await copyDeletedAfter(async () => {})).toBe(true);
    }, 30_000);

    test("closeBrowserOnPort quits an unowned browser without leaving a per-launch app copy", async () => {
        const deleted = await copyDeletedAfter(async (port) => {
            expect(await closeBrowserOnPort({ port })).toMatchObject({ status: "closed" });
        });
        expect(deleted).toBe(true);
    }, 30_000);

    test("a launch makes no copy of the app (MacAppCodeSignClone is off)", async () => {
        // Before the switch every launch copied the 1.4 GB app here, and a run that was killed left the copy behind.
        const CLONES = clonesDir();
        const clones = () => (existsSync(CLONES) ? readdirSync(CLONES) : []);
        const before = clones();
        const chrome = await launchHeadlessChrome();
        try {
            expect(clones().filter((name) => !before.includes(name))).toEqual([]);
        } finally {
            await chrome.close();
        }
    }, 30_000);

    test("closeBrowserOnPort quits a browser this process does not own", async () => {
        const chrome = await launchHeadlessChrome();
        try {
            expect(await closeBrowserOnPort({ port: chrome.port })).toMatchObject({ status: "closed" });
        } finally {
            await chrome.close();
        }
    }, 30_000);
});
