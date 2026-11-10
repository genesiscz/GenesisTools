# tools automate

`tools automate` chains steps into a JSON preset and runs it on demand or on a schedule. A step can be an HTTP
request, a file, git, JSON, text or language operation, a desktop or Telegram notification, a shell command, or any
other `tools` command. Use it for checks and reports you repeat: an API health check, a weekly git summary, a backup.

## Quick start

```bash
# See the presets (seven bundled presets are copied in on the first start)
tools automate preset list

# Preview a preset: prints its steps, runs nothing, records nothing
tools automate preset run weekly-git-summary --dry-run

# Run a preset and override one of its variables
tools automate preset run scheduled-health-check --var url=https://example.com/health

# Browse the step types and their parameters
tools automate step list

# Run a preset on a schedule: create the task, then install the background daemon
tools automate task create
tools automate daemon install
```

## Commands

`tools automate` with no arguments prints the help. `tools automate step` and `tools automate task` without a
subcommand run their `list`. The tool also takes `-v, --verbose` (debug logs; `-v` works anywhere on the command
line), `--readme` (print this file) and `-V, --version`.

### Presets

```
tools automate preset run <preset> [options]   # run a preset by name or by path to a .json file
tools automate preset list                     # alias ls: valid presets, step count, last run, run count
tools automate preset show [preset]            # variables, steps, run history; no name lists all names
tools automate preset create                   # wizard that writes a new preset file
```

| `preset run` flag      | What it does                                                        |
|------------------------|---------------------------------------------------------------------|
| `--dry-run`            | Print what each step would do. No step runs, but expressions do.    |
| `--var <key=value...>` | Set a variable. Repeat the flag, or list several pairs after one.   |
| `-v, --verbose`        | Debug logs, including each `tools` command line before it runs.     |

- `<preset>` resolves in this order: a path to an existing file that ends in `.json`, then
  `~/.genesis-tools/automate/presets/<preset>.json`, then `~/.genesis-tools/automate/presets/<preset>` exactly as
  typed, with no `.json` added. The name is the file name (`weekly-git-summary`), not the display name
  (`Weekly Git Summary`).
- `--var` takes several values, so put the preset name first. In `preset run --var a=1 my-preset`, the name is read
  as a second `--var` value and the command fails with a missing argument.
- A `--var` value keeps everything after the first `=` (`--var query=a=b` sets `query` to `a=b`). A pair without
  `=` is reported and ignored. A `--var` value stays a string; a value typed at a prompt is converted to the
  variable's declared type.
- Before the first step, the run prompts for every variable that still has no value, unless the variable sets
  `"required": false`. A dry run prompts too.
- A dry run lists every top-level step once, in file order, except the steps that a `parallel` step names in its
  `steps` list. It follows no `if` jump and does not expand loops. A `tools` step prints its command line
  (`Would run: tools github search ...`).
- In that command line, `vars` and `env` resolve exactly. A param that reads an earlier step's output does not,
  because no step ran: each earlier step is `skipped`, with a placeholder text as its output. Such a param shows
  `undefined`, empty text or that placeholder. A JavaScript expression that reads into such an output
  (`{{ steps.fetch.output.body.count > 5 }}`) can stop the dry run with `Expression evaluation failed`.
- ⚠️ A dry run is not a safe way to inspect a preset you do not trust. It skips built-in steps (`if`, `log`,
  `prompt`, `shell`, `set`) and handler steps (`http`, `file`, `git`, `json` and the others) before it resolves
  them, it starts no `tools` command, and it saves no run history. It still resolves the params of every `tools`
  step, though, and a `{{ }}` expression that is more than a plain `vars.`, `steps.` or `env.` path runs as
  JavaScript with full access to Bun: `{{ Bun.write('/tmp/probe', 'changed') }}` writes that file during the dry
  run. To inspect a preset, read its JSON.
- The run prints one line per step (`[2/4] Check endpoint (312ms)`) and a summary. It exits 1 when the preset does
  not load or when any step ends in error, also a step with `onError: "continue"`.

`preset list` skips a file that fails validation without a word. Run `preset show <file name>` to see the error.

`preset show` labels every action that is not a built-in as `tools <action>`. That includes step handlers such as
`http.get`, which run inside the process and start no `tools` command.

`preset create` asks for a name and a description, then for steps one by one: a `tools` command, `shell`, `if`,
`log`, `prompt` or `set`. It previews the JSON and saves it as `presets/<name in lowercase, dashes>.json` with a
manual trigger and no variables. It replaces an existing `presets/<name>.json` without asking, also your edited
copy of a bundled preset. Write step handlers (`http.*`, `file.*`, loops) and variables in a text editor.
The wizard also asks "Store step output in a variable?" and writes the `output` field, which the engine ignores
(see [Step fields](#step-fields)).

### Steps

```
tools automate step list            # alias ls: every step handler and its actions
tools automate step show <action>   # the parameters of a handler group; * marks a required one
```

`step show http` and `step show http.get` both print the whole `http` group. The catalog covers the step handlers
only. The five built-ins (`if`, `log`, `prompt`, `shell`, `set`) and `tools` commands are described in
[Step reference](#step-reference).

### Tasks (schedules)

```
tools automate task list                # alias ls: name, preset, interval, enabled, last run, next run
tools automate task create              # wizard: pick a preset, name the task, give an interval
tools automate task show <name-or-id>   # a task by name, or one run by its numeric id
tools automate task enable <name>       # computes the next run from now
tools automate task disable <name>
tools automate task delete <name>       # asks for confirmation
tools automate task run <name> [-v]     # run the task's preset now, in this terminal
tools automate task history [-n <n>]    # the latest runs of every preset (default 20)
```

- A task is a database row that names a preset and an interval. Only the daemon runs tasks on time; `task create`
  prints the next run time and reminds you to start it.
- `task create` shows each preset as its display name and description, and stores the preset's file name in the
  task. A task name allows letters, digits, `-` and `_`, and must be unique. The wizard asks for no variables, so
  a scheduled run uses the preset defaults.
- `task show <name>` prints the task. It lists recent scheduled runs, taken from the last 10 runs of all presets,
  only when the preset's display name equals its file name. The task stores the file name
  (`scheduled-health-check`), a run stores the display name (`Scheduled Health Check`), and no bundled preset has
  the two equal. Find a task's runs with `task history` (Preset shows the display name, Trigger shows `schedule`)
  or in the `runs` table by `schedule_id` ([For agents](#for-agents)).
- `task show 42` prints run 42 and a table of its steps: action, status, duration, the first 80 characters of an
  error.
- `task enable` also writes the current time into the task's last run.
- `task run` uses the task's stored variables, records the run as `manual` with the task's id, and does not move
  the next run. It exits 1 when a step fails.
- `task history` lists runs from `preset run`, `task run` and the daemon. Dry runs are not recorded.
- Times in `task list`, `task show` and `task history` are UTC.

### Daemon

```
tools automate daemon start       # run the scheduler in this terminal (Ctrl+C stops it)
tools automate daemon status      # launchd or foreground, its PID, the last 20 lines of each log
tools automate daemon tail        # follow the launchd daemon's two log files
tools automate daemon install     # write and load the launchd agent (starts at login)
tools automate daemon uninstall   # unload and remove the launchd agent
```

- `daemon start` while a daemon already runs tails its logs instead of starting a second scheduler. The PID file
  `~/.genesis-tools/automate/daemon.pid` keeps two schedulers from running at once.
- `daemon install` is safe to run again. It unloads the old agent first, and puts the old plist back when the new
  one fails to load.
- When `daemon status` says the daemon "runs outside GenesisTools.app", run `daemon install` again. The new plist
  starts the daemon through the app, so it shares the app's privacy grants.
- `daemon tail` and the log lines of `daemon status` read the launchd log files. A daemon from `daemon start`
  writes to its terminal instead.

### Configure and credentials

```
tools automate configure                           # Telegram status; offers tools telegram-bot configure
tools automate configure credentials add <name>    # add or replace one (alias creds); asks type and values
tools automate configure credentials list          # alias ls
tools automate configure credentials show <name>   # values masked
tools automate configure credentials delete <name>
```

- A credential name allows letters, digits, `-` and `_`.
- `credentials add` shows what you type. Type an expression such as `{{ env.API_TOKEN }}` instead of the secret to
  keep it off the screen and out of the file.
- `credentials show` prints the first four characters of each value and stars for the rest (a value of four
  characters or fewer is all stars). A value that starts with `{{` prints as it is.
- `credentials show` exits 1 for an unknown name. `credentials delete` reports an unknown name and exits 0.

## How it works

A run loads the preset and validates it, fills the variables (defaults, then `--var`, then prompts), and walks the
steps in order. Each result is stored as `steps.<id>`, so later steps can read it. An `if` step jumps to another
step. A failed step stops the run unless its `onError` says otherwise. After a real run, the preset's run counter
and last-run time go up, whether the run passed or failed.

Each step's `action` resolves in this order:

1. A built-in (`if`, `log`, `prompt`, `shell`, `set`), handled by the engine.
2. A step handler, found by the whole action when it is a handler name (`forEach`, `notify`), else by the part
   before the dot (`http.get` goes to `http`). It runs inside the process. There are 40 actions in 11 handlers:
   `http`, `file`, `git`, `json`, `text`, `array`, `notify`, `nlp`, `forEach`, `while`, `parallel`.
3. Anything else is a `tools` command: `"action": "github search"` runs `tools github search` as a child process.

An action that is only a handler name never reaches `tools`. `"action": "notify"` goes to the `notify` handler and
fails with `Unknown notify action: undefined`; it does not run `tools notify`. The same holds for `git` and
`json`. For such a tool, put its subcommand in `action` (`"action": "json convert"`), or use a `shell` step
(`"command": "tools notify 'Backup done'"`).

### Where data lives

Paths start at `~/.genesis-tools/automate/`, except the launchd plist:

```
presets/<name>.json        preset files; missing bundled presets are copied here on every start
config.json                lastRun and runCount of each preset, under meta, keyed by display name
automate.db                SQLite (WAL, foreign keys on): schedules, runs, run_logs
credentials/<name>.json    one file per credential, mode 0600, in a folder with mode 0700
logs/daemon-stdout.log     output of the launchd daemon
logs/daemon-stderr.log     errors of the launchd daemon
daemon.pid                 PID of the running daemon
cache/                     created on start, not used
~/Library/LaunchAgents/com.genesis-tools.automate.plist
```

- Every start of `tools automate`, `--help` included, creates `presets/` and `cache/` and copies each bundled
  preset that is missing from `presets/`. The other files appear when first needed. A bundled preset you delete
  comes back on the next start. A bundled preset you edit keeps your edits.
- `run_logs` keeps each step's output as text, cut at 65,536 characters.
- The scheduler, the step runner and the top-level error handler also write to the shared GenesisTools day log,
  `~/.genesis-tools/logs/<date>.log` (pino JSON).

### Bundled presets

These ship in `src/automate/presets/` and are copied into `presets/`:

- `api-health-check`: splits a list of URLs, checks each with `http.get` (5 at a time), shows a desktop
  notification. As shipped it fails at its first step ([Troubleshooting](#troubleshooting)).
- `claude-usage-report`: runs `tools claude usage --json`, formats each account's limits, sends them to Telegram.
- `email-sentiment-check`: language, sentiment and named entities of `--var text=...`, with the `nlp.*` steps.
- `pr-review-digest`: open pull requests of `--var owner=... --var repo=...` from the GitHub API (reads
  `GITHUB_TOKEN`), written to `./pr-digest.md` and copied. As shipped it fails at its second step.
- `project-backup`: finds files by a glob pattern and copies them to a backup folder. As shipped it fails at its
  second step.
- `scheduled-health-check`: one `http.get`, then a Telegram message with the result.
- `weekly-git-summary`: the last 50 commits of the current repository as markdown, copied to the clipboard.

### The scheduler

The daemon reads the due tasks from `automate.db`, runs each one's preset, then computes its next run from the
moment the run ends. Between checks it sleeps until the next task is due: at least 1 second, at most 60 seconds. A
task that is still running when it comes due again is skipped.

On stop (Ctrl+C on `daemon start`, or the SIGTERM that launchd sends), the scheduler only sets a flag. The loop
ends after its current sleep, so `daemon start` can take up to a minute to end. Then the scheduler waits up to 30
seconds for runs in progress. The daemon closes its database at the signal itself, so a run still in progress
cannot write its result and can stay `running` in the history. This is read from the code, not tested live.

The launchd agent has the label `com.genesis-tools.automate` and these keys: `RunAtLoad` (starts at login),
`KeepAlive` (restarts after a crash), `ThrottleInterval` 10 seconds, `ProcessType` Background. It runs
`bun run <checkout>/src/automate/lib/daemon.ts`, through GenesisTools.app when the app is installed. Its working
directory is your home folder. The plist sets only two environment variables: `HOME`, and a fixed `PATH`
(`/usr/local/bin`, `/usr/bin`, `/bin` and the folder of `bun`).

### What it needs and what it costs

- macOS: the daemon uses launchd, `notify.desktop` uses `osascript`, `notify.sound` uses `afplay`, and `nlp.*` uses
  the macOS NaturalLanguage framework through DarwinKit.
- `notify.telegram` needs a bot set up with `tools telegram-bot configure`.
- Runtime: Bun (`Bun.spawn`, `bun:sqlite`, Bun file APIs).
- Cost: automate calls no paid service by itself. An `http.*` step or a `tools` step costs what that API or tool
  costs.

## Configuration

### Preset files

A preset is a JSON file in `~/.genesis-tools/automate/presets/`, or anywhere when you run it by path. This one
alerts when a queue grows past a threshold:

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Queue Watch",
  "description": "Alert when the job queue is too long",
  "trigger": { "type": "manual" },
  "vars": {
    "url": { "type": "string", "description": "Queue stats URL", "default": "https://api.example.com/queue" },
    "threshold": { "type": "number", "description": "Alert threshold", "default": 5 }
  },
  "steps": [
    { "id": "fetch", "name": "Fetch queue stats", "action": "http.get", "params": { "url": "{{ vars.url }}" } },
    {
      "id": "check",
      "name": "Over the threshold?",
      "action": "if",
      "condition": "{{ steps.fetch.output.body.count > vars.threshold }}",
      "then": "alert",
      "else": "ok"
    },
    {
      "id": "alert",
      "name": "Send alert",
      "action": "notify.telegram",
      "params": { "message": "Queue length: {{ steps.fetch.output.body.count }}" }
    },
    { "id": "end-alert", "name": "Skip the all-clear", "action": "if", "condition": "{{ true }}", "then": "done" },
    { "id": "ok", "name": "All clear", "action": "log", "params": { "message": "Queue is fine" } },
    { "id": "done", "name": "Summary", "action": "log", "params": { "message": "Checked {{ vars.url }}" } }
  ]
}
```

After a jump, the run goes on in list order. That is why the `end-alert` step jumps over `ok`: without it, the
alert branch would also log "Queue is fine".

Top-level fields:

- `$schema` (required): any string. The wizard writes `genesis-tools-preset-v1`.
- `name` (required, not empty): the display name. The wizard makes the file name from it.
- `description` (optional): shown by `preset list` and at the start of a run.
- `trigger` (required): `{ "type": "manual" }` or `{ "type": "schedule", "interval": "every 5 minutes" }`. It is
  only validated. A schedule trigger schedules nothing; use `task create`.
- `vars` (optional): the variables, by name.
- `steps` (required, at least one): the steps, in order.

Loading refuses a preset with two steps of the same id, or with an `if` whose `then` or `else` names no step.

#### Variable fields

- `type` (required): `string`, `number` or `boolean`. A prompted value is converted to it; a boolean is true only
  for the answer `true`.
- `description` (required): the prompt text, also shown by `preset show`.
- `default` (optional): the value when no `--var` sets one.
- `required` (optional): a variable with no value is prompted for unless `required` is `false`. A variable without
  a default is therefore required unless it says otherwise.

#### Step fields

- `id` (required): unique; letters, digits, `-` and `_`.
- `name` (required): the label in the progress output.
- `action` (required): a built-in, a step handler action, or a `tools` command.
- `params` (optional): the action's parameters.
- `onError` (optional): `stop` (default), `continue` or `skip`. See [Errors](#errors).
- `condition`, `then`, `else`: fields of an `if` step, beside `params`, not inside it.
- `interactive` (optional): `true` gives a `shell` step this terminal's input. Other steps ignore it.
- `output` (optional): accepted and shown by `preset show`, but the engine ignores it. Read a result as
  `steps.<id>.output`.

### Expressions

A field takes one of three forms:

- **Template fields** take `{{ expression }}`. These are most parameters and the `if` condition. Text around an
  expression makes the whole field a string. A field that is exactly one expression depends on the action:
  - In built-ins (`if`, `log`, `prompt`, `shell`, `set`) and in `tools` params, it keeps the value's type (number,
    boolean, array, object). So `set` stores a number as a number, and a `tools` flag whose expression gives
    `false` is left out.
  - In step-handler params (`http.*`, `file.*`, `notify.*` and the rest), it always becomes a string. A number
    becomes its digits, and an object or array becomes JSON text. So
    `"content": "{{ steps.fetch.output.body }}"` in `notify.clipboard` or `file.write` gives JSON text.
- **Expression fields** take a bare expression, with no braces: `items` of `forEach`, `condition` of `while`,
  `validateStatus` of `http.*`, and `input` of `json.stringify`, `json.query`, `text.regex`, `text.split`,
  `text.join` and every `array.*` action. With braces they fail with
  `Expression evaluation failed: "{{ {{ ... }} }}"`.
- **Literal fields** are read as written and never resolve `{{ }}`. Give them the value itself (a JSON number,
  string or array): `timeout` of `http.*`, `limit` of `git.log`, `indent` of `json.stringify`, `flags` of
  `text.regex`, `key` and `order` of `array.sort`, `sound` of `notify.sound`, `parse_mode` of `notify.telegram`,
  `language`, `schemes` and `type` of `nlp.*`, `concurrency`, `as` and `indexAs` of `forEach`, `maxIterations` of
  `while`, and `steps` and `onError` of `parallel`. So `"limit": "{{ vars.count }}"` passes that text to git as it
  is.

An expression sees:

- `vars.<name>`: a variable.
- `steps.<id>.output`, `.status` (`success`, `error` or `skipped`), `.error`, `.exitCode`, `.duration` (ms).
- `env.<NAME>`: the process environment.
- In a `forEach` body: `item` (or the `as` name), `item.<field>`, and `index` (or the `indexAs` name).

How an expression is evaluated:

- A plain path (`vars.url`, `steps.fetch.output.body`) is read directly.
- Anything else is JavaScript, run with `new Function`: `{{ steps.count.output > 0 ? 'yes' : 'no' }}`. `vars`,
  `steps` and `env` are passed in, and the expression also sees every global (`process`, `Bun`, `fetch`). It is
  not a sandbox: an expression can do anything this process can do. A preset is code: run only presets you trust.
- A dashed step id works in a dot path: `steps.my-step.output` is rewritten to `steps["my-step"].output`.
  `steps['my-step'].output` works too.
- A missing value inside surrounding text prints as empty text.
- An object inside surrounding text prints as `[object Object]`. An array prints its items joined with commas, so
  an array of objects prints `[object Object],[object Object]`. Format it in the expression instead:
  `"{{ steps.log.output.commits.map(c => c.sha + ' ' + c.message).join('\\n') }}"`.
- In a `forEach` body, `{{ item }}` and `{{ item.<field> }}` print an object as JSON text, also inside text.
- An `if` condition without braces is always true, because the text itself is not empty.

### Step reference

Every result has `status` and `duration`. An error has `error`. `shell` and `tools` steps also have `exitCode`.

#### Built-ins

- `shell`: `command` (or `cmd`), `cwd` (default: the current directory), `timeout` in seconds (default 300). Runs
  `bash -c`. Output: stdout parsed as JSON when it is JSON, otherwise the trimmed text. A non-zero exit is an error
  with stderr as its message.
- `if`: `condition`, `then`, `else` (step ids). True jumps to `then`, false to `else`; no target means the next
  step. A jump back to an earlier step runs it again, with no loop limit. Output: the boolean.
- `log`: `message`. Prints it. Output: the message.
- `prompt`: `message` (default `Enter value:`), `default`. Output: the answer. Cancel makes the step an error.
- `set`: each param becomes a variable (`vars.<key>`); only strings, numbers and booleans are kept. Output: the
  params.

#### `tools` commands

- `action` is the command after `tools`, split at spaces.
- A param key that starts with `-` is a flag: `true` adds the flag alone, `false` leaves it out, an array is joined
  with commas, any other value follows the flag. Any other key is a positional argument: only its value is used,
  in key order, and an array adds one argument per item.
- stdout is parsed as JSON when it is JSON, otherwise kept as trimmed text. Ask the tool for JSON
  (`--json` or `--format json`, whichever it supports). A non-zero exit is an error with stderr as its message.
- The command gets no input and no time limit. A command that asks a question gets no answer.

```json
{
  "id": "search",
  "name": "Search issues",
  "action": "github search",
  "params": { "query": "crash", "--repo": "owner/repo", "--format": "json" }
}
```

This runs `tools github search crash --repo owner/repo --format json`.

#### HTTP: `http.get`, `http.post`, `http.put`, `http.patch`, `http.delete`

- `url` (required), `query` (object), `headers` (object), `credential` (a stored credential's name), `timeout` in ms
  (default 30000), `validateStatus` (an expression on `status`, such as `status < 500`; default: 200 to 299).
- `body` (not for GET): an object is sent as JSON, with `{{ }}` resolved in its strings; a string is sent as it is.
- Sends `Content-Type: application/json` and `Accept: application/json` unless `headers` says otherwise.
- Output: `{ status, statusText, headers, body }`. `body` is parsed when the response is JSON. A rejected status is
  an error that keeps this output. A network error or a timeout is an error with no output.
- An unknown `credential` logs a warning, and the request goes out without it.

#### File: `file.read`, `file.write`, `file.copy`, `file.move`, `file.delete`, `file.glob`, `file.template`

- `file.read`: `path`. Output: `{ path, content, size }`. A missing file is an error.
- `file.write`: `path`, `content`. Replaces the file and creates missing folders. Output: `{ path, size }`.
- `file.copy`, `file.move`: `source`, `destination`. Creates the destination folder. Output: `{ source,
  destination }`.
- `file.delete`: `path`. A missing file is not an error. Output: `{ path, existed }`.
- `file.glob`: `pattern`, `cwd`. Output: `{ pattern, cwd, files, count }`, with absolute paths of files only.
- `file.template`: `templatePath` or `content`, `variables` (each replaces `{{ key }}` first), `path`. Output:
  `{ content }`, or `{ path, content }` after it writes `path`.
- Relative paths resolve from the current directory. `~` is not expanded: write `{{ env.HOME }}/notes.md`.

#### Git: `git.status`, `git.commit`, `git.branch`, `git.diff`, `git.log`

Each takes `cwd`, the repository (default: the current directory).

- `git.status`: output `{ branch, hasChanges, files: [{ status, path }] }`.
- `git.commit`: `message` (default `Automated commit`), `files`. Without `files` it stages everything
  (`git add -A`). Output: `{ committed, sha, message }`; nothing to commit is a success with `committed: false`.
- `git.branch`: `branch` (required), `from`. Runs `git checkout -b`, so it also switches to the new branch. Output:
  `{ branch }`.
- `git.diff`: `from` (default `HEAD~1`), `to` (default `HEAD`). Output: `{ from, to, diff }`.
- `git.log`: `limit` (default 10), `from`, `to` (default `HEAD`). Output: `{ commits: [{ sha, message }], count }`.

#### JSON: `json.parse`, `json.stringify`, `json.query`

- `json.parse`: `input` (a template field). Output: the parsed value.
- `json.stringify`: `input` (an expression field), `indent` (default 2). Output: a string.
- `json.query`: `input` (an expression field), `query` (JSONPath, such as `$.items[*].name`). Output: an array.

#### Text: `text.regex`, `text.template`, `text.split`, `text.join`

- `text.regex`: `input` (an expression field), `pattern`, `flags` (default `g`), `replacement`. With a replacement:
  `{ result, matchCount }`. Without one: `{ matches: [{ match, groups, index }], count }`.
- `text.template`: `template`. Output: the resolved string.
- `text.split`: `input` (an expression field), `separator` (default: a newline). Output: an array.
- `text.join`: `input` (an expression field, an array), `separator` (default: a newline). Output: a string.

#### Array: `array.filter`, `array.map`, `array.sort`, `array.flatten`

`input` is an expression field and must give an array.

- `array.filter`, `array.map`: `expression`, plain JavaScript with no braces, with `item`, `index`, `vars`, `steps`
  and `env` in scope, such as `item.count > 0`. Dashed ids are not rewritten here: write `steps['my-id']`.
- `array.sort`: `key` (sort objects by this field), `order` (`asc` default, or `desc`).
- `array.flatten`: flattens every level.

#### Notify: `notify.desktop`, `notify.clipboard`, `notify.sound`, `notify.telegram`

- `notify.desktop`: `title` (default `GenesisTools Automate`), `message`. A macOS notification.
- `notify.clipboard`: `content` (or `message`). Output: `{ copied, length }`.
- `notify.sound`: `sound` (default `Glass`), a name from `/System/Library/Sounds/`.
- `notify.telegram`: `message`, `parse_mode` (`MarkdownV2` or `HTML`). Sends to the bot's notifications chat.
  Output: `{ messageId, chatId }`. Without a configured bot the step is `skipped` and the run goes on.

#### NLP: `nlp.sentiment`, `nlp.language`, `nlp.tag`, `nlp.distance`, `nlp.embed`

Each takes `text`. Output: the result object from DarwinKit.

- `nlp.sentiment`: a score from -1.0 to 1.0.
- `nlp.language`: the detected language.
- `nlp.tag`: `schemes` (default `["lexicalClass"]`; also `nameType`, `lemma`, `sentimentScore`, `language`),
  `language` (BCP-47, default `en`).
- `nlp.distance`: `text2`, `type` (`word` or `sentence`, default `sentence`), `language`.
- `nlp.embed`: `type` (`word` or `sentence`, default `sentence`), `language`.

#### Flow: `forEach`, `while`, `parallel`

- `forEach`: `items` (an expression field that gives an array), `step` (one step object), `concurrency` (default 1;
  higher runs batches of that size), `as` (default `item`), `indexAs` (default `index`). Output:
  `{ results, count, failures }`. Each pass is also stored as `steps['<id>[<n>]']`. The step is an error when any
  pass fails.
- `while`: `condition` (an expression field, checked before each pass), `step`, `maxIterations` (default 100).
  Output: `{ results, iterations, failures }`. It stops at the first failed pass unless the `while` step has
  `onError: "continue"`.
- `parallel`: `steps` (ids of other top-level steps), `onError` (`stop` default, or `continue`). The listed steps
  run together inside this step and are skipped where they stand in the list. Output: each child's result by id;
  each child is also stored as `steps.<id>`.
- A `forEach` or `while` body and a `parallel` child must be a step handler action. A built-in or a `tools` command
  there fails with `Unknown action in forEach body: shell` (or `Unknown action: ...` in `parallel`).

### Errors

`onError` decides what a failed step does to the run:

- `stop` (default): the run ends at this step.
- `continue` and `skip`: the run goes on with the next step. The two behave the same. The step stays an error, its
  message prints, and the run still counts as failed (exit code 1, status `error` in the history).

A run passes only when every step that ran is `success` or `skipped`. A step is `skipped` in a dry run, or when a
Telegram step has no bot. A step that throws (for example a broken expression in `forEach`) is treated as a
failed step: its error is stored as `steps.<id>.error`, and its `onError` applies.

### Schedules

```
every 30 seconds
every 5 minutes
every 1 hour
every 7 days
every 2 weeks
every day at 09:00      # local time, 24-hour clock
```

The form is `every <N> <second|minute|hour|day|week>`, with or without a plural `s`, in any letter case, or
`every day at HH:MM`. Nothing else parses: `every hour` without a number fails. For `every <N> <unit>`, the next
run is counted from the end of the previous one, so the start time drifts by the length of each run. `every day at`
keeps its clock time: the next run is the next HH:MM local time. `task list` shows the UTC time of a local
`every day at` run.

A scheduled run differs from one in your terminal:

- It has no terminal. A variable without a value opens a prompt that nobody can answer, so give every variable of
  a scheduled preset a default.
- Its working directory is your home folder. Relative paths, `git.*` steps without `cwd` and `shell` steps without
  `cwd` start there.
- The plist sets only `HOME` and `PATH`. An `{{ env.NAME }}` that works in your shell can be
  empty in the daemon, and `GENESIS_TOOLS_HOME` is not passed on.
- It runs the code of the checkout where you ran `daemon install`. Install from the main checkout, not from a
  worktree you will remove.

### Credentials

A credential adds headers to an `http.*` step that names it with `"credential": "<name>"`.

| Type     | Fields               | Header sent                                  |
|----------|----------------------|----------------------------------------------|
| `bearer` | `token`              | `Authorization: Bearer <token>`              |
| `basic`  | `username, password` | `Authorization: Basic <base64>`              |
| `apikey` | `key, headerName`    | `<headerName>: <key>` (default `X-API-Key`)  |
| `custom` | `headers`            | each header as given                         |

A value can hold any `{{ }}` expression. It resolves when the request is made, so a file can name an environment
variable instead of holding the secret:

```json
{
  "name": "github-token",
  "type": "bearer",
  "token": "{{ env.GITHUB_TOKEN }}"
}
```

```json
{
  "id": "fetch",
  "name": "Call the protected API",
  "action": "http.get",
  "params": { "url": "https://api.example.com/data", "credential": "github-token" }
}
```

Each credential is `credentials/<name>.json`, mode 0600, in a folder with mode 0700. When `credentials add` finds a
file it cannot read as a credential, it keeps a copy of that file before it writes the new one.

### Environment variables

- `GENESIS_TOOLS_HOME`: puts the whole `.genesis-tools` tree (presets, database, credentials, logs, PID file) under
  another home folder. The launchd plist stays in `~/Library/LaunchAgents`, and the launchd daemon does not get
  this variable.
- Steps read the process environment as `env.<NAME>`.

## Examples

### API health check

Checks several endpoints at once and shows the result as a desktop notification. Note the bare expressions in
`input` and `items`.

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "API Health Check",
  "description": "Check API endpoints and notify on results",
  "trigger": { "type": "manual" },
  "vars": {
    "endpoints": {
      "type": "string",
      "description": "Comma-separated list of URLs to check",
      "default": "https://api.example.com/health,https://api.example.com/status"
    }
  },
  "steps": [
    {
      "id": "split-urls",
      "name": "Parse endpoint list",
      "action": "text.split",
      "params": { "input": "vars.endpoints", "separator": "," }
    },
    {
      "id": "check-all",
      "name": "Check all endpoints",
      "action": "forEach",
      "params": {
        "items": "steps.split-urls.output",
        "concurrency": 5,
        "step": {
          "id": "check",
          "name": "Check endpoint",
          "action": "http.get",
          "params": { "url": "{{ item }}", "timeout": 10000 }
        }
      },
      "onError": "continue"
    },
    {
      "id": "notify",
      "name": "Report results",
      "action": "notify.desktop",
      "params": {
        "title": "API Health Check",
        "message": "Checked {{ steps.check-all.output.count }} endpoints, {{ steps.check-all.output.failures }} failures"
      }
    }
  ]
}
```

```bash
tools automate preset run ~/Projects/app/presets/api-health-check.json \
  --var endpoints=https://api.example.com/health,https://api.example.com/v2
```

Run it by name (`preset run api-health-check`) only after you save this JSON as
`~/.genesis-tools/automate/presets/api-health-check.json`. The name finds that file, and the bundled copy there
fails at its first step.

With `onError: "continue"`, the notification is sent even when an endpoint fails. The run still exits 1 then.

### Weekly git summary

Collects the recent commits of a repository, formats them as markdown, and copies the text to the clipboard.

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Weekly Git Summary",
  "description": "Recent commits as markdown, copied to the clipboard",
  "trigger": { "type": "manual" },
  "vars": {
    "repo": { "type": "string", "description": "Repository folder", "default": "." }
  },
  "steps": [
    {
      "id": "log",
      "name": "Get recent commits",
      "action": "git.log",
      "params": { "limit": 50, "cwd": "{{ vars.repo }}" }
    },
    {
      "id": "format",
      "name": "Format as markdown",
      "action": "text.template",
      "params": {
        "template": "# Weekly Git Summary\n\nCommits: {{ steps.log.output.count }}\n\n{{ steps.log.output.commits.map(c => '- ' + c.sha + ' ' + c.message).join('\\n') }}"
      }
    },
    {
      "id": "copy",
      "name": "Copy to clipboard",
      "action": "notify.clipboard",
      "params": { "content": "{{ steps.format.output }}" }
    },
    {
      "id": "done",
      "name": "Show notification",
      "action": "notify.desktop",
      "params": { "title": "Git Summary", "message": "{{ steps.log.output.count }} commits copied to clipboard" }
    }
  ]
}
```

The bundled `weekly-git-summary` puts `{{ steps.log.output.commits }}` straight into the text, which prints
`[object Object]` for each commit. The `map` expression above writes one line per commit.

### Scheduled health check with Telegram

Every 5 minutes, checks one URL and sends the result to Telegram.

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Scheduled Health Check",
  "description": "Check an endpoint, notify via Telegram",
  "trigger": { "type": "manual" },
  "vars": {
    "url": { "type": "string", "description": "URL to check", "default": "https://api.example.com/health" }
  },
  "steps": [
    {
      "id": "check",
      "name": "Check endpoint",
      "action": "http.get",
      "params": { "url": "{{ vars.url }}", "timeout": 10000 },
      "onError": "continue"
    },
    {
      "id": "notify",
      "name": "Send Telegram notification",
      "action": "notify.telegram",
      "params": { "message": "Health check: {{ vars.url }}, step status {{ steps.check.status }}" }
    }
  ]
}
```

```bash
tools telegram-bot configure      # once, if the bot is not set up yet
tools automate task create        # pick "Scheduled Health Check", interval "every 5 minutes"
tools automate daemon install     # or: tools automate daemon start, to watch it in a terminal
tools automate task history -n 5  # check the first runs
```

## For agents

- No command has `--json` output. Every command prints for people. Read results from the database instead, with
  `-readonly` so nothing changes:

  ```bash
  sqlite3 -readonly ~/.genesis-tools/automate/automate.db \
    "SELECT id, preset_name, trigger_type, status, started_at, duration_ms FROM runs ORDER BY id DESC LIMIT 5"
  sqlite3 -readonly ~/.genesis-tools/automate/automate.db \
    "SELECT step_index, step_id, status, error, substr(output, 1, 200) FROM run_logs WHERE run_id = 42"
  ```

  Tables: `schedules` (name, preset_name, interval, enabled, last_run_at, next_run_at, vars_json), `runs`
  (schedule_id, preset_name, trigger_type, started_at, finished_at, status, step_count, duration_ms, error) and
  `run_logs` (run_id, step_index, step_id, step_name, action, status, output, duration_ms, error).
- Exit codes: `preset run` and `task run` exit 1 when a step fails or the preset does not load; an uncaught error
  exits 1. Ctrl+C on `daemon start` or `daemon tail` exits 130. These print an error but exit 0:
  - "Not found" from `task show`, `enable`, `disable`, `delete` and `run`, from `credentials delete`, and an
    unknown type from `step show`.
  - `task create` with a task name that already exists.
  - `daemon install` when the install fails, for example when launchd does not load the agent (`Failed: ...`).
  - A cancelled variable prompt (`Operation cancelled`).
- To find the runs of one task, filter `runs` by `schedule_id`:

  ```bash
  sqlite3 -readonly ~/.genesis-tools/automate/automate.db \
    "SELECT r.id, r.trigger_type, r.status, r.started_at FROM runs r
     JOIN schedules s ON s.id = r.schedule_id WHERE s.name = 'my-task' ORDER BY r.id DESC LIMIT 5"
  ```
- These need a terminal: `preset create`, `task create`, `task delete` (it confirms), `configure`,
  `credentials add`, and the variable prompts of a run. Write the preset JSON yourself and pass every variable that
  has no default with `--var`.
- `--dry-run` prints each `tools` command line with `vars` and `env` resolved. A param that reads an earlier
  step's output shows `undefined`, empty text or a placeholder, because no step ran. Use it to check a preset's
  steps and variables before the real run, not the values that steps pass on.
- The plugin command `gt:automate` (`plugins/genesis-tools/commands/automate.md`) helps an agent write presets. Its
  examples use the old short forms `tools automate run|list|show|create`; those commands now sit under `preset`
  (`tools automate preset run`).

## Troubleshooting

- **`Expression evaluation failed: "{{ {{ ... }} }}"`.** An expression field got braces. Remove them
  ([Expressions](#expressions) lists those fields). The bundled `api-health-check` (`input`, `items`),
  `pr-review-digest` (`input` of `json.query`) and `project-backup` (`items`) ship this way and fail. Fix your copy
  in `presets/`; your edits stay.
- **`Unknown action in forEach body: shell`.** A loop body or a `parallel` child is a built-in or a `tools`
  command. Use a step handler action there, or move the command to a top-level step.
- **A message shows empty values.** A path names something that does not exist, and a missing value prints as
  empty text. The bundled `email-sentiment-check` reads `steps.languageResult`, a name from its `output` field,
  which the engine ignores. Use the step id: `steps.detect-language.output`.
- **A message shows `[object Object]`.** An object or array sits inside surrounding text. Format it with an
  expression, as in [Weekly git summary](#weekly-git-summary).
- **An `if` always takes `then`.** Its condition has no `{{ }}`, so it is a non-empty string.
- **Both branches of an `if` run.** After a jump, the run goes on in list order. End the first branch with an `if`
  on `{{ true }}` that jumps past the second ([Preset files](#preset-files) shows it).
- **The run fails although the step has `onError: "continue"`.** That is by design: `continue` lets later steps
  run, but the run still counts as failed.
- **A preset is missing from `preset list`.** The file fails validation. `preset show <file name>` prints the error.
- **`Preset "..." not found. Searched: ...`.** Use the file name without `.json`, or a path that ends in `.json`.
- **A task never runs.** Check `daemon status`, then `task list`: the task must be enabled, and the daemon must
  run. It checks for due tasks at least once a minute.
- **A preset works in the terminal but not in the daemon.** The daemon has no terminal, starts in your home folder,
  and gets only `HOME` and `PATH`. See [Schedules](#schedules).
- **`daemon status` says the daemon "runs outside GenesisTools.app".** Run `tools automate daemon install` again.
- **`No daemon logs found. Is the daemon installed?`** from `daemon tail`. Only the launchd daemon writes log files.
  Run `daemon install`, or watch a foreground daemon in its own terminal.
- **A run stays `running` in `task history`.** The process ended before the run finished (Ctrl+C, a kill, or a
  daemon stop while the run was in progress). Nothing closes that row later.
- **`task show <name>` lists no recent runs.** The task stores the preset's file name, and a run stores its display
  name, so the two match only when they are equal. Use `task history`, or the `schedule_id` query in
  [For agents](#for-agents).
- **`Unknown notify action: undefined`.** The action is a bare handler name (`notify`, `git`, `json`), which goes to
  the step handler, not to `tools`. Name an action of the handler (`notify.desktop`), or put the `tools`
  command's subcommand in `action`.
- **A Telegram step is `skipped`.** No bot is set up. Run `tools telegram-bot configure`, or
  `tools automate configure`.
- **A task shows a last run, but the history has none.** `task enable` writes the current time into the last run.

## Related

- [tools telegram-bot](../telegram-bot/README.md): sets up the bot that `notify.telegram` sends through.
- [tools darwinkit](../darwinkit/README.md): the macOS NaturalLanguage features behind `nlp.*`.
- [tools claude](../claude/README.md): `tools claude usage --json` feeds the bundled `claude-usage-report`.
- [tools github](../github/README.md): a common target for `tools` steps (`github search`).
- [tools task](../task/README.md): runs one command with saved logs, where a preset chains many steps.
- [tools notify](../notify/README.md): desktop notifications from the shell, outside a preset.
