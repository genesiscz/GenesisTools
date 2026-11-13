# tools secrets

Find hardcoded API keys, tokens and private keys in a source tree, and reversibly redact secrets and personal data
from text before an AI sees it. `scan` exits non-zero on findings, so it works as a pre-commit or CI gate, and
`redact` swaps secrets, emails, IPs and your home path for placeholders that `redact restore` puts back into the
model's answer.

## Quick start

```bash
tools secrets scan .                                # scan this directory; exit 1 when anything is found
tools secrets scan src/ --ignore 'EXAMPLE_KEY'      # one subtree, with one allowlisted false positive
tools secrets scan . --json | tools json            # machine-readable result, as TOON or compact JSON
tools secrets redact --clipboard                    # redact the clipboard in place, then paste it into the AI
tools secrets redact restore --clipboard            # put the real values back into the answer you copied
tools secrets redact --in error.log --out safe.log  # redact a file into a new file
```

## Commands

| Command | What it does |
|---------|--------------|
| `scan [dir]` | Scan a directory for hardcoded secrets. Exit 0 when clean, 1 on findings. |
| `redact` | Redact secrets and personal data in text. Same as `redact run`. |
| `redact run` | The redactor. A named default, so `--in`, `--out` and `--map` after `restore` reach `restore`. |
| `redact restore` | Swap the placeholders in a text back to the original values. |

Every command takes `-h, --help`. The root takes `-v, --verbose` (debug logging, accepted after any subcommand),
`--readme` (print this page) and `-V, --version`.

### scan

```bash
tools secrets scan [dir] [options]
```

| Flag | Default | What it does |
|------|---------|--------------|
| `--json` | off | Print the result as JSON instead of the table |
| `--no-gitignore` | gitignore on | Also scan the files that `<dir>/.gitignore` excludes |
| `--ignore <regex>` | none | Drop a finding when the regex matches the secret or its line. Repeatable. |
| `--max-size <kb>` | `1024` | Skip files larger than this many KB. Must be a positive integer. |
| `--no-entropy` | entropy on | Turn off the `high-entropy-base64` detector |

`dir` is a directory, never a single file. Without `dir`, a terminal session asks "Directory to scan:" with `.`
filled in; without a terminal (a hook, CI, a pipe on stdin) it scans the current directory. Pass `dir` in scripts.

```bash
tools secrets scan . --no-entropy        # patterns and assignments only, for a tree of generated output
tools secrets scan . --max-size 256      # skip every file over 256 KB
tools secrets scan . --no-gitignore      # what is on the disk, not only what git tracks
tools secrets scan . \
    --ignore 'EXAMPLE_KEY' \
    --ignore '^sk_test_'                 # each --ignore adds one regex; this one allows Stripe test keys
```

### redact (redact run)

```bash
tools secrets redact [options]
```

| Flag | What it does |
|------|--------------|
| `-i, --in <file>` | Read this file. `-` reads stdin. |
| `-c, --clipboard` | Read the clipboard when there is no `--in`. Write the result back when there is no `--out`. |
| `-o, --out <file>` | Write to this file. `-` prints to stdout. |
| `-m, --map <file>` | Also write this run's session (the mapping) to this file |
| `-t, --types <list>` | Comma-separated detectors: `keys,tokens,emails,ips,paths,phones` |
| `--phones` | Add the phone detector to the list |
| `--json` | Print `{ redacted, mapping }` to stdout instead of writing the text |

The default `--types` is `keys,tokens,emails,ips,paths`. `phones` is off until you pass `--phones` or name it in
`--types`. Input comes from `--in`, then the clipboard, then piped stdin. Output goes to `--out`, then the clipboard,
then stdout. So `--in error.log --clipboard` redacts a file onto the clipboard, and `--clipboard --out -` reads the
clipboard and prints the result without changing the clipboard.

```bash
cat error.log | tools secrets redact                       # stdin to stdout
tools secrets redact --in error.log --clipboard            # a file, redacted onto the clipboard
tools secrets redact --in log.txt --types keys,tokens      # only keys and tokens
tools secrets redact --in log.txt --phones                 # the default types plus phone numbers
tools secrets redact --in log.txt --map ./run1.map.json    # keep this run's mapping in its own file
```

### redact restore

```bash
tools secrets redact restore [options]
```

| Flag | What it does |
|------|--------------|
| `-i, --in <file>` | Read this file. `-` reads stdin. |
| `-c, --clipboard` | Read the clipboard when there is no `--in`. Write the result back when there is no `--out`. |
| `-o, --out <file>` | Write to this file. `-` prints to stdout. |
| `-m, --map <file>` | The mapping to use. Default: the newest saved session. |
| `--json` | Print `{ restored }` to stdout instead of writing the text |

```bash
tools secrets redact restore --in answer.md --out answer.real.md
tools secrets redact restore --in answer.md --map ./run1.map.json
```

## The redact round trip

Masking alone would leave you with an answer full of placeholders. `redact` keeps a mapping, so the model's reply can
be turned back into your real paths, keys and addresses.

```bash
# 1. Copy the log or error text, then redact the clipboard in place
tools secrets redact --clipboard

# 2. Paste into the AI, get an answer, copy the answer

# 3. Restore the real values in the answer, in place on the clipboard
tools secrets redact restore --clipboard
```

Add `--out -` to either step to print the text instead of writing it back to the clipboard.

Each detected value becomes a stable placeholder: `[REDACTED_KEY_1]`, `[REDACTED_TOKEN_1]`, `[EMAIL_1]`, `[IP_1]`,
`[PHONE_1]`, and `[HOME]` for your home directory. The same real value always gets the same placeholder inside one
run, so the text stays coherent and the model can reason about "the same host" appearing twice. Numbering starts at 1
in every run. If the input already holds a bracketed token such as `[EMAIL_1]` or `[HOME]`, the run skips that name
(`[EMAIL_2]`, `[HOME_2]`), so `restore` never confuses your literal text with a placeholder.

`restore` replaces every placeholder of the mapping wherever it appears. It tries the longest key first, so a key of
a hand-written `--map` that is the start of another key does not cut the longer one. A placeholder that the model
rewrote (without brackets, in lower case) stays as it is.

`restore` defaults to the newest session, which is what you want for one conversation. Every `redact` run saves a
session, also a run that found nothing, so a later run becomes the default. Pass `--map` on both sides when you run
several redactions in parallel and need them not to collide.

## Using scan as a gate

```bash
tools secrets scan . && echo "clean"
```

The non-zero exit stops a commit or a CI step, instead of writing a report nobody reads. Exit 1 means findings.
Exit 2 means only the errors that `scan` checks itself: `dir` is not a directory, `--max-size` is not a positive
integer, or you cancelled the prompt. A mistyped flag such as `--no-entrpy`, a flag with no value, or an extra
argument also exits 1, the same code as a finding. A gate that must tell a typo from a leaked key checks that
`--json` printed a result (see [For agents](#for-agents)).

Pair it with `--ignore` entries checked into your own wrapper script, so the allowlist is reviewed like code rather
than remembered by one person.

There are two ways to accept a finding:

- `--ignore <regex>` drops every finding whose secret or whole line matches. It never sees the file path. The regex
  has no flags, so it is case sensitive. An invalid regex is skipped with a warning and the scan goes on without it.
- A line that contains the text `secret-scan:ignore` (in any comment syntax) is not scanned at all.

## How it works

Both commands work offline on this machine. They call no API, need no account and cost nothing. `--clipboard` uses the
system clipboard.

### Where data lives

- `scan` writes no file of its own and has no config file. Like every tool it adds lines to the day log
  (`~/.genesis-tools/logs/<date>.log`): file paths, counts and errors, never a found secret.
- `redact` saves one session per run in `~/.genesis-tools/redact/cache/sessions/<timestamp>.json`, a JSON object
  `{ createdAt, types, mapping }`. The mapping holds the real values in plaintext, keyed by placeholder.
- `tools secrets` never deletes a session. If the newest session is older than 365 days, `restore` without `--map`
  finds no mapping.
- The folder is still named `redact`, the folder the command used when it was a tool of its own (`tools redact`
  became `tools secrets redact` on 2026-10-05), so mappings saved before the move still restore.

### scan: what it reads

- It walks `dir` and always skips `.git` and `node_modules` folders, at any depth, also with `--no-gitignore`.
- It reads only `<dir>/.gitignore`. A nested `.gitignore`, `.git/info/exclude` and your global excludes do not apply.
  When you scan a subtree such as `src/`, the repository's top `.gitignore` does not apply either.
- It skips symbolic links, to files and to folders alike.
- A file with a NUL byte in its first 8 KB is binary and is skipped. A file that cannot be read is skipped. Both
  count as "skipped" in the summary and appear in the JSON `skips` list.
- A file over `--max-size` is dropped during the walk. It is not counted as skipped; `-v` logs each one.
- It scans the files on disk, not the git index. In a pre-commit hook it also sees unstaged changes and untracked
  files that `.gitignore` does not exclude.

### scan: the two detector families

**Fixed-shape detectors** match the known format of one provider's key. They are precise and rarely wrong, but they
only catch the formats they know:

- `aws-access-key-id`: `AKIA` or `ASIA` and 16 upper-case letters or digits.
- `private-key`: a PEM private key header (`BEGIN RSA PRIVATE KEY` and the EC, DSA, OPENSSH and plain forms). An
  armored PGP key (`BEGIN PGP PRIVATE KEY BLOCK`) and a PKCS#8 encrypted key (`BEGIN ENCRYPTED PRIVATE KEY`) are not
  reported, because the header must end in `PRIVATE KEY-----` right after one of those words.
- `slack-token`: `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-` or `xoxs-` and 10 or more characters.
- `github-token`: `ghp_`, `gho_`, `ghs_` or `ghr_` and 36 or more characters.
- `github-fine-grained`: `github_pat_` and 80 or more characters.
- `jwt`: three dot-separated base64url parts, the first starting with `eyJ`.
- `openai-key`: an `sk-` key that carries the `T3BlbkFJ` marker, or an `sk-proj-` key of 100 or more characters.
- `anthropic-key`: `sk-ant-api03-` or `sk-ant-admin01-` and 80 or more characters.
- `stripe-key`: `sk_live_`, `sk_test_`, `rk_live_` or `rk_test_` and 20 or more characters.
- `openrouter-key`: `sk-or-v1-` and 64 hex characters.
- `google-api-key`: `AIza` and 35 characters.
- `twilio-api-key`: `SK` and 32 hex characters. A Twilio Account SID (`AC…`) is not reported on purpose: it names an
  account, it does not authenticate.
- `resend-key`: `re_`, 8 characters, `_`, 24 characters, from Resend's alphabet without `0`, `O`, `I` and `l`.

**Context detectors** need a secret-like name in front of the value. They catch keys with no known prefix, and they
cause nearly all false positives: test fixtures, generated code and minified bundles that give a random-looking
value to a name like `token` or `auth`.

- `generic-assignment`: a secret-like name, `:` or `=`, then a quoted value of 12 or more characters with no spaces.
- `dotenv-assignment`: a `NAME=value` line (also `export NAME=value`) whose name holds a secret-like word, with an
  unquoted value of 12 or more characters and no spaces around `=`. A trailing `# comment` is not part of the value.
  A plain URL and a file path are not reported. A URL with `user:pass@` in it, or with a credential-named query
  parameter such as `?token=…`, is reported.
- `high-entropy-base64`: a secret-like name assigned a quoted value of 20 or more base64 characters whose Shannon
  entropy is at least 4.0 bits per character. `--no-entropy` turns it off.
- `twilio-auth-token`: 32 hex characters assigned to a name that starts with `twilio` and says auth, token or secret,
  such as `TWILIO_AUTH_TOKEN`. A bare 32-hex string is just as likely an MD5 or a hash, so it needs the name.

The secret-like words are `secret`, `password`, `passwd`, `pwd`, `token`, `api_key` (also `api-key`, `apikey`),
`access_key`, `private_key` and `auth`, in any case. For `generic-assignment` and `high-entropy-base64` the word must
end the name (`dbPassword`, `GITHUB_TOKEN`, a JSON key `"token"`), so `passwordHash` is not read. In a dotenv line
the word may sit anywhere in the name (`MY_TOKEN_VALUE`), but `auth` must end its word there, so `AUTHOR_NAME` and
`AUTHORITY_HOST` are not reported. A bare `key` is left out on purpose: it is mostly object properties and cache
keys (`{ key: "daysOnMarket" }`, `CACHE_KEY = …`).

The context detectors skip a value that looks like a placeholder: one that contains `${`, `{{`, `#{`, a `%s`-style
format, `<…>`, `...` or `…`, or three `x` in a row; one character repeated; or a separate word such as `your`,
`example`, `sample`, `placeholder`, `dummy`, `changeme`, `redacted`, `fake`, `todo`, `tbd`, `lorem`, `ipsum`,
`testing`, `foobar`, `insert` or `replace`. The fixed-shape detectors do not use this filter, so AWS's documented
example key, which ends in `EXAMPLE`, is still reported.

When two detectors match the same value at the same place, the finding is reported once.

### scan: the report

The human report is a `LOCATION` (`file:line`) / `DETECTOR` / `SECRET` table, then a summary such as
`2 findings in 1 file (212 files scanned, 3 skipped)`. Paths are relative to `dir`. A secret is never printed in full:
the first 4 and last 4 characters stay, joined by `…`, and a secret of 8 characters or fewer prints as `••••`. The
JSON output also has a `preview`: the line with every flagged value masked, cut to 80 characters.

### redact: what each type catches

- `keys`: AWS access key IDs and whole PEM private key blocks, from the `BEGIN` line to the `END` line.
- `tokens`: GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), Slack `xox?-` tokens, the value after `Bearer `,
  and the value after a separate word `secret`, `token`, `password`, `passwd`, `apikey` or `api_key` followed by
  `:` or `=` (12 or more characters).
- `emails`: email addresses. This also matches the `git@host` part of an SSH remote.
- `ips`: IPv4 addresses and full-form IPv6 addresses (three to eight groups without `::`).
- `paths`: your own home directory (from the operating system), replaced by `[HOME]` wherever it appears, so
  `/Users/alice/Projects/app` becomes `[HOME]/Projects/app`. Another user's home path is left as it is. A path that
  only starts with your home path, such as `/Users/alice2` next to `/Users/alice`, becomes `[HOME]2`.
- `phones` (off by default): an optional `+` country code, then three to five groups of 2 to 4 digits.

When matches overlap, the one that starts first wins, so a token inside a private key block is replaced once, as
part of the block.

`scan` and `redact` keep separate detector lists on purpose. `scan` matches the shape of a secret and reports the
line. `redact` must return the exact span to replace (a whole private key block, only the value after `Bearer`), so
the two lists differ in what they match, and the tests of each pin that behavior.

## Configuration

There is no config file, no account and no environment variable of its own. Flags set every behavior. The scan
allowlist lives in `--ignore` flags (keep them in a wrapper script) and in `secret-scan:ignore` comments in the code.
`GENESIS_TOOLS_HOME` replaces the home folder for all GenesisTools data, so the sessions move to
`$GENESIS_TOOLS_HOME/.genesis-tools/redact/cache/sessions/`. It does not change what `paths` redacts: that is always
your real home directory.

## 🛑 Read this before trusting it

- **A clean scan is not proof there are no secrets.** It proves no detector fired. A key stored in a format nobody
  anticipated, or split across lines, will pass. So will an armored PGP private key (`BEGIN PGP PRIVATE KEY BLOCK`)
  and a PKCS#8 encrypted key (`BEGIN ENCRYPTED PRIVATE KEY`).
- **`.gitignore` hides files that are still on disk.** Respecting it is usually right and occasionally hides the very
  file you care about: a `.env` excluded from git is still on the machine. Pass `--no-gitignore` when you want to know
  what is on the machine rather than what is committed.
- **The mapping file is as sensitive as the original text.** It holds the real values in plaintext, keyed by
  placeholder. Anywhere you would not leave the raw secret, do not leave the mapping either. This covers the session
  folder, every `--map` file, and the `--json` output of `redact`.
- **Redaction is heuristic, and its gaps are specific.** Read the redacted output before you paste it. These pass
  through unchanged:
  - a provider key with no `Bearer ` or bare name in front: an `sk-…` OpenAI or Anthropic key, a Stripe key, a
    Google `AIza…` key, a fine-grained `github_pat_` token, a JWT on its own;
  - a value after a longer name such as `DB_PASSWORD=` or `access_token=`, because the name must be the separate word;
  - a value after a quoted JSON key such as `"token": "…"`, because the quote sits between the word and the colon;
  - a compressed IPv6 address such as `2001:db8::1` (a longer one is only partly replaced);
  - an armored PGP private key block (`BEGIN PGP PRIVATE KEY BLOCK`), because `keys` needs a header that ends in
    `PRIVATE KEY-----`;
  - another user's home path.
- **Redaction also hides things you may want the model to see.** A time with seconds such as `10:15:30` and a MAC
  address such as `aa:bb:cc:dd:ee:ff` match the IPv6 pattern, and a four-part version number such as `1.2.3.4`
  matches the IPv4 pattern. Each becomes `[IP_n]`. `restore` puts it back, but the model sees a placeholder. Pass
  `--types keys,tokens,emails,paths` to keep them readable. The phone pattern also matches dates such as
  `2026-11-09` and any number of six or more digits (IDs, order numbers, timestamps), so turn on `--phones` only
  where phone numbers matter.
- **Redaction is not authorization.** If the text should not leave the machine at all, do not send a masked version
  of it either.

## For agents

- stdout holds only the result (the report, the JSON, or the text). Status lines such as
  `replaced 3 unique secrets; mapping saved to …` go to stderr, so `tools secrets redact --in a.log > safe.log` works.
- 🛑 The `--json` output of `redact`, every `--map` file and every session file hold the real values. An agent that
  must keep secrets out of its context reads only the redacted text, never the mapping.
- There is no MCP tool and no plugin skill for this tool. Call the CLI.

`scan --json` prints this shape:

```json
{
  "scannedFiles": 212,
  "skippedFiles": 1,
  "skips": [{ "file": "assets/logo.png", "reason": "binary" }],
  "findingCount": 1,
  "findings": [
    {
      "file": "config/dev.ts",
      "line": 14,
      "column": 17,
      "detector": "generic-assignment",
      "masked": "q8Zr…9fKd",
      "preview": "const apiKey = \"q8Zr…9fKd\";"
    }
  ],
  "scannedAt": "2026-11-09T10:00:00.000Z"
}
```

`reason` is `binary` or `read-error`. `column` is 1-based and points at the start of the secret.
`redact --json` prints `{ "redacted": "…", "mapping": { "[EMAIL_1]": "…" } }` and writes no text file and no
clipboard, but it still saves the session. `restore --json` prints `{ "restored": "…" }`. `restore --map` accepts a
session file or a bare `{ "[EMAIL_1]": "alice@example.com" }` object; every value must be a string.

Exit codes:

| Command | Code | Meaning |
|---------|------|---------|
| `scan` | 0 | No findings |
| `scan` | 1 | Findings, a usage error (see below), or an unexpected error |
| `scan` | 2 | Not a directory, a bad `--max-size`, or a cancelled prompt |
| `redact`, `restore` | 0 | Done, also when nothing was replaced |
| `redact`, `restore` | 1 | No input in a terminal, no mapping, a usage error, or an error |

A usage error is an unknown option, an option with no value, or an extra argument. The command parser prints
`error: …` and the help to stderr. A crash or a usage error exits 1 from `scan` but prints no report, so a CI step
that must tell findings from either one checks that `--json` printed a result. In a pipeline such as
`scan --json | tools json`, the shell reports the last command's status: read the scan's own exit code.

## Troubleshooting

- **`scan` asks "Directory to scan:".** You ran it in a terminal without `dir`. Press Enter for `.`, or pass the
  directory.
- **`Not a directory: <path>` (exit 2).** `scan` takes a directory. To check one file, scan the folder it is in.
- **`--max-size must be a positive integer (KB).` (exit 2).** Pass a whole number above 0, such as `--max-size 256`.
- **An `--ignore` entry does nothing.** The regex did not compile: look for the warning
  `secrets: invalid --ignore regex (skipped)`. Or it is case sensitive and the case differs.
- **A file you expected is not scanned.** It is excluded by `<dir>/.gitignore`, it is a symbolic link, it is inside
  `.git` or `node_modules`, it is over `--max-size`, or it has a NUL byte in its first 8 KB. Run with `-v` to see the
  files dropped for size.
- **Too many false positives.** They come from the context detectors. Add `--ignore` for a known string, put
  `secret-scan:ignore` on the line, or pass `--no-entropy` for a tree of generated output.
- **`No input: pass --in <file>, --clipboard, or pipe text on stdin.`** `redact` or `restore` ran in a terminal with
  no input. Pass one of the three.
- **`redact` waits and prints nothing.** You passed `--in -` with nothing piped in, so it reads the terminal until
  Ctrl-D.
- **`No mapping found: pass --map <file> or run tools secrets redact first.`** No session is saved yet, or the newest
  one is older than 365 days. Pass `--map`.
- **`restore` leaves placeholders in the text.** The default session belongs to a later `redact` run, or the model
  changed the placeholders. Pass the `--map` file of the right run, and ask the model to keep the bracketed tokens.
- **`--types` redacts nothing.** Unknown type names are dropped without a warning, so a typo such as `--types key`
  leaves an empty list. Use the names `keys`, `tokens`, `emails`, `ips`, `paths`, `phones`.

## Related

- [../har-analyzer/README.md](../har-analyzer/README.md): `tools har-analyzer redact` does the same job for HAR
  capture files.
- [../ai/README.md](../ai/README.md): `tools ai config secret` manages the encrypted vault this toolkit stores its
  own credentials in.
- [../envdiff/README.md](../envdiff/README.md): `tools envdiff` compares `.env` with `.env.example` and shows values
  masked.
- [../json/README.md](../json/README.md): `tools json` turns the `--json` output into TOON, or compact JSON when
  that is smaller.
