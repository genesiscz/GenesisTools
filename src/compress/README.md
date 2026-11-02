# tools compress

zstd for files and folders, with a check before anything is removed and a ledger of every run. The library behind
it is `@genesiscz/utils/compress` (`src/utils/compress/README.md`: format, presets, numbers).

```bash
tools compress pack notes.log                 # notes.log.zst; the original stays
tools compress pack video_files/              # video_files.zst (tar inside zstd); the folder stays
tools compress pack big.jsonl --remove-original   # removes big.jsonl only after the .zst decodes to the same sha256
tools compress pack x --dry-run               # preset, trial saving, estimate; writes nothing
tools compress pack store/ --files-from day.txt -o day/store.zst --remove-original   # only the listed files
tools compress unpack video_files.zst         # restores video_files/ next to it; refuses to overwrite
tools compress unpack logs.zst --into /tmp/x  # a compressed file comes back as logs
tools compress verify run.zst --against run/  # every entry, size and sha256
tools compress cat 2026-10-11.log.zst | rg '"pid":4242'
tools compress try some/folder --goal ratio   # several presets on a sample: saving and speed
tools compress presets
tools compress ledger --path migrate-home --since 2026-10-01
tools compress daily --dry-run                # what the once-a-day pass would compress, keep and drop now
```

- **Safety.** Output goes to a temp file and is renamed into place. A file's output is decompressed and hashed, a
  folder's archive is listed with a sha256 per file, before anything else happens. The original is removed only with
  `--remove-original`, and only when it did not change while it was read. Free space is checked first: the output
  needs room while the original still exists, and the refusal says how much.
- **Cloud placeholders are refused.** Before anything reads the data, `pack` looks at each file's metadata: a file
  with the `com.dropbox.placeholder` xattr (a stub the old Dropbox app left, its bytes here are zeros) or with the
  `SF_DATALESS` flag (a File Provider file, which a read would download) stops the run. Only a file with bytes in 0
  blocks is asked for its flags, so an all-hole sparse file or a decmpfs-compressed file packs as usual. A file
  given through a symlink is checked at its target, which is what the compression reads; a symlink inside a folder
  packs as a link and is not followed.
  The refusal names up to 20 of them and writes nothing: their real content lives in the cloud copy.
  `--include-placeholders` packs them as they are, for a legacy folder where the stub is all that is left, and
  `--remove-original` then removes them after the check like any other file. The check runs inside `packDirectory`
  too, so folder retention (codex migrate-home backups, retired app bundles) keeps a folder with a placeholder.
- **A list of files.** `--files-from <list>` packs only the files the list names (one path per line, relative to the
  one folder given), with their parent folders, under the folder's name, and checks each one like a folder pack.
  `--remove-original` then removes only those files. A folder, a missing path, a path outside the folder or one
  reached through a symlinked folder is refused before anything is written. On macOS and Linux a backslash in a
  listed path is part of the file name, as for any other path there. `unpack` restores such an archive when
  it keeps the folder's name (`store.zst` holds `store/`), as for any folder archive.
- **Minimum saving.** A level-3 trial on a sample (1 MiB of a file, the first 32 MiB of a folder's tar stream) runs
  first. Below 30% saving (`--min-saving <percent>`) the run is skipped with the measured numbers: photos, video and
  audio save 0.2 to 7%, so they are left alone (`--force` overrides).
- **Presets.** `--preset auto` (default) sniffs magic bytes, then text, then entropy. `text` (logs, JSON, JSONL),
  `tree` (folders), `binary` (app bundles), `database`, `media` (store), `fast`, `max`.
- **Ledger.** `~/.genesis-tools/compress/ledger.jsonl`, one line per operation: paths, sizes, ratio, preset, level,
  long mode, frame size, threads, sha256 in and out, start and end time, host, Bun and zstd versions. The automatic
  passes (day logs, profiling logs, failure logs, ai-proxy transcripts, hang captures, migrate-home backups, retired
  app bundles) record there too.
  `inputSha256` is the sha256 of what the zstd writer took in, so `zstd -dc --long=31 <target> | shasum -a 256`
  prints it: the file for a compress, the tar stream for a pack (hashed while it is written; packs before 2026-11-01
  carry none). `outputSha256` is the `.zst` file itself. `unpack` and a file restore check the restored stream
  against the newest record that wrote the archive and remove the output when it differs; a record without
  `inputSha256` is not checked. Paths are recorded absolute (`-o tree.zst` too), and a restore finds the record by
  the file the archive path names, symlinks resolved: `cd /tmp; tools compress unpack tree.zst` finds the record of
  `pack /tmp/tree`. A relative target that an older checkout recorded matches nothing.
- **Reading compressed files.** Of the day files in `~/.genesis-tools/logs/` (`<date>.log`, `<date>-profiling.log`,
  `<date>-failures.jsonl`) only today and yesterday stay plain. `tools compress cat` needs nothing and also takes the
  plain name of a file the daily pass replaced (`tools compress cat ~/.genesis-tools/logs/2026-10-20.log | rg <pattern>`);
  `rg -z` reads a `.zst` (it needs the `zstd` CLI). Every GenesisTools reader of day files and transcripts opens either
  form itself (`tools genesis-tools logs day|failures|profile`, `tools daemon stats`, `tools jev sessions`).
