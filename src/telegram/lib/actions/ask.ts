import { runTool } from "@app/utils/cli/tools";
import type { ActionHandler } from "../types";
import { DEFAULTS } from "../types";

export const handleAsk: ActionHandler = async (message, contact, client) => {
	const start = performance.now();
	const typing = client.startTypingLoop(contact.userId);

	try {
		const systemPrompt = contact.askSystemPrompt;
		const promptText = message.contentForLLM;

		const result = await runTool(
			["ask", "--system-prompt", systemPrompt, "--format", "text", "--", promptText],
			{ timeout: DEFAULTS.askTimeoutMs },
		);

		typing.stop();

		if (!result.success || !result.stdout) {
			return {
				action: "ask",
				success: false,
				duration: performance.now() - start,
				error: result.stderr || "Empty LLM response",
			};
		}

		await Bun.sleep(contact.randomDelay);

		await client.sendMessage(contact.userId, result.stdout);

		return {
			action: "ask",
			success: true,
			reply: result.stdout,
			duration: performance.now() - start,
		};
	} catch (err) {
		typing.stop();

		return {
			action: "ask",
			success: false,
			duration: performance.now() - start,
			error: err,
		};
	}
};
