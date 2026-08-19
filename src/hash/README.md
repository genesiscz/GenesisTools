# tools hash

> **Compute and verify file checksums. Coreutils-compatible.**

One command for md5, sha1, sha256, sha512 and blake3, with output that `md5sum` and `shasum -c` understand, so you can hand the file to any other machine.

---

## Quick start

```bash
tools hash installer.dmg                        # sha256 by default
tools hash -a blake3 bigfile.tar                # blake3 is the fastest here
tools hash -a md5 "dist/**/*.js"                # quote globs

# Write a checksum file, then verify it later
tools hash "dist/**/*" > SHA256SUMS
tools hash -c SHA256SUMS
tools hash -c SHA256SUMS --quiet                # print only FAILED lines
```

## Arguments and options

| Item | Description |
|------|-------------|
| `[files...]` | Files or glob patterns to hash. Quote globs so the shell does not expand them. |
| `-a, --algo <algo>` | `md5`, `sha1`, `sha256`, `sha512` or `blake3` (default: `sha256`) |
| `-c, --check <file>` | Verify the checksum file at `<file>` instead of computing |
| `--quiet` | In `--check` mode, print only failing lines |
| `-v, --verbose` | Enable verbose logging |
| `--readme` | Print this file and exit |

---

## Notes

- Output format matches coreutils: `<hash>  <path>`, two spaces. That means `sha256sum -c` on Linux and `shasum -a 256 -c` on macOS can both verify a file this tool produced, and `--check` can read one they produced.
- `--check` exits non-zero when any line fails, which makes it usable as a CI gate.
- Prefer `blake3` when you control both ends and only need integrity. Prefer `sha256` when someone else has to verify, because it is the format everyone already has.
- ⚠️ `md5` and `sha1` are here for compatibility with checksums published by other people. Do not choose them for anything new.
