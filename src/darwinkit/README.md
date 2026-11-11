# tools darwinkit

`tools darwinkit` runs Apple's on-device machine learning from the terminal: language detection, sentiment, part of
speech tags, named entities, 512-dimension text embeddings, semantic ranking, clustering and classification, OCR of
images with Apple Vision, plus Touch ID, iCloud Drive files and the macOS `say` voice. Everything runs on the Mac
through the DarwinKit native bridge, with no API key and no cost, so a script or an agent can use it on private text.
It needs macOS.

## Quick start

```bash
# The language of a text, as a BCP-47 code with a confidence
tools darwinkit detect-language "Bonjour tout le monde"

# The text of a screenshot, without the bounding boxes
tools darwinkit ocr ~/Projects/app/screenshot.png --text-only

# Pick the closest of several labels
tools darwinkit classify "the app crashes when I log out" --categories "bug report,feature request,question"

# Sort texts by how close their meaning is to a query
tools darwinkit rank "budget planning" --items "Q4 budget review,team lunch on Friday,annual financial plan"

# Interactive menu: pick a group, a command, then fill in the values (TTY only)
tools darwinkit
```

## Commands

Every command also takes `--format json|pretty|raw` (see [Output](#output)) and `-h, --help`. Put options after the
command name. `tools darwinkit help <command>` prints the same help as `<command> --help`.

The groups below are the groups of the interactive menu. Where a flag is marked "required" (`--items`, `--categories`,
`--content`, `--data`), `--help` does not say
so. In a terminal the command prompts for it. Without a terminal it prints the command help and exits 1. A missing
positional (for example the `text` of `sentiment`) prints Commander's `missing required argument` error and the
help on stderr and exits 1, in a terminal too. `--language` always takes a BCP-47 code (`en`, `de`, `cs`).

### Natural Language Processing

- `detect-language <text>`: `{ language, confidence }`.
- `sentiment <text>`: `{ score, label }`. The score goes from -1 to 1, the label is `positive`, `negative` or
  `neutral`.
- `tag <text> [--schemes <names...>] [--language <code>]`: `{ tokens: [{ text, tag, scheme }] }`, one token for each
  word and scheme (tokens whose tag is null are dropped).
  The schemes are `lexicalClass` (part of speech, the default), `nameType` (names of people, places and
  organizations), `lemma`, `sentimentScore` and `language`. Without `--language`, the bridge detects the language
  from the text.
- `entities <text>`: `[{ text, type }]`, where the type is `person`, `place` or `organization`. It is `tag` with the
  `nameType` scheme, filtered to names.
- `lemmatize <text> [--language <code>]`: the dictionary form of each word, as a list ("running" becomes "run").
- `keywords <text> [--max <n>]`: nouns, verbs and adjectives, `[{ word, lemma, lexicalClass }]`, default 10. Each
  word comes once, in the order of the text. The list is not ranked by importance.
- `embed <text> [--language <code>] [--type word|sentence]`: `{ vector, dimension }`, a 512-dimension vector.
  Defaults: `en`, `sentence`.
- `distance <text1> <text2> [--language <code>]`: the cosine distance of the two sentence embeddings,
  `{ distance, type: "cosine" }`. 0 means the same meaning, 2 the opposite. Default language `en`.
- `similar <text1> <text2> [--threshold <n>]`: `true` when the distance is below the threshold (default 0.5). It
  always uses English embeddings, because it has no `--language` flag.
- `relevance <query> <text> [--language <code>]`: a score from 0 to 1, computed as `1 - distance / 2`.
- `neighbors <text> [--count <n>] [--language <code>] [--type word|sentence]`: the words (or sentences) nearest to
  the input in Apple's embedding, `{ neighbors: [{ text, distance }] }`. Defaults: 5, `en`, `word`.

### Computer Vision

- `ocr <path> [--languages <codes...>] [--level accurate|fast] [--text-only]`: the text of an image file (JPEG,
  PNG, TIFF, HEIC or PDF) read by Apple Vision. Defaults: `en-US`, `accurate`. The full result is
  `{ text, blocks: [{ text, confidence, bounds }] }`, with bounds from 0 to 1 and the origin at the bottom-left
  corner. `--text-only` prints the text string only.

### Text Analysis (batch)

These commands take their texts in `--items` (required). `rank`, `batch-sentiment`, `group-by-language` and
`classify-batch` give each text an `id` from its position: `"0"`,
`"1"`, and so on. `deduplicate` returns plain strings, and `cluster` and `group-by-category` return `{ text }` only.

- `rank <query> --items <texts...> [--max-results <n>] [--language <code>]`: the items sorted by cosine distance to
  the query, closest first, `[{ item: { text, id }, score }]`. Here the score is the distance, so lower is closer.
  Without `--max-results` it returns every item.
- `batch-sentiment --items <texts...>`: `[{ id, score, label }]`.
- `group-by-language --items <texts...> [--min-confidence <n>]`: `{ "<code>": [{ id, language, confidence }] }`. A
  text below the confidence (default 0.7) goes under `unknown`.
- `deduplicate --items <texts...> [--threshold <n>] [--language <code>]`: each text is compared with the texts kept so far,
  and dropped when it is within the distance threshold (default 0.3) of one of them. The first text of each
  near-duplicate set stays, so a chain A~B~C can keep C.
- `cluster --items <texts...> [--threshold <n>] [--language <code>]`: `[{ items: [{ text }], centroid }]`. The first
  free text starts a cluster and takes every later free text within the threshold (default 0.5) of it. The centroid
  is the text of that first item.

`deduplicate` and `cluster` compare every pair, so the code notes them as fit for lists of up to about 200 items.

### Classification

Classification compares the sentence embedding of the text with the embedding of each label and picks the closest.
Labels that are short descriptive phrases ("bug report") work better than single words. The confidence is
`1 - distance / 2`.

- `classify <text> --categories <labels...> [--language <code>]`: `{ category, confidence, scores }`, with every label
  in `scores`, best first. `--categories` is required.
- `classify-batch --items <texts...> --categories <labels...> [--language <code>]`:
  `[{ id, category, confidence, scores }]`. Both lists are required.
- `group-by-category --items <texts...> --categories <labels...> [--language <code>]`: `{ "<label>": [{ text }] }`.
  Every label is in the result, an empty one too. Both lists are required.

### Text-to-Speech

- `speak <text> [--voice <name>] [--rate <n>]`: speaks the text with macOS `say`. It prints `{ "spoken": true }` as
  soon as `say` starts, without waiting for the speech to end. `--rate` is a cadence, not words per minute (see
  [Troubleshooting](#troubleshooting)).
- `list-voices`: the lines of `say -v ?`, one per voice: the name, the locale and a sample sentence.

### Authentication

- `check-biometry`: `{ available, biometry_type }`, where the type is `touchID`, `opticID` or `none`.
- `authenticate [reason]`: shows the system Touch ID prompt with your reason and prints `{ success }`.

### iCloud Drive

Paths are relative to the iCloud container that `icloud-status` prints, for example `/notes/todo.md`. The commands
that change files print `{ ok: true }`.

- `icloud-status`: `{ available, container_url }`.
- `icloud-read <path>`: `{ content }` of a text file.
- `icloud-write <path> --content <text>`: writes a text file. `--content` is required.
- `icloud-write-bytes <path> --data <base64>`: writes binary data given as base64. `--data` is required.
- `icloud-delete <path>`: deletes a file.
- `icloud-move <source> <destination>`: moves or renames a file.
- `icloud-copy <source> <destination>`: copies a file.
- `icloud-list <path>`: `[{ name, is_directory, size, modified }]` for a folder.
- `icloud-mkdir <path>`: creates a folder and any missing parents.
- `icloud-start-monitoring`, `icloud-stop-monitoring`: turn the bridge's change watch on or off. From this CLI they
  only prove that the call works (see [Troubleshooting](#troubleshooting)).

### System

- `capabilities`: `{ version, os, arch, methods }` of the bridge. `methods` maps each bridge method to
  `{ available, note }`. The bridge has more methods (CoreML, translation, speech recognition, calendar and others)
  than this CLI exposes.

### Global options

- `-V, --version` prints the CLI's own version (1.0.0). `capabilities` prints the bridge version.
- `-v, --verbose` turns on verbose logging.
- `--readme` prints this file.

## Input and output

### Lists

A list flag (`--items`, `--categories`, `--schemes`, `--languages`) takes its values in three ways, and you can mix
them:

```bash
tools darwinkit batch-sentiment --items "I love it,I hate it"          # split on commas
tools darwinkit batch-sentiment --items "I love it" "I hate it"        # several values after one flag
tools darwinkit batch-sentiment --items "I love it" --items "I hate it" # the flag more than once
```

Every value is split on commas, so a text that holds a comma becomes two texts. A list flag also takes every word
after it up to the next flag, so put the positional argument first: `classify "<text>" --categories a,b`.

### Output

- `--format pretty` (the default in a terminal) prints colored key and value lines.
- `--format json` (the default when stdout is a pipe) prints indented JSON.
- `--format raw` prints a string as it is, a list one item per line, and a number or boolean as text. An object with
  a `text` field and at most two keys prints only its `text` (so `ocr --format raw` prints the recognized text), and
  an object with only a `content` field prints that field (so `icloud-read --format raw` prints the file). Any other
  object prints as JSON.
- An unknown `--format` value is ignored, and the default for the terminal or the pipe applies.

### Interactive use

- `tools darwinkit` with no arguments in a terminal opens a menu: a group, then a command, then a prompt for each
  value. In a pipe it prints every command grouped as above and exits 0. `--help` prints the same commands as one
  flat list.
- A command with a required value missing prompts for every value you did not pass, when stdout is a terminal.
  Without a terminal it prints the command's help to stdout and exits 1.

## How it works

- The commands, their groups, flags and defaults are defined in `src/darwinkit/lib/commands.ts` (the `commands`
  registry, which drives `--help`, the menu and the prompts). Output goes through `formatOutput()` in
  `src/darwinkit/lib/format.ts`.
- The commands call the shared functions in `@genesiscz/utils/macos` (`detectLanguage`, `recognizeText`,
  `classifyText`, `rankBySimilarity` and the rest). Those use the `@genesiscz/darwinkit` SDK, which starts the Swift
  binary as `darwinkit serve` and talks JSON-RPC to it over stdin and stdout. For the text and image commands,
  Apple's NaturalLanguage and Vision frameworks do the work on the Mac, so the text and the images do not leave it.
  The iCloud commands sync by design.
- One bridge process serves a whole command. It starts at the first call and closes when the command ends
  (`closeDarwinKit()`). A request that takes longer than 60 seconds fails.
- The SDK looks for the binary in this order:
  1. a `bin/` folder in the npm package (version 0.8.1 ships none);
  2. `darwinkit` on your `PATH`;
  3. `~/.cache/darwinkit/latest/`, when its `version.json` names the SDK's version. Inside it,
     `DarwinKit.app/Contents/MacOS/darwinkit` wins over the plain `darwinkit` file;
  4. a download of `darwinkit-macos-arm64.tar.gz` from the `v<version>` release of the
     [darwinkit-swift](https://github.com/genesiscz/darwinkit-swift) repository into that cache folder;
  5. a build from source (`git clone`, then `swift build -c release --arch arm64`, with a 5 minute limit), when
     `swift` is installed.

  So the first run needs the network once, and later runs work offline. A new SDK version downloads its own binary.
- `speak` and `list-voices` do not use the bridge. `speak` goes through the shared text-to-speech layer to its macOS
  `say` engine, and `list-voices` runs `say -v ?`.
- `ocr` at the `accurate` level reads an image wider or taller than 6000 pixels in strips 5000 pixels tall and full width, cut with
  `sips` into temporary files that it deletes afterwards. The split helps tall images only: a very wide image falls
  back to a whole-image read and then to `fast`. An `accurate` read that finds no text is read again at the
  `fast` level.
- macOS privacy grants: the bridge is a plain child process, so macOS treats the app that started `tools` as its
  client. Through the GenesisTools launcher that is `GenesisTools.app`, and `tools macos permissions` shows its grants.
- The tool has no config file, no environment variables and no state of its own. The only files it writes are the
  binary cache in `~/.cache/darwinkit/latest/` and the warnings of the bridge in the GenesisTools day log
  (`~/.genesis-tools/logs/<date>.log`).

## For agents

- Pipe the output, or pass `--format json`, to get JSON. Without a terminal, error messages go to stderr.
- Exit codes: 0 on success, 1 on a failure (an error from the bridge, a value that is not a number, a required
  value missing). Cancelling the interactive menu or a prompt exits 0. Exception: `classify`, `classify-batch`,
  `group-by-category`, `rank`, `batch-sentiment`, `group-by-language`, `deduplicate` and `cluster` catch every bridge
  error per label or item, so they exit 0 with neutral results even when the bridge cannot start (`classify` then
  returns the first label with confidence 0, `rank` gives every item distance 2). Run `tools darwinkit capabilities`
  first (it exits 1 when the bridge fails), or treat confidence 0, distance 2 or all-neutral or all-unknown output as
  a failure.
- A missing `--items`, `--categories`, `--content` or `--data` without a terminal prints help text to stdout, not
  JSON. Check the exit code first.
- A batch command does not fail when one item fails. That item gets a neutral result instead: sentiment `neutral`
  with score 0, language `unknown`, distance 2 in `rank`, and the first label in `classify-batch` (with confidence 0)
  and `group-by-category`. `deduplicate` keeps the item, and `cluster` skips the pair.
- Each CLI call starts the bridge again. Code that needs many calls imports the same functions from
  `@genesiscz/utils/macos` and keeps one bridge open.
- There is no MCP server and no plugin skill for this tool.
- The tests start the real binary, so they are opt-in: `RUN_DARWINKIT=1 bun scripts/test.ts src/darwinkit` (about 30
  seconds). The `speak` tests play audio and also need `RUN_AUDIO_DEVICE=1`.

## Troubleshooting

- **"Could not find or install darwinkit binary"**: the download failed and no Swift toolchain could build it. The
  error message prints the release URL. Download it by hand, or put a `darwinkit` binary on your `PATH`. The eight
  commands that catch bridge errors (see For agents) never show this error; they return neutral results instead.
- **A method is missing or behaves like an old version**: a `darwinkit` on your `PATH` wins over the cache, even when
  it is older than the SDK. Check `which darwinkit` and `tools darwinkit capabilities`.
- **Intel Mac**: the release download and the automatic build are both arm64 (Apple silicon). Build darwinkit for
  your Mac yourself and put it on your `PATH`.
- **`speak --rate 200` is very fast, `--rate 3` very slow**: `--help` says "Words per minute", but the value is a
  cadence from 0 to 2, where 1 is the normal speed. A value above 2 counts as a percentage, so `150` means 1.5 and
  `3` means 0.03. The cadence maps to `say -r` 80 at 0, 175 at 1 and 350 at 2. A higher value stays at 350.
- **`speak` uses the wrong language**: the description says "auto language detection", but this path calls `say`
  with no voice when `--voice` is absent, so the system voice speaks. Pass a voice from `list-voices`.
- **A text with a comma turned into two items**: every list value is split on commas, and there is no escape. Reword
  the text.
- **`icloud-start-monitoring` reports nothing**: the command returns `{ ok: true }` and the bridge closes right after
  it, so no change event can arrive. Change events reach a long-running program through `onIcloudFilesChanged()` in
  `@genesiscz/utils/macos`.
- **`--help` does not mark a flag as required, but the command prompts or prints its help**: `--items`, `--categories`,
  `--content` and `--data` are required where the list above says so.

## Related

- [tools say](../say/README.md): speech with saved per-app profiles and other providers.
- [tools macos](../macos/README.md): `GenesisTools.app` and its privacy grants, and the Mail, Calendar and Reminders
  commands that use the same bridge.
- [tools indexer](../indexer/README.md): the `darwinkit` embedding model for code search.
- [tools automate](../automate/README.md): the `nlp.*` steps, which use the same NaturalLanguage functions.
