import { BasePage } from "@e2e/pages/base.page";

export type QaFacet = "project" | "tag";

/** The two facet values are treated as "connected" by the live dot (open subscription or live rows). */
const CONNECTED_TONES = ["open", "live"];

/**
 * Page Object for the QA live-stream tab. The screen root is `screen-qa` (rendered by the route file
 * `app/(tabs)/qa.tsx`). The live indicator exposes its raw status as the element's accessibility
 * VALUE (`qa-live-indicator`, value ∈ "connecting" | "open" | "live"), so liveness is asserted on the
 * value, not mere visibility. Filter chips use the `qa-<facet>-all` (pinned) + `qa-<facet>-<value>`
 * (scrolled) testIDs; the chip's visible text is the raw facet value (no case transform), so casing is
 * asserted via `getText`. Answer bodies share one `qa-answer-<id>` testID for both the collapsed
 * preview text and the expanded WebView container; expansion is driven by the `qa-expand-<id>` button.
 * Mirrors the ObsidianPage convention (extend BasePage, singleton export, WebView surface checked via
 * the container testID's existence since the inner DOM is opaque to the a11y tree).
 */
class QaPage extends BasePage {
	private readonly ids = {
		screen: "screen-qa",
		loading: "qa-loading",
		liveIndicator: "qa-live-indicator",
		search: "qa-search",
		projectAll: "qa-project-all",
		tagAll: "qa-tag-all",
		mockBadge: "mock-data-badge",
	} as const;

	async isShown(): Promise<boolean> {
		return this.isVisible(this.ids.screen);
	}

	async waitForLoaded(timeout = this.defaultTimeout): Promise<void> {
		await this.waitForVisible(this.ids.screen, timeout);
	}

	async isLiveIndicatorShown(): Promise<boolean> {
		return this.isVisible(this.ids.liveIndicator);
	}

	/** The live dot's raw status, surfaced as its accessibility VALUE ("connecting" | "open" | "live"). */
	async liveStatus(): Promise<string> {
		return (await this.getAttribute(this.ids.liveIndicator, "value")) ?? "";
	}

	isConnectedStatus(status: string): boolean {
		return CONNECTED_TONES.includes(status);
	}

	/** Poll until the live status leaves "connecting" (the bug-fix: it must reach open/live). */
	async waitForLiveSettled(timeout = 20_000): Promise<void> {
		await this.waitUntil(
			async () => {
				const status = await this.liveStatus().catch(() => "");
				return status.length > 0 && status !== "connecting";
			},
			{ timeout, message: "QA live indicator stayed on 'connecting'" },
		);
	}

	allChipId(facet: QaFacet): string {
		return `qa-${facet}-all`;
	}

	chipId(facet: QaFacet, value: string): string {
		return `qa-${facet}-${value}`;
	}

	async isAllChipShown(facet: QaFacet): Promise<boolean> {
		return this.isVisible(this.allChipId(facet));
	}

	async isChipShown(facet: QaFacet, value: string): Promise<boolean> {
		return this.isVisible(this.chipId(facet, value));
	}

	async chipExists(facet: QaFacet, value: string): Promise<boolean> {
		return this.isExisting(this.chipId(facet, value));
	}

	async tapChip(facet: QaFacet, value: string): Promise<void> {
		await this.tap(this.chipId(facet, value));
	}

	async tapAllChip(facet: QaFacet): Promise<void> {
		await this.tap(this.allChipId(facet));
	}

	async searchText(term: string): Promise<void> {
		await this.type(this.ids.search, term);
	}

	private async pageSource(): Promise<string> {
		return driver.getPageSource();
	}

	/** Distinct facet values currently present as chips (scraped from the a11y tree's testIDs). */
	async discoverFacetValues(facet: QaFacet, limit = 8): Promise<string[]> {
		const source = await this.pageSource();
		const pattern = new RegExp(`qa-${facet}-([^"'\\s\\]<>]+)`, "g");
		const values: string[] = [];
		let match = pattern.exec(source);
		while (match !== null && values.length < limit) {
			const value = match[1];
			if (value !== "all" && !values.includes(value)) {
				values.push(value);
			}

			match = pattern.exec(source);
		}

		return values;
	}

	/** Distinct QA entry ids currently rendered as cards (scraped from `qa-card-<id>` testIDs). */
	async discoverCardIds(limit = 8): Promise<string[]> {
		const source = await this.pageSource();
		const pattern = /qa-card-([^"'\s\]<>]+)/g;
		const ids: string[] = [];
		let match = pattern.exec(source);
		while (match !== null && ids.length < limit) {
			const id = match[1];
			if (!ids.includes(id)) {
				ids.push(id);
			}

			match = pattern.exec(source);
		}

		return ids;
	}

	async waitForAnyCard(timeout = 20_000): Promise<string> {
		let firstId = "";
		await this.waitUntil(
			async () => {
				const ids = await this.discoverCardIds(1);
				if (ids.length > 0) {
					firstId = ids[0];
					return true;
				}

				return false;
			},
			{ timeout, message: "No QA cards appeared" },
		);
		return firstId;
	}

	cardId(id: string): string {
		return `qa-card-${id}`;
	}

	answerId(id: string): string {
		return `qa-answer-${id}`;
	}

	expandId(id: string): string {
		return `qa-expand-${id}`;
	}

	async isCardShown(id: string): Promise<boolean> {
		return this.isVisible(this.cardId(id));
	}

	async hasExpandButton(id: string): Promise<boolean> {
		return this.isExisting(this.expandId(id));
	}

	/** Collapsed answer preview text (shares the `qa-answer-<id>` testID with the expanded WebView). */
	async answerText(id: string): Promise<string> {
		return this.getText(this.answerId(id));
	}

	async isAnswerShown(id: string): Promise<boolean> {
		return this.isExisting(this.answerId(id));
	}

	async tapExpand(id: string): Promise<void> {
		await this.tap(this.expandId(id));
	}

	/** Find a card whose answer is rich/long enough to mount a WebView on expand, else "". */
	async findExpandableCardId(): Promise<string> {
		const ids = await this.discoverCardIds();
		for (const id of ids) {
			if (await this.hasExpandButton(id)) {
				return id;
			}
		}

		return "";
	}
}

export const qaPage = new QaPage();
