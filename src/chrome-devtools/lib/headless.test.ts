import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launchHeadlessChrome } from "./headless";

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

describe.skipIf(!HAS_CHROME)("launchHeadlessChrome", () => {
    test("close quits Chrome so it deletes its own app copy", async () => {
        const CLONES = clonesDir();
        const clones = () => (existsSync(CLONES) ? readdirSync(CLONES) : []);
        const before = clones();
        const chrome = await launchHeadlessChrome();
        let made: string[];
        try {
            made = clones().filter((name) => !before.includes(name));
            expect(made).toHaveLength(1);
        } finally {
            await chrome.close();
        }

        // Chrome deletes the copy just after its process exits.
        for (let i = 0; i < 40 && existsSync(join(CLONES, made[0])); i++) {
            await Bun.sleep(100);
        }

        expect(existsSync(join(CLONES, made[0]))).toBe(false);
    }, 30_000);
});
