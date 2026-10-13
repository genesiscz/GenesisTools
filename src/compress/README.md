# tools compress

zstd for files and folders, with a check before anything is removed and a ledger of every run. The library behind
it is `@genesiscz/utils/compress` (`src/utils/compress/README.md`: format, presets, numbers).

```bash
tools compress pack notes.log                 # notes.log.zst; the original stays
tools compress pack video_files/              # video_files.zst (tar inside zstd); the folder stays
tools compress pack big.jsonl --remove-original   # removes big.jsonl only after the .zst decodes to the same sha256
tools compress pack x --dry-run               # preset, trial saving, estimate; writes nothing
tools compress unpack video_files.zst         # restores video_files/ next to it; refuses to overwrite
tools compress unpack logs.zst --into /tmp/x  # a compressed file comes back as logs
tools compress verify run.zst --against run/  # every entry, size and sha256
tools compress cat 2026-10-11.log.zst | rg '"pid":4242'
tools compress try some/folder --goal ratio   # several presets on a sample: saving and speed
tools compress presets
tools compress ledger --path migrate-home --since 2026-10-01
tools compress daily --dry-run                # what the once-a-day pass would compress now
```

- **Safety.** Output goes to a temp file and is renamed into place. A file's output is decompressed and hashed, a
  folder's archive is listed with a sha256 per file, before anything else happens. The original is removed only with
  `--remove-original`, and only when it did not change while it was read. Free space is checked first: the output
  needs room while the original still exists, and the refusal says how much.
- **Minimum saving.** A level-3 trial on a sample (1 MiB of a file, the first 32 MiB of a folder's tar stream) runs
  first. Below 30% saving (`--min-saving <percent>`) the run is skipped with the measured numbers: photos, video and
  audio save 0.2 to 7%, so they are left alone (`--force` overrides).
- **Presets.** `--preset auto` (default) sniffs magic bytes, then text, then entropy. `text` (logs, JSON, JSONL),
  `tree` (folders), `binary` (app bundles), `database`, `media` (store), `fast`, `max`.
- **Ledger.** `~/.genesis-tools/compress/ledger.jsonl`, one line per operation: paths, sizes, ratio, preset, level,
  long mode, frame size, threads, sha256 in and out, start and end time, host, Bun and zstd versions. The automatic
  passes (day logs, ai-proxy transcripts, migrate-home backups, retired app bundles) record there too.
- **Reading compressed files.** `rg -z` reads a `.zst` (it needs the `zstd` CLI); `tools compress cat` needs nothing.
  Every GenesisTools reader of day logs and transcripts opens either form itself.
