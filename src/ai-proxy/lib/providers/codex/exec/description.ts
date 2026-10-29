/**
 * Codex's `exec` tool, as codex-rs sends it (rollout 01a17d15, 2026-10-27), cut to what the runner supports: the
 * `exec_command` tool, `text`, `exit`, `store`, `load`, timeouts and `ALL_TOOLS`. The wording is Codex's where it
 * still holds, so the model reads the tool it was trained on. Gone: images, audio, `notify`, `yield_control`, the
 * `wait` tool and every other nested tool (Claude Code's own tools stay outside, next to `exec`).
 */
export const EXEC_DESCRIPTION = `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh process as the body of an async function, so top-level \`await\` works.
- All nested tools are available on the global \`tools\` object, for example \`await tools.exec_command(...)\`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console. Use \`tools.exec_command\` for shell, file and network work.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like \`// @exec: {"max_output_tokens": 1000}\`.
- \`max_output_tokens\` sets the token budget for direct \`exec\` results. Defaults to, and is capped at, 7000 tokens.
- \`yield_time_ms\` is accepted and ignored: a script always runs to its end, for at most 10 minutes. There is no \`wait\` tool.
- When the JS code is fully evaluated, the script's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`store(key: string, value: any)\`: stores a serializable value under a string key for later \`exec\` calls in the same session.
- \`load(key: string)\`: returns the stored value for a string key, or \`undefined\` if it is missing.
- \`setTimeout(callback: () => void, delayMs?: number)\`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep \`exec\` alive by themselves; await an explicit promise if you need to wait for one.
- \`clearTimeout(timeoutId?: number)\`: cancels a timeout created by \`setTimeout\`.
- \`ALL_TOOLS\`: metadata for the enabled nested tools as \`{ name, description }\` entries.

### \`exec_command\`
Runs a command in a shell to its end, returning its output and exit code. Every command first passes the session's shell guard: a command the guard blocks does not run, and the call throws an error that names the rule and the fix.

exec tool declaration:
\`\`\`ts
declare const tools: { exec_command(args: {
  // Shell command to execute.
  cmd: string;
  // True runs the shell with -l semantics; false or omitted runs it without.
  login?: boolean;
  // Output token budget. Defaults to 10000 tokens.
  max_output_tokens?: number;
  // Shell binary to launch. Defaults to the user's default shell.
  shell?: string;
  // Working directory for the command. Defaults to the turn cwd.
  workdir?: string;
}): Promise<{
  // Process exit code.
  exit_code: number;
  // A shell guard warning about the command; the command ran.
  guard_warning?: string;
  // Approximate token count before output truncation.
  original_token_count?: number;
  // Command output text (stdout and stderr together), possibly truncated.
  output: string;
  // Elapsed wall time of the command in seconds.
  wall_time_seconds: number;
}>; };
\`\`\``;

/** Codex's grammar for the `exec` input: raw source, with an optional first-line pragma. */
export const EXEC_GRAMMAR =
    "\nstart: pragma_source | plain_source\npragma_source: PRAGMA_LINE NEWLINE SOURCE\nplain_source: SOURCE\n\nPRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/\nNEWLINE: /\\r?\\n/\nSOURCE: /[\\s\\S]+/\n";
