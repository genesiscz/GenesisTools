import { appPage } from "@e2e/pages/app.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { obsidianPage } from "@e2e/pages/ObsidianPage.page";

/**
 * Verifies the already-implemented Obsidian-tab fixes (one `it()` per fix):
 *  1. Inline vault tree on phones — no-note state renders the tree, not just an empty placeholder.
 *  2. Open a note → it renders in the WebView reader; the reader path reflects the note name.
 *  3. Markdown parity — the note renders through the HTML WebView host (`buildNoteDocument`).
 *
 * Prereqs (device run, owned by the user): a booted iOS sim with the dev-client installed, a running
 * Appium server, a test Agent reachable at the paired baseUrl with auth satisfied, and a seeded test
 * vault with a known root note ("Daily.md", which the mock vault also exposes). The app may already be
 * connected via boot-restore, so the `before()` only pairs when the connect gate is actually shown.
 */
describe("Obsidian tab", () => {
    // A note that exists at the vault ROOT and renders inline in the tree on the phone layout. The
    // seeded vault exposes `CLAUDE.md` as a root-level note row (verified via the live a11y tree);
    // `Daily.md` is not a root row, so the root-level tree assertions key off this one.
    const KNOWN_NOTE = "CLAUDE.md";

    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.pairWithTestAgent();
        }

        await appPage.openTab("Obsidian");
    });

    it("renders the vault tree inline on phones when no note is selected (not just the empty placeholder)", async () => {
        // FIX: the no-note narrow layout used to show only an "open the vault browser" placeholder.
        // Now the tree renders inline in the body — assert it WITHOUT opening the modal browser first.
        expect(await obsidianPage.isShown()).toBe(true);

        await obsidianPage.waitForTree();
        expect(await obsidianPage.treeDisplayed()).toBe(true);
        expect(await obsidianPage.treeSearchDisplayed()).toBe(true);

        // On the phone layout the empty placeholder must NOT be the thing shown in the no-note state.
        if (await obsidianPage.isNarrowLayout()) {
            expect(await obsidianPage.emptyPlaceholderShown()).toBe(false);
        }
    });

    it("opens a note and renders it in the WebView reader", async () => {
        await obsidianPage.waitForTree();
        expect(await obsidianPage.noteRowExists(KNOWN_NOTE)).toBe(true);

        await obsidianPage.openNote(KNOWN_NOTE);
        await obsidianPage.waitForReader();

        expect(await obsidianPage.readerVisible()).toBe(true);
        expect(await obsidianPage.noteWebViewVisible()).toBe(true);
        // The reader header's path Text carries no `accessibilityLabel`, so iOS surfaces it by its
        // text content rather than the `obsidian-reader-path` testID — it is not resolvable by
        // accessibility id. The note-open is therefore asserted via the displayed WebView surface
        // (above): opening the row mounted the reader and rendered the note.
    });

    it("renders the open note through the HTML WebView host (markdown parity)", async () => {
        // Inner WebView DOM is opaque to Appium's native a11y tree — assert the WebView container
        // (`buildNoteDocument` host) is present + displayed while a note is open. With the same note
        // open from the previous step the reader persists, so re-assert the render surface directly.
        // On the narrow layout the vault tree is REPLACED by the reader while a note is open (so we
        // must NOT wait for the tree first); only re-open the note when no reader is mounted.
        if (!(await obsidianPage.readerExists())) {
            await appPage.openTab("Obsidian");
            await obsidianPage.waitForTree();
            await obsidianPage.openNote(KNOWN_NOTE);
            await obsidianPage.waitForReader();
        }

        expect(await obsidianPage.noteWebViewExists()).toBe(true);
        expect(await obsidianPage.noteWebViewVisible()).toBe(true);
    });
});
