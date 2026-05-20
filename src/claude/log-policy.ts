// Pre-import side effect — MUST be imported before `@app/logger` so it runs
// before the logger module evaluates its console level (that level is frozen
// at import time; reconfiguring later does not affect already-imported default
// `logger` bindings).
//
// Tool-level console policy: the `claude` tool keeps the console quiet (warn+)
// by default so `--format json` / piped output is never polluted by the
// info-level history instrumentation. The day-stamped log file still captures
// everything (the file stream is hardcoded "debug"). `-v/--verbose` (or
// `--trace`) overrides this and surfaces info/debug/trace live. This is scoped
// to this tool only via the generic `LOG_CONSOLE_LEVEL` env knob — the global
// logger default is unchanged for every other tool.

const argv = process.argv.slice(2);
const verbose =
    argv.includes("-v") ||
    argv.includes("--verbose") ||
    argv.includes("-vv") ||
    argv.includes("--trace") ||
    process.env.LOG_DEBUG === "1" ||
    process.env.LOG_TRACE === "1";

if (!verbose && !process.env.LOG_CONSOLE_LEVEL) {
    process.env.LOG_CONSOLE_LEVEL = "warn";
}
