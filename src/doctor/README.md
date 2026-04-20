# tools doctor

Diagnose and fix common macOS dev-machine problems — disk bloat, memory pressure, runaway processes, dev-cache cruft — with tiered safety and two renderers.

## Usage

    tools doctor                      # interactive TUI dashboard (default)
    tools doctor --plain              # linear clack flow (pipe-safe, CI-safe)
    tools doctor --only disk-space,memory
    tools doctor --thorough           # no time caps on deep scans
    tools doctor --dry-run            # show what would happen, change nothing
    tools doctor --json               # machine-readable output

## Subcommands

    tools doctor find --min-mb 500 --max-days 30   # ad-hoc "X files in last Y days bigger than Z"
    tools doctor log --since 7d                    # recent actions
    tools doctor stats --since 30d                 # rolled-up reclaim totals
    tools doctor wipe-cache                        # force next run to be fresh

## Safety tiers

Every finding is tagged:

- **safe** — green, executes on Apply
- **cautious** — yellow, yes/no confirm
- **dangerous** — red, must type a confirmation phrase
- **blocked** — gray, disabled with reason (e.g. JetBrains cache, kernel_task)

## Trash staging

Deletes from `disk-space` and `dev-caches` default to **moving items to the Trash**. Items stay there until you confirm with `DELETE` to empty the Trash permanently. If you quit mid-way, items stay in the Trash and Finder's "Put Back" works to restore.

## Persistence

State lives under `~/.genesis-tools/doctor/`:

- `analysis/<run-id>/` — per-run raw JSON results
- `cache/` — analyzer caches (respect per-analyzer TTLs)
- `history.jsonl` — append-only log of every executed action
- `stats.json` — rolled-up aggregates
- `blacklist.json` — your extra cache-glob overrides

## Configuration

Override the cache blacklist by creating `~/.genesis-tools/doctor/blacklist.json`:

    {
        "cacheGlobs": [
            "~/Library/Caches/com.example.myapp/**"
        ]
    }

## Performance

- Cold start < 200 ms.
- Standard scan < 6 s.
- `--thorough` < 30 s.
- Install `fd` (`brew install fd`) for ~10× faster file walks — the tool offers a one-tap install when missing.
