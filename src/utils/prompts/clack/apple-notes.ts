import { listAppleNotesFolders } from "@app/utils/macos/apple-notes";
import * as p from "@clack/prompts";

export async function pickAppleNotesFolder(): Promise<string> {
    const folders = listAppleNotesFolders();
    if (folders.length === 0) {
        throw new Error("No Apple Notes folders found.");
    }

    // Deduplicate by showing account name when there are name collisions
    const nameCount = new Map<string, number>();
    for (const f of folders) {
        nameCount.set(f.name, (nameCount.get(f.name) ?? 0) + 1);
    }

    const choices = folders
        .filter((f) => f.noteCount > 0 || !f.name.startsWith("Notes"))
        .map((f) => {
            const showAccount = (nameCount.get(f.name) ?? 0) > 1;
            const label = showAccount ? `${f.name} (${f.account})` : f.name;
            return {
                value: f.id,
                label,
                hint: `${f.noteCount} notes`,
            };
        });

    const selected = await p.select({
        message: "Select Apple Notes folder:",
        options: choices,
    });

    if (p.isCancel(selected)) {
        p.cancel("Cancelled.");
        process.exit(0);
    }

    return selected as string;
}
