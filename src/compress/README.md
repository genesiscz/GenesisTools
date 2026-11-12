# tools compress

Compresses files and folders with zstd, checks every output before anything is removed, and writes each run into a
searchable ledger. Use it to shrink logs, exports and backup folders safely, to read the old GenesisTools day logs
that the daily pass compressed, and to run that daily pass by hand. The library behind it is
`@genesiscz/utils/compress` ([its README](../utils/compress/README.md) has the format, the API and the measured
numbers).

## Quick start

```bash
tools compress pack notes.log --dry-run            # the preset, the trial saving and the estimate; writes nothing
tools compress pack notes.log                      # writes notes.log.zst and checks it; notes.log stays
tools compress pack big.jsonl --remove-original    # removes big.jsonl only after the .zst decodes to the same sha256
tools compress unpack old-run.zst                  # restores old-run/ next to the archive; never overwrites
tools compress cat ~/.genesis-tools/logs/2026-10-20.log | rg '"pid":4242'   # an old day log, plain or .zst
tools compress ledger --since 2026-10-01           # every compression and restore since that day
```

## Commands

| Command | What it does |
|---|---|
| `pack <paths...>` | Compress a file to `<file>.zst`, a folder to `<folder>.zst` (tar inside zstd), verified |
| `unpack <archives...>` | Restore `<x>.zst` to `<x>/` (a folder) or `<x>` (a file); never overwrites |
| `verify <archive>` | Read a `.zst` end to end, optionally against the original |
| `cat <file>` | Write a file's content to stdout, a `.zst` one frame at a time |
| `try <path>` | Compress a sample with several presets, show saving and speed; writes nothing |
| `presets` | The presets and what each is for |
| `ledger` | Search every compression and restore |
| `daily` | Run the daily pass now: old day logs, ai-proxy transcripts, hang captures, agents objects |

Every command takes `-v` (`--verbose`) for debug lines. `tools compress --readme` prints this page.

### Transparent APFS compression

`transparent plan` reads native file metadata and prints candidates without changing them. `transparent apply`
keeps each file at the same path and size, verifies its bytes with `cmp`, preserves nanosecond mtime, and uses
kernel decmpfs compression. A later append works through the normal filesystem API and stores that file plain.

```bash
tools compress transparent --help
tools compress transparent plan --preset agents --json
tools compress transparent plan ~/Archive/transcripts --older 7d
tools compress transparent apply ~/Archive/transcripts
tools compress transparent apply ~/Archive/transcripts --algorithm lzfse --mirror ~/Archive=~/ArchiveBackup
```

The measured default is `afsctool -c -T LZFSE` when installed, with a verified maximum input size of
2,147,188,457 bytes. `--algorithm [zlib|lzvn|lzfse]` selects another supported codec. Without afsctool, the fallback
is `ditto --noclone --hfsCompression`, which emits LZVN on the measured macOS 27.2 and supports at most 512 MiB.
The stored decmpfs type is checked before replacement; a writer producing another algorithm is refused.
Oversized files remain untouched and appear in `skips.too-big` and `tooBigBytes`. Transcripts are never split.

The plan uses the native `tools du` walker for size, allocation, flags, link count, inode, exact mtime and clone ID.
It skips young files, files below the minimum, hard links, sparse and compressed files, placeholders and open files.
A failed or empty `lsof` pass stops apply. Apply skips battery power unless `--on-battery` is explicit.

Clone partners come from the existing clone metadata index, the current native listing, and explicit mirror hints.
Every partner is byte-compared before a compressed clone replaces it. Partners with different permissions, owner,
flags, ACLs or extended attributes are left untouched and earn no saving. Originals are held under `.cold-old-*` until
a final open-inode check, exact mtime/ctime checks and a stable byte comparison establish whether to retire or restore them. Descriptor appends
restore the original inode; when both versions changed, both are kept with a unique `.cold-conflict-*` name.
A later apply recovers a dead run's transaction files through the same preservation rules.

`sourceBytes` and `targetBytes` describe per-file allocation. `savedBytes` is conservative: each old aside's kernel
private bytes are read immediately before retirement, then the new clone family's allocation is subtracted.
An unknown external plain clone therefore earns zero saving even when a known partner was refreshed. The existing
ledger stores `format: "apfs-decmpfs-1"`, actual `algorithm`, `writer`, `releasedBytes` and `savedBytes`.

Configuration lives in the GenesisTools configuration under `du.compress`:

```jsonc
{
  "du": {
    "compress": {
      "defaults": { "olderThan": "3d", "minKb": 64, "exts": ["jsonl", "json", "txt", "log", "md"] },
      "harnesses": {
        "claude": { "roots": ["/path/to/claude/projects"], "mirrors": [{ "from": "/path/to/claude", "to": "/path/to/claude.bkp" }] }
      }
    }
  }
}
```

An absent configuration loads the existing Claude roots and mirror as defaults in memory. Other harness roots are
opt-in after writer evidence; SQLite is excluded by the extension filter. `tools du compressed`,
`tools du clonesize --compressed` and `tools du compressible` are read-only consumers. The optional daily
`du-cold-compress` task registers disabled through `tools du compression-schedule` and requires explicit operator
approval before it is enabled.

### pack

```bash
tools compress pack notes.log                      # notes.log.zst; the original stays
tools compress pack old-run/                       # old-run.zst (tar inside zstd); the folder stays
tools compress pack a.log b.log c.jsonl            # several inputs, one output each
tools compress pack export.csv -o ~/Archive/export.csv.zst
tools compress pack app.db --level 19              # a database copy you keep for years
tools compress pack x --dry-run                    # preset, trial saving, estimate; writes nothing
tools compress pack store/ --files-from day.txt -o day/store.zst --remove-original   # only the listed files
```

| Flag | Default | What it does |
|---|---|---|
| `--preset [name]` | `auto` | `text`, `tree`, `binary`, `database`, `media`, `fast`, `max`; no name lists them |
| `-l, --level <n>` | the preset's | zstd level |
| `--min-saving <percent>` | `30` | skip when the trial on a sample saves less |
| `--force` | off | compress even when the trial saves too little or the preset stores |
| `--remove-original` | off | remove the original after the output is verified |
| `--files-from <list>` | | pack only the files the list names (one folder input) |
| `--include-placeholders` | off | pack cloud placeholders as they are instead of refusing |
| `-o, --output <path>` | `<input>.zst` | output path (one input only) |
| `--dry-run` | off | show the preset, the trial saving and the estimate; write nothing |
| `--json` | off | machine-readable result |

A pack stops before it writes anything when the output already exists, when the trial saves under the minimum, when
the preset is `media` (without `--force`), when the source holds cloud placeholders, when the disk lacks room, or when
a folder's output would land inside that folder. With several inputs each one runs on its own, and any failure sets
exit status 1. The success line names both sizes, the ratio, the preset and level, and whether the original was kept.

### unpack

```bash
tools compress unpack old-run.zst                  # restores old-run/ next to it
tools compress unpack logs.zst --into /tmp/x       # a compressed file comes back as /tmp/x/logs
tools compress unpack old-run.tar.zst              # a .tar.zst is accepted too
tools compress unpack old-run.zst --remove-archive # the archive goes after the restore finished
```

| Flag | Default | What it does |
|---|---|---|
| `--into <dir>` | the archive's folder | folder to restore into |
| `--remove-archive` | off | remove the archive after the restore finished |
| `--json` | off | machine-readable result |

The archive's name decides the result: `x.zst` and `x.tar.zst` both restore `x`. A packed folder (the `ustar` magic in
the first frame) must hold exactly one top folder of that name, so an archive renamed after its pack is refused and
nothing is extracted; give it its old name back. Free space is checked first (the whole restored size plus 256 MiB).
The restored bytes are checked against the ledger (see [The ledger](#the-ledger)).

### verify

```bash
tools compress verify run.zst                      # every frame checksum; a folder's tar listed with a sha256 per file
tools compress verify run.zst --against run/       # every entry, size and sha256 against the folder
tools compress verify notes.log.zst --against notes.log   # size and sha256 of the file
tools compress verify day/store.zst --against store/ --files-from day.txt   # a list pack: only the listed files
```

`--against <path>` names the original file or folder. `--files-from <list>` needs `--against <folder>`. A folder mismatch
prints the counts of missing, different and extra entries, a file mismatch says `differs from <path>`. Both exit 1.
"does not decode" means the archive itself is
broken; a list that does not read, or a listed path outside the folder, names its own cause instead.

### cat

```bash
tools compress cat 2026-10-11.log.zst | rg '"pid":4242'
tools compress cat ~/.genesis-tools/logs/2026-10-20.log | jq -r .msg   # the plain name of a file now stored as .zst
tools compress cat export.csv.zst -o export.csv    # -o, --output <path>: write to a file instead of stdout
```

It needs no `zstd` CLI. It takes a `.zst`, a plain file (written out as it is), or the plain name of a file the daily
pass replaced by `<name>.zst`. It waits for a slow reader, so `| less` never queues the whole file in memory. An
`--output` that is the input itself (the same path, a hard link or a symlink to it) is refused before it is opened,
because opening it for writing would empty it. When neither `<name>` nor `<name>.zst` exists, it says so and exits 1.

`rg -z` is faster when the `zstd` CLI is installed. On a 292 MB day log, wall time: `rg -c` 60 ms, `rg -z` 105 ms,
`tools compress cat | rg` 226 ms (`scripts/benchmarks/compress/read-paths.ts`).

### try

```bash
tools compress try some/folder                     # the balanced pick
tools compress try export.csv --goal ratio         # the preset that saves the most
```

It compresses a sample (8 MiB in total, a third each from the start, middle and end of a file, a smaller file whole,
or the first 32 MiB of a folder's tar stream)
with `fast`, `text`, `tree`, `binary` and `max`, one thread each, and marks the pick with an arrow. `--goal [goal]`:

- `ratio`: the most saved.
- `speed`: the fastest of those within 90% of the best saving.
- `balanced` (default): the best saving times speed, among those within 95% of the best saving.

It warns when the best saving is under 30%, because `pack` would skip that data. Nothing is written and nothing goes
into the ledger.

### presets

`tools compress presets` prints the table in [Presets](#presets-and-the-minimum-saving). `--json` gives every field:
level, long mode, frame size, line alignment, threads and whether the preset stores.

### ledger

```bash
tools compress ledger                              # the newest 50 records
tools compress ledger --path migrate-home --since 2026-10-01
tools compress ledger --op unpack --caller cli --limit 10
tools compress ledger --min-size 100000000 --json  # sources of 100 MB or more, every field
```

| Flag | What it matches |
|---|---|
| `--path <text>` | the source or target path contains this text |
| `--since <when>` | started on or after: a date (local midnight), an ISO time, or `HH:MM` today |
| `--until <when>` | started on or before, the same forms |
| `--preset <name>` | the preset name |
| `--op [op]` | `compress`, `pack`, `decompress`, `unpack`, `remove`; no value lists them |
| `--caller <name>` | `cli`, `logs`, `ai-proxy-transcripts`, `app-hangs`, `codex-migrate-home`, `app-retired` |
| `--min-size <bytes>` | the source is at least this many bytes |
| `--limit <n>` | the newest N records (default 50) |
| `--json` | every field of each record |

A bare date is that day's local midnight, so `--until 2026-10-13` stops at the start of the 13th; pass
`--until 2026-10-14` to include it. The table shows the local start time, op, caller, source, both sizes, ratio and
preset with level. `remove` is a valid op, but no writer records it today.

### daily

```bash
tools compress daily --dry-run                     # per target what it would compress, and what agents-objects would keep or drop; writes nothing
tools compress daily                               # run it
tools compress daily --json                        # per target: files compressed, bytes, failures
```

It runs the compression and the agents-objects step of the pass the logger starts once a day (see
[The daily pass](#the-daily-pass)). The `tools rm` keepalive and the disk reserve run only in that detached pass.
`--dry-run --json` returns `{ targets: [{ target, root, firstPlainDay, files, bytes, finish }], objectStore }`. Only one pass runs per
logs folder: when another one holds the lock, this one says so, does nothing and exits 0. It exits 1 when a file did
not compress (its plain file is kept), or when the agents-objects step failed or found its own lock held.

## How it works

### Where things are

- **Outputs** go next to the input, or to `-o` (`pack`) and `--into` (`unpack`).
- **The ledger** is `~/.genesis-tools/compress/ledger.jsonl`.
- **Daily pass state** is in `~/.genesis-tools/logs/`: `.daily-compress-<day>` (today's claim),
  `.daily-compress.lock` (held while a pass runs), and `.digests/` (search results of finished days).
- **What it needs**: the system `tar` for folders (bsdtar on macOS, GNU tar on Linux). The `zstd` CLI is optional:
  only `rg -z` and `zstd -d` need it. No network, no account, nothing that costs money.

### The format

Every file is seekable zstd: independent frames (4 MiB for `text`, cut at line ends) and a seek table in a trailing
skippable frame. Any zstd decoder reads it as plain zstd (`zstd -d`, `zstdcat`, `rg -z`), and a tail read costs one
frame. Each frame carries zstd's content checksum, so a decoder rejects a damaged frame.

A folder archive is a tar stream inside that zstd. Extended attributes (Finder tags, quarantine) are not kept
(`--no-xattrs`, `COPYFILE_DISABLE=1`). A symlink inside the folder packs as a link and is not followed.

### Safety

- Output goes to a temp file and is renamed into place.
- A file's output is decompressed and hashed, and a folder's archive is listed with a sha256 per file, before
  anything else happens.
- The original is removed only with `--remove-original`, and only when it did not change while it was read. A file
  must still be the same file (device, inode, size, mtime and ctime), and every entry of a folder must still be what
  the check saw. Otherwise the run stops with "changed while it was compressed" (or "packed") and keeps both.
- Free space is checked first: the output needs room while the original still exists, and the refusal says how much.
  The estimate is the input size times the share the trial kept (at least 5%), plus 256 MiB.

### Cloud placeholders are refused

Before anything reads the data, `pack` looks at each file's metadata. A file with the `com.dropbox.placeholder` xattr
(a stub the old Dropbox app left; its bytes here are zeros) or with the `SF_DATALESS` flag (a File Provider file,
which a read would download) stops the run. Only a file with bytes in 0 blocks is asked for its flags, so an all-hole
sparse file or a decmpfs-compressed file packs as usual; where the flags cannot be read, such a file counts as
dataless. Off macOS nothing is a placeholder. A file given through a symlink is checked at its target, which is what
the compression reads; a symlink inside a folder packs as a link and is not followed.

The refusal names up to 20 of them and writes nothing: their real content lives in the cloud copy.
`--include-placeholders` packs them as they are, for a legacy folder where the stub is all that is left, and
`--remove-original` then removes them after the check like any other file. The check runs inside `packDirectory`
too, so folder retention (codex migrate-home backups, retired app bundles) keeps a folder with a placeholder.

### A list of files

`--files-from <list>` packs only the files the list names, with their parent folders, under the folder's name, and
checks each one like a folder pack. The list holds one path per line, relative to the one folder given (an absolute
path inside it works too). Empty lines are skipped, and a path may hold spaces. `--remove-original` then removes only
those files.

A folder, a missing path, a path outside the folder, or one reached through a symlinked folder is refused before
anything is written. On macOS and Linux a backslash in a listed path is part of the file name, as for any other path
there. `unpack` restores such an archive when it keeps the folder's name (`store.zst` holds `store/`), as for any
folder archive.

### Presets and the minimum saving

`--preset auto` (the default) picks by the data. A folder is `tree`, or `binary` when its name ends in `.app`. A file
is sniffed: magic bytes first (zstd, gzip, xz, bzip2, zip, 7z, JPEG, PNG, GIF, WebP, HEIC/MP4/MOV/M4A, Matroska are
`media`; SQLite is `database`; Mach-O, ELF and PE are `binary`), then text (no NUL byte, almost no control bytes),
then entropy (over 7.5 bits per byte is `media`, else `binary`). A trial that saves under 3% turns any guess into
`media`.

| Preset | Level | Long | Frame | Threads | For |
|---|---|---|---|---|---|
| `text` | 9 | no | 4 MiB, line-aligned | 4 | logs, JSON, JSONL, CSV, source files |
| `tree` | 9 | yes | 32 MiB | 4 | folders of source, node_modules, backups |
| `binary` | 9 | yes | 32 MiB | 4 | app bundles, executables, libraries |
| `database` | 9 | no | 16 MiB | 4 | SQLite (copy it closed or with `.backup` first) |
| `media` | stored | no | 32 MiB | 4 | already compressed: refused without `--force` |
| `fast` | 1 | no | 4 MiB | 4 | when the time to write matters more than size |
| `max` | 22 | yes | 32 MiB | 8 | kept for long; about 3 MB/s per thread |

Long mode has a 128 MiB window, so repeats across the files of a folder are found. `--level` overrides a preset's
level. The levels follow one rule (measured 2026-11-01 with `scripts/benchmarks/compress/levels.ts`): the lowest
level after which the next measured level costs more than 10 times the CPU per extra MB saved. That gives 9. On a real
1.0 GB day log, level 9 wrote 9.3 MB for 1.6 s of CPU and level 19 wrote 8.5 MB for 51 s. Levels 19 and 22 were
dropped as defaults that day; only `max` goes to 22. A read costs the same at every level.

**Minimum saving.** A level-3 trial on a sample runs first: 1 MiB in total (a third each from the start, middle and
end; a smaller file whole), or the
first 32 MiB of a folder's tar stream. Below 30% saving (`--min-saving <percent>`) the run is skipped with the
measured numbers: photos, video and audio save 0.2 to 7%, so they are left alone (`--force` overrides). The refusal
quotes the measurements of 2026-10-13, among them `.mov` 1.1%, `.mp4` 0.2 to 0.9% (screen recordings 14 to 36%),
`.heic` 0.2 to 1.9%, `.jpg` 0.2 to 4.4%, `.png` 0 to 5.4%, `.wav` 7.2%, `.pdf` 19 to 29%, text 43 to 94%. A forced
run whose trial saved under 3% still prints a warning.

### The ledger

`~/.genesis-tools/compress/ledger.jsonl` holds one line per operation: paths, sizes, ratio, preset, level, long mode,
frame size, threads, sha256 in and out, start and end time, host, Bun and zstd versions, the caller, and whether the
original was removed. The automatic passes (day logs, profiling logs, failure logs, ai-proxy transcripts, hang
captures, migrate-home backups, retired app bundles) record there too. A ledger that cannot be written never fails
the compression; the warning goes to the day log.

`inputSha256` is the sha256 of what the zstd writer took in, so `zstd -dc --long=31 <target> | shasum -a 256` prints
it: the file for a compress, the tar stream for a pack (hashed while it is written; packs before 2026-11-01 carry
none). `outputSha256` is the `.zst` file itself. `unpack` and a file restore check the restored stream against the
newest record that wrote the archive, and remove the output when it differs; a record without `inputSha256` is not
checked. Paths are recorded absolute (`-o tree.zst` too), and a restore finds the record by the file the archive path
names, symlinks resolved: `cd /tmp; tools compress unpack tree.zst` finds the record of `pack /tmp/tree`. A relative
target that an older checkout recorded matches nothing.

### The daily pass

The first GenesisTools process of each local day that opens a day log starts the pass: one exclusive create of
`.daily-compress-<day>` decides the winner, and the pass runs detached at low priority (15), so no command waits on
it. Before it compresses, it runs the `tools rm` keepalive against macOS tmp_cleaner and makes the `tools rm` disk
reserve. It compresses with the `text` preset, and a file modified in the last 2 hours always stays plain:

| Target (caller) | What becomes `.zst` |
|---|---|
| `logs` | `<date>.log`, `<date>-profiling.log`, `<date>-failures.jsonl` older than yesterday |
| `ai-proxy-transcripts` | `ai-proxy/transcripts/<UTC day>/<session>.jsonl` older than today (UTC) |
| `app-hangs` | `logs/hangs/hang-*.txt` and `stack-*.txt` older than yesterday |

Then the `agents-objects` step packs the agents change-log object store and drops the blobs that no change-log row of
the last 30 days names. A pass holds `<logs>/.daily-compress.lock` for its whole run, because two passes over one file
once deleted its only copy; `tools compress daily` beside the detached pass does nothing and says so. When an
ai-proxy session writes again after its file was compressed, the proxy restores the `.zst` under the plain name first.

A removed file can still hold its blocks while a process has it open. On 2026-11-01, 31 handles of launchers and idle
loggers kept 1.2 GB of removed day logs. So the logger closes its day file at midnight, and the pass cuts a removed
plain file to zero through its own handle 10 s after it removed it.

### Reading compressed files

Of the day files in `~/.genesis-tools/logs/` (`<date>.log`, `<date>-profiling.log`, `<date>-failures.jsonl`) only
today and yesterday stay plain. `tools compress cat` needs nothing and also takes the plain name of a file the daily
pass replaced (`tools compress cat ~/.genesis-tools/logs/2026-10-20.log | rg <pattern>`); `rg -z` reads a `.zst` (it
needs the `zstd` CLI). Every GenesisTools reader of day files and transcripts opens either form itself
(`tools genesis-tools logs day|failures|profile`, `tools daemon stats`, `tools jev sessions`,
`tools ai-proxy calls --show`).

### Other callers

`tools codex migrate-home` packs its older backup runs in `~/.genesis-tools/codex/migrate-home/`, and every app build
packs idle retired bundles in `~/.genesis-tools/app/retired.noindex/` with the `binary` preset. Restore either one
with `tools compress unpack <archive>.zst`; find it first with `tools compress ledger --caller codex-migrate-home` or
`--caller app-retired`.

## Configuration

There is no config file; everything is a flag. One environment variable:

| Variable | Effect |
|---|---|
| `GENESIS_TOOLS_NO_DAILY_COMPRESS=1` | the logger never starts the daily pass; `tools compress daily` still runs it |

The pass never starts in tests either.

## For agents

- `--json` works on every command except `cat`, which writes the content itself. JSON goes to stdout and messages to
  stderr. `pack` returns one item per input: a ledger record (plus `warning`) when it wrote; the plan with `refusal` and
  `wrote: false` for a dry run or a plan-time refusal (output exists, trial under the minimum, media preset; exit 1
  unless `--dry-run`); or `{ source, error }` for any other failure (missing source, cloud placeholders, output
  inside the folder, bad list, no free space, changed while compressed; exit 1, even with `--dry-run`). `unpack`
  failures are `{ archive, error }`. A dry run does not check free space.
- Exit status: 0 on success, 1 on a refusal, a failure, a mismatch or a usage error (the help prints after it), 130
  on Ctrl-C.
- `pack --dry-run` exits 0 for a plan-time refusal. Read `refusal` in its JSON item.
- An argument error the tool finds itself (a bad `--since`, `--files-from` without `--against`, an unknown
  `--preset`, `--op` or `--goal`) and a `verify` archive that does not decode print an error on stderr and no JSON,
  exit 1, and no help. Only Commander's own errors (unknown option, missing argument) print the help.
- `daily` exits 0 and returns `{ "skipped": "..." }` when another pass holds the lock.
- Bun 1.3.13 is supported, and its `node:zlib` zstd stops after the first frame of a multi-frame file with no error.
  Never decompress these files with `node:zlib` in code. Use `tools compress cat`, or the readers in
  `@genesiscz/utils/fs/read-lines` and `@genesiscz/utils/compress` ([library README](../utils/compress/README.md)).
- There is no MCP tool, no node-repl toolset and no plugin skill of its own. The `markdown` plugin skill and the
  repository's `performance` skill point at `tools compress cat <plain name>` for old day logs.

## Troubleshooting

- **"a level-3 trial saved N%, under the 30% minimum"**: the data is already compressed. Leave it, or pass `--force`
  or a lower `--min-saving`.
- **"the media preset stores data as it is"**: `--preset media` was given, or auto picked it. `--force` compresses
  anyway.
- **"already exists; move it away or pass another --output"**: the output path is taken. Move the old file away or
  pass `-o`.
- **"not enough free space in ..."**: the output needs room while the original still exists. Free some space, or pass
  `-o` to another disk.
- **"holds N cloud placeholders"**: their real content lives in the cloud copy. Download it first, or pass
  `--include-placeholders` to pack the stubs as they are.
- **"changed while it was compressed; both files kept"** (or "changed while it was packed"): something still writes
  the data. Run again when it is quiet.
- **"archive output must be outside the source folder"**: `-o` points into the folder you pack. Write the archive
  somewhere else.
- **"must contain only the top folder X; nothing extracted"**: the archive was renamed after its pack, or another tool
  made it. Give it the folder's name back.
- **"unpacked a tar stream with another sha256 than the pack the ledger recorded"** (a folder) or **"decompressed to
  other bytes than the original the ledger recorded"** (a file): the archive is not the one the ledger knows. The
  output was removed or never published; check the archive with `verify`.
- **"another daily pass is running"**: the detached pass is at work. Wait, then check
  `tools compress ledger --caller logs`.
- **`rg` finds nothing in an old day log**: the day is now `<date>.log.zst`. Use `tools compress cat <plain name> | rg`
  or `rg -z`.
- **The disk did not get the space back**: APFS clones (`cp -c`) share blocks, so `du` over-counts and removing one
  clone frees almost nothing. Measure with `tools du clonesize <dir>` before and after, and pack a clone family
  together. Or a running process still holds a removed file open (see [The daily pass](#the-daily-pass)).

For anything else, run the command with `-v`, or read `~/.genesis-tools/logs/<today>.log` and search it for
`compress`.

## Related

- [`@genesiscz/utils/compress`](../utils/compress/README.md): the format, the API, the presets and every benchmark.
- [`tools du`](../du/README.md): `clonesize` measures APFS clone families before and after a pack.
- [`tools genesis-tools`](../genesis-tools/README.md): `logs day|failures|profile` read compressed day files.
- [`tools daemon`](../daemon/README.md): `stats` keeps the search results of finished days.
- [`tools jev`](../jev/README.md): `sessions` reads compressed day logs.
- [`tools ai-proxy`](../ai-proxy/README.md): its transcripts are compressed by the daily pass.
- [`tools codex`](../codex/README.md): `migrate-home` packs its old backup runs.
- [`tools rm`](../rm/README.md): the daily pass runs its keepalive and disk reserve.
- [`tools agents`](../agents/README.md): the object store the `agents-objects` step packs.
