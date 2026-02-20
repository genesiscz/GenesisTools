import type { MessageRow } from "./types";

export type ExportFormat = "json" | "csv" | "txt";

export const VALID_EXPORT_FORMATS: ExportFormat[] = ["json", "csv", "txt"];

export function formatMessages(messages: MessageRow[], format: ExportFormat, contactName: string): string {
	switch (format) {
		case "json":
			return JSON.stringify(messages, null, 2);

		case "csv": {
			const header = "id,date,sender,direction,text,media";
			const rows = messages.map((m) => {
				const direction = m.is_outgoing ? "sent" : "received";
				const text = (m.text ?? "").replace(/"/g, '""').replace(/\n/g, "\\n");
				const media = (m.media_desc ?? "").replace(/"/g, '""');
				return `${m.id},"${m.date_iso}","${m.sender_id ?? ""}","${direction}","${text}","${media}"`;
			});
			return [header, ...rows].join("\n");
		}

		case "txt": {
			const lines = messages.map((m) => {
				const date = new Date(m.date_unix * 1000);
				const dateStr = date.toLocaleString("en-US", {
					year: "numeric",
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
				});
				const direction = m.is_outgoing ? "You" : contactName;
				const text = m.text || m.media_desc || "(no content)";
				return `[${dateStr}] ${direction}: ${text}`;
			});
			return lines.join("\n");
		}
	}
}
