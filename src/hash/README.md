# tools hash

Compute and verify file checksums with md5, sha1, sha256, sha512 or blake3. The output is the coreutils format, so
`sha256sum -c` on Linux and `shasum -a 256 -c` on macOS can verify a list this tool wrote, and `tools hash -c` can
verify a list they wrote.

## Quick start

```bash
tools hash installer.dmg                        # sha256 of one file (the default)
tools hash -a blake3 dist/                      # blake3 of every file under dist/
cat data.bin | tools hash -a sha512             # hash stdin
tools hash 'dist/**/*.js' > SHA256SUMS          # write a checksum file (quote the glob)
tools hash -c SHA256SUMS                        # verify it later; exit 1 on any failure
tools hash -c SHA256SUMS -s && echo intact      # exit code only, no OK lines
```

## Commands

`tools hash` has no subcommands. It computes checksums by default, and `-c` switches it to verify a checksum file.
Files and `-c` together are an error (`Cannot pass files together with --check.`).

| Flag | Default | What it does |
|------|---------|--------------|
| `[files...]` | stdin | Files, directories, `-` (stdin) or quoted glob patterns |
| `-a, --algo <algo>` | `sha256` | `md5`, `sha1`, `sha256`, `sha512` or `blake3` |
| `-c, --check <file>` | | Verify the checksum file `<file>` (`-` for stdin) |
| `-q, --quiet` | | Check mode: print only the FAILED lines |
| `-s, --status` | | Check mode: print no result lines; read the exit code |
| `-w, --warn` | | Check mode: name each improperly formatted line |
| `--strict` | | Check mode: exit 1 when any line is improperly formatted |
| `--ignore-missing` | | Check mode: skip listed files that do not exist |
| `-v, --verbose` | | Show debug log lines, such as how many files a glob gave |
| `--readme` | | Print this file and exit |
| `-h, --help` | | Print the flags, the algorithm list and examples |

### Compute checksums

```bash
tools hash a.txt b.txt                          # several files, in argument order
tools hash -a md5 'dist/**/*.js'                # a quoted glob, expanded by the tool
tools hash dist/                                # every file under dist/, sorted
tools hash -                                    # stdin, printed as '-'
tools hash dist/ > SHA256SUMS                   # a checksum file for a whole tree, dot files too
```

Each file gives one line on stdout, `<hash>  <path>` with two spaces, the format coreutils writes:

```
$ printf abc | tools hash
ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -
```

How the arguments turn into files:

- A file is hashed under the path you wrote. A path with a backslash or a newline is written escaped, with a leading
  `\` on the line, as coreutils writes it.
- A directory is hashed file by file, recursively, sorted by name inside each directory. Dot files are included. A
  symlink to a file is followed. A symlink to a directory is not entered when it turns up inside a directory, but one
  you name yourself as an argument is treated as that directory. A subdirectory it cannot read gets an error line and
  makes the exit code 1, and the files around it still run.
- An argument with `*`, `?`, `[`, `]`, `{` or `}` is a glob, unless a file with exactly that name exists. Its matches
  are sorted, and directories are skipped. Dot files are not matched (the `glob` package default), so hash the
  directory itself when you need them. Quote a glob so the shell does not expand it first.
- `-` is stdin. With no file at all, the tool reads stdin when stdin is not a terminal. On a terminal it stops with
  `No files given.` and exit 1.
- The same path named twice is hashed once.
- A glob that matches nothing prints `hash: <pattern>: No such file or directory` and makes the exit code 1.
- A missing path prints `hash: <path>: No such file or directory` on stderr. The other files still run, and the exit
  code is 1. When the arguments give no file at all (an empty directory), it prints `No files matched.` and exits 1.

### Verify a checksum file

```bash
tools hash -c SHA256SUMS                        # one OK or FAILED line per file
tools hash -c SHA256SUMS --quiet                # print only the FAILED lines
tools hash -c SHA256SUMS --ignore-missing       # skip listed files that are gone
tools hash -c SHA256SUMS -w --strict            # name the bad lines, and fail on them
tools hash -a blake3 -c B3SUMS                  # read 64-digit lines as blake3
cat SHA256SUMS | tools hash -c -                # the list itself comes from stdin
```

`--check` behaves as `shasum -c` does, line for line. Lines that start with `hash:` go to stderr:

```
$ tools hash -c SHA256SUMS
dist/app.css: OK
dist/app.js: FAILED
hash: dist/old.js: No such file or directory
dist/old.js: FAILED open or read
hash: WARNING: 1 listed file could not be read
hash: WARNING: 1 computed checksum did NOT match
```

- **Line format.** A line is `<hex>`, one space or tab, a space (text mode) or `*` (binary mode), then the path.
  Spaces or tabs before the hex are allowed, and uppercase hex is accepted. A `#` at the start of a line is a comment.
  A BSD tag line (`SHA256 (file) = <hex>`, as macOS `md5` and `shasum --tag` print it) is read too, but the tool
  always writes the coreutils form.
- **Not accepted, as in `shasum -c`.** A single space before the path and a blank line are improperly formatted. They
  are skipped, named by `-w`, and fail the run only with `--strict`. Without `-s`, the run ends with `hash: WARNING:
  <n> lines are improperly formatted` on stderr. In a `<hex>  <path>` line, a CRLF ending stays part of the path, so
  that file is not found. A BSD tag line is not affected.
- **Algorithm per line.** Each line's algorithm comes from its digest length: 32 digits md5, 40 sha1, 64 sha256, 128
  sha512. One file can mix them. blake3 also has 64 digits, so pass `-a blake3` to read 64-digit lines as blake3. A
  BSD tag line names its own algorithm, and a tag with the wrong digest length is improperly formatted. When you pass
  `-a`, a coreutils line of another length is improperly formatted. A BSD tag line keeps the algorithm it names.
- **Paths.** A path in the list is relative to the directory you run the command from, as with `shasum -c`, not to the
  checksum file. A listed directory fails as `FAILED open or read` (`Is a directory`).
- **Stdin entries.** A line whose path is `-` is checked against stdin, so a list made from piped data round-trips:
  `printf abc | tools hash > stdin.sums`, then `printf abc | tools hash -c stdin.sums` prints `-: OK`. With `-c -` the
  list already holds stdin, so a `-` line fails with `standard input already holds the checksum list`.
- **Quiet and status.** `-q` hides the OK lines only. `-s` prints no OK or FAILED lines, no WARNING counts and no
  summary, but an unreadable file, a checksum file with no valid line, and the `-w` lines still get a line on stderr.
  When every file matched and `-s` is off, a closing `all <n> checksums OK` line goes to stderr.
- **Exit 1** when any file failed or could not be read, when the checksum file cannot be read or has no properly
  formatted line, with `--strict` when any line is improperly formatted, and with `--ignore-missing` when every listed
  file was missing (`no file was verified`). `--ignore-missing` skips only missing files: a directory or a permission
  error still fails.

## Choosing an algorithm

| Algorithm | Hex digits | Use it for |
|-----------|-----------:|------------|
| `md5` | 32 | checksums other people published |
| `sha1` | 40 | checksums other people published |
| `sha256` | 64 | the default, the one everyone can verify |
| `sha512` | 128 | a longer digest, same trust as sha256 |
| `blake3` | 64 | only when the other end asks for it |

- Prefer `sha256` for almost everything. It is the format everyone already has, and it is faster here than sha512 and
  blake3 (0.35 s against 0.30 s for sha1 on 600 MB).
- Choose `blake3` only when the other end needs it. It is not in coreutils, and it runs slower in this tool (see Speed and memory).
- ⚠️ `md5` and `sha1` are here for compatibility with checksums published by other people. Do not choose them for anything new.

## How it works

- The tool reads files and stdin and writes text. It keeps no config, no cache and no state, needs no app on the Mac,
  makes no network call, and costs nothing.
- md5, sha1, sha256 and sha512 run on Bun's native hasher (`Bun.CryptoHasher`). blake3 is not among the algorithms
  that hasher offers (Bun 1.4.2), so it runs as WebAssembly through the `hash-wasm` package, which installs with
  GenesisTools and loads only when you ask for blake3.
- stdout carries only the checksum lines (compute mode) or the `<path>: OK` and `<path>: FAILED` lines (check mode).
  Errors, warnings and the summary go to stderr, so a redirect captures a clean list.
- In compute mode, a read failure other than a missing file (a permission or I/O error) also prints a WARN record with
  the full error on stderr, and writes it to the shared GenesisTools log, `~/.genesis-tools/logs/<date>.log`. A
  checksum file that cannot be read prints an ERROR record in the same way. `No files matched.` is followed by a WARN
  line. Debug records, a missing file included, go only to the day log unless you pass `-v`. Check mode writes no WARN
  for a listed file it cannot read.

### Speed and memory

Files are read through one reused 1 MiB buffer, so memory stays flat however large the file is. Measured on 2026-10-05
00:46 on an Apple M4 Max, best of three, on a 629,145,600 byte random file. "Before" is the earlier version, which ran
all five algorithms as WebAssembly; "after" is the native hasher with the reused buffer:

- sha256 took 3.64 s before and 0.35 s after. sha1 took 1.52 s before and 0.30 s after. sha512 took 1.92 s before and
  0.46 s after. md5 took 1.26 s before and 0.88 s after.
- blake3 took 1.42 s before and 1.40 s after, because it still runs as WebAssembly.
- Peak memory was 74 to 77 MiB before and 46 MiB after, against a floor of 43 MiB for hashing a 3-byte file.

## For agents

- There is no `--json`. The coreutils text format is the machine format: one `<hash>  <path>` line per file on stdout,
  and `<path>: OK`, `<path>: FAILED` or `<path>: FAILED open or read` per line in check mode.
- Exit code 0 means every file was hashed, or every listed file matched. Exit code 1 means anything else: a missing or
  unreadable input, no file matched, a FAILED line, a bad checksum file, an unknown algorithm, or files passed with
  `-c`.
- The tool never prompts. Always pass a path. Pass `-` (or no file) only when you pipe data in, because the tool reads stdin until it ends.
- There is no MCP tool and no plugin skill for it.

## Troubleshooting

- **`zsh: no matches found: dist/**/*.js`.** The shell expanded the glob before the tool ran and found nothing. Quote
  the pattern: `tools hash 'dist/**/*.js'`.
- **The checksum file lists itself, and its line fails later.** The shell creates `SHA256SUMS` before the tool starts,
  so `tools hash . > SHA256SUMS` or a quoted glob over the current directory hashes the empty or half-written list.
  Write the list outside the tree you hash, or hash a subdirectory such as `dist/`.
- **Every line says `FAILED open or read`.** The paths in the list are relative to where you run the command. `cd` to
  the directory the list was made from, then run `tools hash -c` with the path to the list.
- **A list from Windows fails on every file.** In `<hex>  <path>` lines, the CRLF line endings stay in the paths (BSD
  tag lines are not affected). Remove them first: `tr -d '\r' < SHA256SUMS.txt > SHA256SUMS`.
- **`no properly formatted checksum lines found`.** No line matched the format, often because the hex and the path are
  separated by a single space. Run with `-w` to see the line numbers, and use two spaces (or ` *` for binary mode).
- **Every 64-digit line fails for a blake3 list.** 64 digits read as sha256 unless you pass `-a blake3`.
- **Dot files are missing from the output.** A glob does not match dot files. Name the directory instead: `tools hash dist/`.
- **`tools hash` prints nothing and does not exit.** It got no file, and stdin is not a terminal, so it waits for
  stdin to end. Pass the file, or `< /dev/null` when the empty-input digest is what you want.
