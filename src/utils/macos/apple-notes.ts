/**
 * Apple Notes integration via JXA (JavaScript for Automation).
 * macOS only — uses osascript to interact with the Notes app.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

export interface AppleNotesFolder {
	name: string;
	id: string;
	noteCount: number;
	account: string;
}

function ensureMacOS(): void {
	if (process.platform !== "darwin") {
		throw new Error("Apple Notes is only available on macOS");
	}
}

function runJxa(script: string, timeout = 15_000): string {
	const proc = spawnSync("osascript", ["-l", "JavaScript", "-e", script], {
		encoding: "utf-8",
		timeout,
	});

	if (proc.status !== 0) {
		throw new Error(`JXA error: ${proc.stderr?.trim() || "unknown error"}`);
	}

	return proc.stdout.trim();
}

/**
 * List all Apple Notes folders across all accounts.
 */
export function listAppleNotesFolders(): AppleNotesFolder[] {
	ensureMacOS();

	const script = `
const Notes = Application("Notes");
const accounts = Notes.accounts();
const result = [];
for (const account of accounts) {
    const folders = account.folders();
    for (const f of folders) {
        result.push({
            name: f.name(),
            id: f.id(),
            noteCount: f.notes().length,
            account: account.name()
        });
    }
}
JSON.stringify(result);
`;

	return JSON.parse(runJxa(script));
}

/**
 * Create a note in a specific Apple Notes folder (by folder ID).
 * Uses a temp file to handle large content safely.
 */
export function createAppleNote(options: {
	folderId: string;
	title: string;
	body: string;
}): string {
	ensureMacOS();

	// Write body to temp file to avoid shell escaping issues with large content
	const tmpFile = `/tmp/apple-note-${Date.now()}.txt`;
	writeFileSync(tmpFile, options.body, "utf-8");

	const escapedTitle = options.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const escapedFolderId = options.folderId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

	const script = `
ObjC.import("Foundation");
const Notes = Application("Notes");
const data = $.NSData.alloc.initWithContentsOfFile("${tmpFile}");
const body = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;

// Find folder by ID
const accounts = Notes.accounts();
let targetFolder = null;
for (const account of accounts) {
    const folders = account.folders();
    for (const f of folders) {
        if (f.id() === "${escapedFolderId}") {
            targetFolder = f;
            break;
        }
    }
    if (targetFolder) break;
}

if (!targetFolder) {
    throw new Error("Folder not found");
}

const note = Notes.Note({name: "${escapedTitle}", body: body});
targetFolder.notes.push(note);
note.id();
`;

	try {
		return runJxa(script, 30_000);
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {}
	}
}
