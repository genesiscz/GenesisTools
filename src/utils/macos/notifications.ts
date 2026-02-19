import { spawnSync } from "node:child_process";

export interface NotificationOptions {
	title: string;
	message: string;
	subtitle?: string;
	sound?: string;
}

export function sendNotification(opts: NotificationOptions): void {
	const escaped = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const params = [
		`"${escaped(opts.message)}"`,
		`with title "${escaped(opts.title)}"`,
		opts.subtitle ? `subtitle "${escaped(opts.subtitle)}"` : "",
		`sound name "${opts.sound ?? "default"}"`,
	]
		.filter(Boolean)
		.join(" ");

	spawnSync("osascript", ["-e", `display notification ${params}`]);
}
