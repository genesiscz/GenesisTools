export interface NotificationOptions {
	title: string;
	message: string;
	subtitle?: string;
	sound?: string;
}

/**
 * Send a macOS notification asynchronously (fire and forget).
 */
export function sendNotification(opts: NotificationOptions): void {
	const escaped = (s: string) =>
		s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
	const params = [
		`"${escaped(opts.message)}"`,
		`with title "${escaped(opts.title)}"`,
		opts.subtitle ? `subtitle "${escaped(opts.subtitle)}"` : "",
		`sound name "${escaped(opts.sound ?? "default")}"`,
	]
		.filter(Boolean)
		.join(" ");

	// Fire and forget — don't block
	Bun.spawn(["osascript", "-e", `display notification ${params}`], {
		stdout: "ignore",
		stderr: "ignore",
	});
}
