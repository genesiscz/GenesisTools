#!/usr/bin/env bun
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync } from "fs";

interface HookInput {
  session_id: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
  };
  tool_response?: {
    success?: boolean;
    filePath?: string;
  };
}

interface SessionData {
  session_id: string;
  started_at: string;
  last_updated: string;
  files: string[];
}

const STORAGE_DIR = join(homedir(), ".genesis-tools", "claude-code", "sessions");
const CLEANUP_DAYS = 30;

function ensureDir() {
  if (!existsSync(STORAGE_DIR)) {
    mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function cleanupOldSessions() {
  if (!existsSync(STORAGE_DIR)) return;

  const cutoff = Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000;
  const files = readdirSync(STORAGE_DIR);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = join(STORAGE_DIR, file);
    try {
      const stats = statSync(filePath);
      if (stats.mtimeMs < cutoff) {
        unlinkSync(filePath);
      }
    } catch {
      // Ignore transient fs errors (file deleted, permissions changed, etc.)
    }
  }
}

function createFreshSessionData(sessionId: string): SessionData {
  return {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    files: []
  };
}

function trackFile(sessionId: string, filePath: string) {
  ensureDir();

  const sessionFile = join(STORAGE_DIR, `${sessionId}.json`);

  let sessionData: SessionData;
  if (existsSync(sessionFile)) {
    try {
      sessionData = JSON.parse(readFileSync(sessionFile, "utf-8"));
    } catch (err) {
      // Corrupted JSON - backup and recreate
      console.warn(`[track-session-files] Corrupted session file, recreating: ${sessionFile}`);
      try {
        renameSync(sessionFile, `${sessionFile}.bak`);
      } catch {
        // Ignore backup failure
      }
      sessionData = createFreshSessionData(sessionId);
    }
  } else {
    sessionData = createFreshSessionData(sessionId);
  }

  // Add file if not already tracked
  if (!sessionData.files.includes(filePath)) {
    sessionData.files.push(filePath);
  }
  sessionData.last_updated = new Date().toISOString();

  // Atomic write: write to temp file then rename (avoids race conditions)
  const tempFile = `${sessionFile}.tmp.${Date.now()}`;
  writeFileSync(tempFile, JSON.stringify(sessionData, null, 2));
  renameSync(tempFile, sessionFile);
}

async function main() {
  const input: HookInput = JSON.parse(await Bun.stdin.text());
  const { session_id, hook_event_name, tool_input, tool_response } = input;

  // On SessionStart, output session ID and clean up old sessions
  if (hook_event_name === "SessionStart") {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `📌 Session ID: ${session_id}\n\n**Modified files tracking:** All files you modify are tracked in ~/.genesis-tools/claude-code/sessions/${session_id}.json`
      }
    }));
    cleanupOldSessions();
    process.exit(0);
  }

  // For PostToolUse, track the file (only for configured tools: Edit, Write, MultiEdit)
  if (hook_event_name === "PostToolUse") {
    const TRACKED_TOOLS = ["Edit", "Write", "MultiEdit"];
    const toolName = input.tool_name;

    // Only process tools that match hooks.json matcher
    if (!toolName || !TRACKED_TOOLS.includes(toolName)) {
      process.exit(0);
    }

    const filePath = tool_input?.file_path || tool_response?.filePath;
    if (!filePath) process.exit(0);

    // Skip if write failed
    if (tool_response && tool_response.success === false) process.exit(0);

    trackFile(session_id, filePath);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[track-session-files hook] Unexpected error:`, err);
  process.exit(1);
});
