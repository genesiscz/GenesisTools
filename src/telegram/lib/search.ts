import * as p from "@clack/prompts";
import pc from "picocolors";
import type { SearchResult } from "./types";

export function formatSearchResult(result: SearchResult, contactName: string): string {
	const msg = result.message;
	const date = new Date(msg.date_unix * 1000);
	const dateStr = date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
	const direction = msg.is_outgoing ? pc.blue("You") : pc.cyan(contactName);
	const text = msg.text || msg.media_desc || "(no text)";
	const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;

	let scoreLabel = "";

	if (result.score !== undefined) {
		scoreLabel = pc.dim(` [score: ${result.score.toFixed(4)}]`);
	} else if (result.distance !== undefined) {
		scoreLabel = pc.dim(` [dist: ${result.distance.toFixed(4)}]`);
	} else if (result.rank !== undefined) {
		scoreLabel = pc.dim(` [rank: ${result.rank.toFixed(2)}]`);
	}

	return `${pc.dim(dateStr)} ${direction}: ${preview}${scoreLabel}`;
}

export function displayResults(results: SearchResult[], contactName: string): void {
	if (results.length === 0) {
		p.log.warn("No results found.");
		return;
	}

	for (const result of results) {
		p.log.info(formatSearchResult(result, contactName));
	}
}
