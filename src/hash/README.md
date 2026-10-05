# tools hash

> **Compute and verify file checksums. Coreutils-compatible.**

One command for md5, sha1, sha256, sha512 and blake3, with output that `md5sum` and `shasum -c` understand, so you can hand the file to any other machine.

---

## Quick start

```bash
tools hash installer.dmg                        # sha256 by default
tools hash -a blake3 bigfile.tar                # blake3 digest, from WebAssembly (see Notes)
tools hash -a md5 "dist/**/*.js"                # quote globs
tools hash dist/                                # a directory: every file under it, sorted
cat data.bin | tools hash                       # stdin (also: tools hash -)

# Write a checksum file, then verify it later
tools hash "dist/**/*" > SHA256SUMS
tools hash -c SHA256SUMS
tools hash -c SHA256SUMS --quiet                # print only FAILED lines
tools hash -c SHA256SUMS -s && echo intact      # no output, exit code only
```

## Arguments and options

| Item | Description |
|------|-------------|
| `[files...]` | Files, directories, `-` (stdin) or glob patterns to hash. Quote globs so the shell does not expand them. With no file and input piped in, it hashes stdin. |
| `-a, --algo <algo>` | `md5`, `sha1`, `sha256`, `sha512` or `blake3` (default: `sha256`) |
| `-c, --check <file>` | Verify the checksum file at `<file>` (`-` for stdin) instead of computing |
| `-q, --quiet` | In `--check` mode, print only failing lines |
| `-s, --status` | In `--check` mode, print nothing; the exit code says whether everything matched |
| `-w, --warn` | In `--check` mode, name each improperly formatted line |
| `--strict` | In `--check` mode, exit 1 when any line is improperly formatted |
| `--ignore-missing` | In `--check` mode, skip files that do not exist instead of failing |
| `-v, --verbose` | Enable verbose logging |
| `--readme` | Print this file and exit |

---

## Notes

- Output format matches coreutils: `<hash>  <path>`, two spaces. That means `sha256sum -c` on Linux and `shasum -a 256 -c` on macOS can both verify a file this tool produced, and `--check` can read one they produced. A path with a backslash or a newline is written escaped, with a leading `\`, as coreutils writes it.
- `--check` behaves as `shasum -c` does, line for line. It prints `<path>: OK` or `<path>: FAILED`, `FAILED open or read` for a file it cannot read, and a `WARNING` count on stderr. It exits 1 when any file failed, when the checksum file has no properly formatted line, or, with `--strict`, when any line is improperly formatted. A line is `<hex>`, one space or tab, a space (text) or `*` (binary), then the path. A single space before the path, a blank line and a CRLF line ending are not accepted, exactly as in `shasum -c`. A `#` at the start of a line is a comment.
- `--check` takes each line's algorithm from its digest length (32 digits md5, 40 sha1, 64 sha256, 128 sha512), so one file can mix them. 64 digits means sha256; pass `-a blake3` to read them as blake3. A BSD tag line (`SHA256 (file) = hex`) names its own algorithm. When you pass `-a`, a line of another length is improperly formatted.
- Paths in a checksum file are relative to the directory you run the command from, as with `shasum -c`, not to the checksum file.
- A directory argument is hashed file by file, recursively and sorted by path. A symlink to a file is followed. A symlink to a directory is not entered. A missing path prints `hash: <path>: No such file or directory`, the other files still run, and the exit code is 1.
- Prefer `sha256` for almost everything. It is the format everyone already has, and it is the fastest option here. Choose `blake3` only when the other end needs it, because it is not in coreutils and runs slower in this tool (see Speed and memory).
- ⚠️ `md5` and `sha1` are here for compatibility with checksums published by other people. Do not choose them for anything new.

## Speed and memory

Files are read through one reused 1 MiB buffer, so memory stays flat however large the file is. md5, sha1, sha256 and sha512 run on the runtime's native hasher. blake3 is not among the algorithms Bun's native hasher offers (Bun 1.4.2), so it runs as WebAssembly through `hash-wasm`, loaded only when you ask for it. Measured on 2026-10-05 00:46 on an Apple M4 Max, best of three, on a 629,145,600 byte random file:

- sha256 took 3.64 s before and 0.35 s after. sha1 took 1.52 s before and 0.30 s after. sha512 took 1.92 s before and 0.46 s after. md5 took 1.26 s before and 0.88 s after.
- blake3 took 1.42 s before and 1.40 s after, because it still runs as WebAssembly.
- Peak memory was 74 to 77 MiB before and 46 MiB after, against a floor of 43 MiB for hashing a 3-byte file.
