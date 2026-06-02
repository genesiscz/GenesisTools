import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Quick Commands screen. Locates by the `command-*` / `target-*` / `run-*`
 * testIDs (accessibility-id via the `~` selector in BasePage). Drives the full create → run flow and
 * the persist-across-refetch assertion. Specs call ONLY the public helpers here — never `byId`
 * (protected) or raw `$` — so all timing/retry semantics stay in BasePage.
 */
class QuickCommandsPage extends BasePage {
    private readonly ids = {
        screen: "screen-quick-commands",
        empty: "commands-empty",
        add: "command-add",
        sheet: "edit-command-sheet",
        inputLabel: "command-input-label",
        inputText: "command-input-text",
        save: "command-save",
        delete: "command-delete",
        cancel: "command-cancel",
        picker: "target-picker",
        runConfirmSheet: "run-confirm-sheet",
        runConfirm: "run-confirm",
        runCancel: "run-cancel",
    } as const;

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    cardId(id: string): string {
        return `command-card-${id}`;
    }

    runId(id: string): string {
        return `command-run-${id}`;
    }

    targetPickId(target: string): string {
        return `target-pick-${target}`;
    }

    /** Open the create sheet, fill label + command, save. Returns when the sheet closes. */
    async createCommand(label: string, command: string): Promise<void> {
        await this.tap(this.ids.add);
        await this.waitForVisible(this.ids.sheet);
        await this.type(this.ids.inputLabel, label);
        await this.type(this.ids.inputText, command);
        await this.tap(this.ids.save);
        await this.waitForGone(this.ids.sheet);
    }

    /** True when the seeded `cmd-tests` mock card is rendered. */
    async hasSeededCard(): Promise<boolean> {
        return this.isExisting(this.cardId("cmd-tests"));
    }

    /** True when the empty state is rendered (a real Agent with no snippets). */
    async isEmptyShown(): Promise<boolean> {
        return this.isExisting(this.ids.empty);
    }

    /** A card OR the empty state — the screen always resolves to one. */
    async hasCardOrEmpty(): Promise<boolean> {
        return (await this.hasSeededCard()) || (await this.isEmptyShown());
    }

    /** Run a snippet by id into a chosen target, then confirm. */
    async runInto(commandId: string, target: string): Promise<void> {
        await this.tap(this.runId(commandId));
        await this.waitForVisible(this.ids.picker);
        await this.tap(this.targetPickId(target));
        await this.waitForVisible(this.ids.runConfirm);
        await this.tap(this.ids.runConfirm);
    }

    /** True when a card with the given id exists (used for persist-across-refetch). */
    async cardExists(id: string): Promise<boolean> {
        return this.isExisting(this.cardId(id));
    }

    /** Wait for the run-confirm sheet to disappear (the run fired). */
    async waitForConfirmGone(): Promise<void> {
        await this.waitForGone(this.ids.runConfirmSheet);
    }

    async confirmSheetExists(): Promise<boolean> {
        return this.isExisting(this.ids.runConfirmSheet);
    }

    /**
     * True once a card whose visible label matches `label` is present. New cards get a
     * server-generated id (mock: `cmd-mock-<ts>`, real Agent: `cmd-<base36>`), so the persist check
     * cannot key on the id — it scans the a11y tree for the label text instead. Waits up to `timeout`.
     */
    async waitForLabelPresent(label: string, timeout = this.defaultTimeout): Promise<boolean> {
        return browser
            .waitUntil(
                async () =>
                    (await this.isVisible(this.ids.screen)) &&
                    (await $(`//*[contains(@label,"${label}")]`).isExisting()),
                { timeout, timeoutMsg: `card labeled "${label}" did not appear` },
            )
            .then(() => true)
            .catch(() => false);
    }
}

export const quickCommandsPage = new QuickCommandsPage();
