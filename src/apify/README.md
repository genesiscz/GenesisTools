# tools apify

`tools apify` finds Actors (cloud scrapers and automations) in the Apify Store, shows their input and cost, starts a run
with an explicit USD limit, and pages through the results. Use it when you or an agent need web data from Apify without
a surprise bill: every command that can charge money needs an explicit flag, `--max-cost` for a run and
`--allow-uncapped-cost` for an Actor's MCP server. It also reads Apify's hosted MCP tools and documentation, sums the
recorded cost of past runs, and reads the account's monthly usage.

## Quick start

```sh
# Save an API token in the encrypted vault (masked prompt)
tools apify login
# Find an Actor in the public Store; no login needed, starts nothing
tools apify search "reddit scraper" --limit 10
# Read the input the Actor expects
tools apify actor schema owner/actor --json > actor-schema.json
# Start one paid run, capped at 0.50 USD
tools apify run start owner/actor --input input.json --max-cost 0.50 --max-items 20 --json
# Check the run and find its output dataset ID (defaultDatasetId)
tools apify run show RUN_ID --json
# Read the first page of results
tools apify dataset items DATASET_ID --limit 100 --json > results-page.json
```

The order is the one `tools apify --help` gives: log in, search, read the schema, then start a run.

## Commands

Global options work before or after the subcommand:

| Option | Effect |
|---|---|
| `--json` | Print JSON for scripts, on every command |
| `--silent` | Suppress human output (`--json` output still prints) |
| `-v`, `--verbose` | Print debug log lines, such as each API endpoint called |
| `--readme` | Print this page and exit |
| `-h`, `--help` | Help for the tool or a subcommand |

Which commands need what:

- **Offline:** `recipes`, `status` without `--check`, `logout`.
- **Network, no login:** `search`, `actor details`, `docs search`, `docs fetch`, `mcp tools`, and `mcp call` on one
  of the four public tools.
- **Network and the saved token:** `status --check`, `actor show`, `actor schema`, `actor tools`, `actor invoke`,
  every `run` command, `dataset items`, `kv get`, `usage`, `costs`, and `mcp call` on the other tools. `login` itself
  makes one API call to validate the token you give it.
- **Can charge money:** `run start`, `actor tools`, `actor invoke`, and `mcp call` on `fetch-actor-mcp-tool-list` or
  `call-actor-mcp-tool`.

An Actor is named by its ID, `owner/name` or `owner~name`.

### Credentials

```sh
# Validate a token with Apify, then save it in the encrypted vault
tools apify login
# The same, with the token read from stdin
tools apify login --token-stdin
# Is a token saved? Local only: no decryption, no network
tools apify status
# Also decrypt the token and ask Apify which user it belongs to
tools apify status --check
# Delete the saved token; it stays valid at Apify
tools apify logout
```

- `login` asks for the token in a masked terminal prompt. Get a token from
  [Apify Console integrations](https://console.apify.com/settings/integrations), and give it only the permissions you
  need.
- `login` validates the token through `GET /v2/users/me` before it saves it, so a rejected token does not replace a
  working login. It prints `Saved token for <username>.`, or, with `--json`, `authenticated: true` and the `user`
  (`id`, `username`).
- `login` has no token argument and no token-valued flag. Do not paste a token into command arguments or shell
  history. Without a terminal, pipe it from your secret manager:

  ```sh
  my-secret-manager read apify | tools apify login --token-stdin
  ```

  Stdin input is bounded to 8 KiB and 30 seconds, and it must be piped (a terminal on stdin is refused). The token is
  trimmed and must be one value of 10 to 4096 printable ASCII characters, with no spaces. A token pasted with quotes is sent to Apify as it is and fails with
  `Apify HTTP 401`.
- `status` checks only whether the tool's encrypted entry exists. It does not decrypt, contact Apify, initialize
  credentials, or migrate settings. It prints `stored`, `storage: "encrypted-vault"` and the next command to try.
- `status --check` explicitly decrypts the existing token and reads the authenticated user (`id`, `username`).
  Neither form saves credentials.
- `logout` removes only this tool's entry. It does not revoke the token at Apify and does not delete other vault
  entries. It prints `{ "removed": true|false, "remotelyRevoked": false }`.

### Find an Actor and read its contract

```sh
# Search the public Store; no login, starts nothing
tools apify search "website content crawler" --offset 10 --limit 10 --json
# Actor metadata, published pricing and default run options (login)
tools apify actor show owner/actor --json
# The default build's input schema (login)
tools apify actor schema owner/actor --json > actor-schema.json
# README, pricing, metadata, stats, rating, input and output schemas and the server HTTP interface (hosted MCP)
tools apify actor details apify/web-fetch --json
# Four research workflows, offline
tools apify recipes
# Search Apify or Crawlee documentation (hosted MCP, no login)
tools apify docs search "standby actor" --source apify --limit 5
tools apify docs search "request queue" --source crawlee-js --limit 5
# Read one documentation page (hosted MCP, no login)
tools apify docs fetch https://docs.apify.com/mcp
```

- `search` reads the public Store without authentication and never starts an Actor. It takes `--limit` (1 to 1000,
  default 20) and `--offset` (default 0). The human output is a table of Actor, title and description, followed by
  `Returned N of TOTAL. Next offset: X.`
- `actor show` and `actor schema` use your saved login, so they also work for private Actors you can access.
  `actor show` exposes the published pricing information (`pricingInfos`).
- `actor schema` reads the default build's `actorDefinition.input`, with a fallback to the legacy `inputSchema`. An
  Actor that publishes neither produces a clear error.
- `actor details` calls the hosted MCP tool `fetch-actor-details` with every section turned on. It never sends your
  token, so it works without login for public Actors; use `actor show` and `actor schema` for a private one. For
  section selection, HTTP operation excerpts or local JSON pointers in `output.serverInterface`, call the tool
  yourself: `tools apify mcp call fetch-actor-details --input details.json`.
- `recipes` prints research workflows as JSON, without any API call: recurring complaints (`reddit scraper`), a
  documentation corpus (`website content crawler`), competitor pricing (`website scraper`) and a business directory
  (`google maps scraper`). Each gives a search term and an input hint. Choose an Actor, review its schema and pricing,
  then build the exact input that Actor expects.
- `docs search` takes `--source apify` (the default), `crawlee-js` or `crawlee-py`. Its `--limit` accepts only 1 to
  20, although the shared help text says 1 to 1000; the default of 20 is valid. `--offset` must be 0 or more.
- `docs fetch` accepts only an HTTPS URL on `docs.apify.com` or `crawlee.dev`, without a user name, password or port.
- Hosted discovery applies Apify's MCP safety filters. The direct REST Store search (`search`) can return additional
  Actors. Review pricing and permissions before you run one.

### Start and inspect a run

```sh
# Start one run: paid, asynchronous, never retried
tools apify run start owner/actor \
    --input input.json \
    --max-cost 0.50 \
    --max-items 20 \
    --json
# The input can come from stdin
cat input.json | tools apify run start owner/actor --input - --max-cost 0.50 --json
# One run: status, statistics, status message, exit code, default dataset and key-value store IDs
tools apify run show RUN_ID --json
# A page of recent runs, newest first, with the recorded USD of each
tools apify run list --limit 20 --offset 0
# Ask Apify to abort a run
tools apify run abort RUN_ID
```

`run start` flags:

| Flag | Default | Meaning |
|---|---|---|
| `--input <file>` | required | A JSON object from a file, or `-` for stdin, 8 MiB at most |
| `--max-cost <usd>` | required | A positive USD amount, sent as Apify's `maxTotalChargeUsd` |
| `--max-items <n>` | none | A positive integer, sent as Apify's pay-per-result `maxItems` |
| `--timeout <s>` | 300 | Run duration limit, 1 to 86400 seconds |
| `--memory <mib>` | 128 | A power of two, 128 to 32768 MiB |
| `--build <tag>` | the Actor's default | Build tag or number |
| `--wait <s>` | 0 | Wait 0 to 45 seconds for the run to finish |

- The input must be a regular file (or piped stdin, read within 30 seconds) that holds one JSON object.
- `--max-items` passes Apify's pay-per-result charging limit. It does not guarantee that the Actor returns exactly
  that many items. See the [run API contract](https://docs.apify.com/api/v2/actors-runs-post).
- `maxTotalChargeUsd` and `maxItems` are upstream billing controls. The live MCP contract describes them as
  pricing-model-specific, and they do not bound production. Put work limits in the Actor input too. The CLI cannot
  promise an invoice-level hard ceiling across every pricing model or account fee.
- Choose enough memory for the selected Actor. 128 MiB is both the default and the minimum.
- Runs start asynchronously. Save the returned run ID and inspect it with `run show`; `defaultDatasetId` identifies
  the output dataset. A `--wait` deadline never aborts a cloud run.
- The tool never starts a sample run while logging in, searching, inspecting schemas, or reading costs. It never
  retries a paid start automatically.
- A timeout, a broken connection, a server error, or a reply that breaks off or cannot be parsed after a start leaves
  the outcome unknown. The error then ends with `The result is unknown; inspect runs before retrying.` Run
  `tools apify run list` before you try again, or you can pay for a second run.
- `run abort` does not undo charges already incurred.
- `run list` shows the actual `usageTotalUsd` values Apify returns. Their sum is a subtotal of the returned page only
  (`costs.scope` is `"returned-page"` in JSON). Missing amounts appear as `unknown`, and running jobs may still
  accrue usage.
- `run show` and `run abort` take a run ID of letters, digits, hyphens and underscores. `run show` keeps the default
  dataset and key-value store IDs, statistics, status messages and exit codes. The hosted `get-actor-run` tool
  (`mcp call get-actor-run`) gives richer alias maps and output summaries.

Specialized Actors use the same run mechanism with their exact input schema. This works for every other Store Actor
too:

```sh
tools apify actor details apify/rag-web-browser --json
tools apify run start apify/rag-web-browser \
    --input browser.json \
    --max-cost 0.20 \
    --max-items 3 \
    --timeout 120 \
    --memory 512 \
    --wait 30 \
    --json
tools apify actor details apify/web-fetch --json
tools apify run start apify/web-fetch \
    --input fetch.json \
    --max-cost 0.10 \
    --timeout 120 \
    --memory 512 \
    --json
```

Fetch the output with the returned dataset or store IDs. Dedicated MCP tools may bundle output retrieval, while this
CLI makes paging explicit.

### Retrieve results

```sh
# One page of dataset items
tools apify dataset items DATASET_ID --limit 100 --offset 0 --json > results-page.json
# Only some fields, second page
tools apify dataset items DATASET_ID --fields url,title,text --limit 100 --offset 100 --json
# One key-value store record, through hosted MCP (login)
tools apify kv get STORE_ID OUTPUT --json
```

`dataset items` flags:

| Flag | Default | Meaning |
|---|---|---|
| `--limit <n>` | 20 | Page size, 1 to 1000 |
| `--offset <n>` | 0 | Items to skip |
| `--fields <names>` | all | Comma-separated fields to keep |
| `--omit <names>` | none | Comma-separated fields to drop |
| `--flatten <names>` | none | Comma-separated fields to flatten |
| `--desc` | off | Newest items first |
| `--no-clean` | clean | Include hidden fields and empty items |

- The output is `{ items, offset, limit, count }`. It is one page, not the entire dataset. Ask again with a larger
  `--offset` for the next page.
- A dataset ID may also be a named ID such as `owner~dataset` (or `owner/dataset`).
- Server responses are limited to 16 MiB. For large records, select fields or lower the limit.
- Store, run and dataset pages all take a limit of 1 to 1000, with a default of 20.
- Dataset retention depends on your Apify plan and storage naming. Export the results you need to keep.

### Account usage and run costs

```sh
# The account's current monthly platform usage
tools apify usage --json
# Recorded run usage for runs that started inside a fixed window
tools apify costs \
    --since 2026-01-01T09:00:00+01:00 \
    --until 2026-01-01T12:00:00+01:00 \
    --json
# A wider scan: up to 50 pages of 100 runs
tools apify costs --since 2026-01-01T00:00:00Z --page-size 100 --max-pages 50
```

`costs` flags:

| Flag | Default | Meaning |
|---|---|---|
| `--since <datetime>` | required | Inclusive start of the window |
| `--until <datetime>` | now | Inclusive end of the window |
| `--page-size <n>` | 100 | Runs per request, 1 to 1000 |
| `--max-pages <n>` | 10 | Stop after this many pages, 1 to 1000 |

- `usage` reads the account's current monthly platform usage, as Apify returns it.
- `costs` follows run pages, oldest first, and sums only the API's recorded `usageTotalUsd`.
- Both time bounds are inclusive and apply to when a run started, not when it finished. The bounds reach every API
  request through `startedAfter` and `startedBefore`.
- Supply ISO datetimes with a timezone, `YYYY-MM-DDTHH:MM`, optional seconds and milliseconds, then `Z`, `+HH:MM` or `-HH:MM`.
  A date the calendar does not have, such as February 30, is refused instead of rolling into the next month.
  `--since` must be at or before `--until`. An omitted `--until` captures the current instant once.
- The report has individual runs and per-Actor subtotals, missing-cost counts, unfinished runs, scanned page counts
  and `paginationComplete`. The human output prints the Actor table and the same counts.
- By default it reads at most 10 pages of 100 records. When it reaches that cap, meets duplicates, or sees the result
  total change, it marks the result incomplete and gives the reason (`max-pages-reached`,
  `results-changed-during-pagination` or `empty-page-before-total`) and the next offset. Increase `--max-pages` and
  rerun the same fixed window to get a complete result. Never treat a capped subtotal as an account total.
- A page whose offset or count does not match the request stops the command with an error instead of a total.
- `costDataComplete` means the scanned window is complete, all included runs have recorded amounts, and all are
  terminal (`SUCCEEDED`, `FAILED`, `ABORTED` or `TIMED-OUT`). Missing start dates and out-of-window records are
  counted and prevent that flag. Recent and running runs may still receive accounting updates, so this flag does not
  mean the amounts are final.
- Recorded run usage is before account credits. It is not the amount billed to your card, an invoice, or an account
  balance. The account's other usage can also differ from these selected run records.

### Hosted MCP tools

```sh
# The four public tools with their schemas; reads no credentials
tools apify mcp tools --json
# Call one hosted tool with an arguments file (or - for stdin)
tools apify mcp call get-dataset-items --input arguments.json --json
# Discover the tools on an Actor's MCP server (can charge)
tools apify actor tools owner/server-actor --allow-uncapped-cost --json
# Call one of those tools (can charge)
tools apify actor invoke owner/server-actor tool-name --input arguments.json --allow-uncapped-cost --json
```

`mcp call` accepts exactly these tool names:

| Tool | Login | Extra flag |
|---|---|---|
| `search-actors` | no | none |
| `fetch-actor-details` | no | none |
| `search-apify-docs` | no | none |
| `fetch-apify-docs` | no | none |
| `get-actor-run` | yes | none |
| `get-dataset-items` | yes | none |
| `get-key-value-store-record` | yes | none |
| `fetch-actor-mcp-tool-list` | yes | `--allow-uncapped-cost` |
| `call-actor-mcp-tool` | yes | `--allow-uncapped-cost` |
| `report-problem` | yes | `--allow-report` |

- Argument files use the live MCP names and schemas, and must hold one JSON object (8 MiB at most).
- Read tools preserve MCP content blocks, structured content, metadata and follow-up guidance. An upstream `isError`
  result exits nonzero. Widgets are represented by their corresponding data commands.
- Unknown tools, including new paid tools added upstream, fail closed.
- Actor MCP tool discovery (`actor tools`) can contact a Standby server. Neither discovery nor invocation currently
  exposes a per-call USD cap in Apify's MCP contract, so both require `--allow-uncapped-cost`. That flag acknowledges
  the absence of a cap; it does not impose one. There is no automatic fallback from a bounded run to an uncapped tool
  call.
- `report-problem` sends a message to Apify and enables its telemetry for that reporting session, as Apify requires.
  It needs the explicit `--allow-report` flag. Do not put personal data or secrets in a report.

Contracts: [hosted MCP](https://docs.apify.com/mcp),
[official MCP implementation and tool list](https://github.com/apify/apify-mcp-server),
[Actor run start](https://docs.apify.com/api/v2/act-runs-post),
[dataset items](https://docs.apify.com/api/v2/dataset-items-get).

## How it works

**Data on disk.** The only thing the tool stores is the API token, as the entry `apify/api-token` in the shared
GenesisTools vault, `~/.genesis-tools/security/vault.json` (AES-256-GCM). It has no config file, cache or database of
its own. Results go to stdout only, so save what you need. The tool does not write plaintext credentials, change
Apify's CLI configuration, or read an ambient `APIFY_TOKEN` variable.

**The vault master key.** A command that decrypts the token first resolves the vault's master key, and the first
hit wins: the `GENESIS_TOOLS_MASTER_KEY` environment variable, GenesisTools.app's approval window (when the app is
installed), the macOS keychain, then an opt-in key file. A headless process with no key on any of these fails instead
of making a new one, so in a headless environment the vault must already be available to the process.

**What it calls.** Two fixed HTTPS origins, and nothing else:

- The Apify REST API, `https://api.apify.com/v2`, for login, Store search, Actor metadata and schemas, runs, datasets,
  usage and costs. The [API reference](https://docs.apify.com/api/v2) documents authorization and pagination;
  [run listing](https://docs.apify.com/api/v2/actor-runs-get) documents the cost report's filters.
- Apify's hosted MCP server, `https://mcp.apify.com`, for `actor details`, `actor tools`, `actor invoke`, `docs`,
  `kv get` and `mcp`. The adapter uses the existing MCP SDK and asks the server for only the one tool it calls.

Both clients send the saved token, when a command needs it, as a Bearer header. Both reject redirects, bound each
response to 16 MiB, and never retry a request. A REST request times out after 60 seconds. An MCP session gets 30
seconds to connect and 60 seconds per tool call, and transport reconnection is disabled. The MCP adapter refuses to
send a request outside its fixed origin and does not follow Actor-supplied endpoint URLs itself. Telemetry is
disabled on every MCP session except an explicit `report-problem`.

**What leaves the output.** Occurrences of the active Apify API token are redacted from results, including object
keys. Actor schema definitions and dataset fields named token or password otherwise keep their original structure
and data. Authenticated user and run fields are selected explicitly rather than returning complete private API
responses. HTTP errors report only their status, without echoing response bodies, headers or input. MCP tool
failures suppress upstream bodies, because they may echo credentials or inputs.

**Your own files.** Input and argument files can contain sensitive Actor input; protect them and their exported
results yourself. Never include secrets in search queries or in the optional `useCase` telemetry fields of hosted
tools.

**What costs money.** Apify bills `run start` according to the Actor's pricing model, with your `--max-cost` passed
to it as `maxTotalChargeUsd`. `actor tools`, `actor invoke` and the two Actor MCP tools of `mcp call` can charge
without a per-call cap. Store search, Actor metadata, schemas, docs, run, dataset and key-value reads, `usage` and
`costs` start nothing. Your Apify plan decides the price; this tool reads recorded amounts and never computes a price
itself.

## Configuration

There is no config file. One saved token means one Apify account at a time; `login` with another token replaces it.

| Setting | Where | Purpose |
|---|---|---|
| API token | vault entry `apify/api-token` | Set by `login`, removed by `logout` |
| `GENESIS_TOOLS_MASTER_KEY` | environment | Master key for headless runs: base64 of 32 random bytes |
| `"allowKeyFile": true` | `~/.genesis-tools/security/config.json` | Allows the key file `master.key` beside it |

The last two belong to the shared vault, not to this tool. `tools ai config doctor` checks the master key and the
vault, and `tools ai config secret ls` lists vault paths without values (see [ai](../ai/README.md)).

## For agents

- Every command takes `--json`, before or after the subcommand. `actor show`, `actor schema`, `actor details`,
  `actor tools`, `actor invoke`, `run start`, `run show`, `run abort`, `dataset items`, `kv get`, `usage`, `recipes`, `docs`, `mcp`, `status` and
  `logout` print JSON even without it; `login` prints one line; `search`, `run list` and `costs` print a table instead.
- Exit codes: 0 on success, 1 on any failure, 130 when Ctrl-C interrupts it. An error prints one line on stderr, `ERROR: <message>`. A usage error,
  such as a missing required option, prints commander's `error: ...` line and also exits 1. Failed invocations of the tool (not Actor
  runs) are recorded in `~/.genesis-tools/logs/<date>-failures.jsonl`.
- A safe order: `search`, then `actor details` or `actor schema`, then `run start` with `--max-cost`, then `run show`
  until the status is terminal, then `dataset items` page by page.
- Never retry `run start` after an error that says the result is unknown. Run `tools apify run list --json` first and
  look for the run.
- Treat a `costs` result with `paginationComplete: false` as partial. Rerun the same window with a larger
  `--max-pages`.
- There is no plugin skill, MCP server tool or node-repl toolset for this tool; call the CLI.

## Troubleshooting

**`No saved Apify token. Run tools apify login.`** No token is in the vault. Run `tools apify login`, or pipe one with
`--token-stdin`.

**`Login needs an interactive terminal or --token-stdin.`** `login` ran without a terminal. Pipe the token to
`tools apify login --token-stdin`.

**`Apify HTTP 401. Check token permissions or log in again.`** (or 403) Apify rejected the token, or the token lacks a
permission the command needs. Run `tools apify status --check`, then `login` with a token that has the permission.

**`No vault master key available and this process is not interactive...`** A headless process found no master key.
Export `GENESIS_TOOLS_MASTER_KEY`, or enable the key file as the message says.

**`... The result is unknown; inspect runs before retrying.`** A `run start` or `run abort` request may have reached
Apify. Run `tools apify run list` and look for the run before you send it again.

**`Apify response exceeded 16 MiB. Request fewer items or fields.`** The page is too large. Lower `--limit` or
select `--fields`.

**`Actor MCP access may incur charges without a per-call USD cap. Requires --allow-uncapped-cost.`** `actor tools`,
`actor invoke` and the two Actor MCP tools need that flag. Prefer a bounded `run start` when the Actor supports it.

**`Unsupported MCP tool. Use run start for bounded Actor runs.`** `mcp call` got a name outside the table above. Without a saved token, an unknown name reports the missing token first.

**`Apify MCP request failed. Remote effects may have occurred; do not retry paid calls blindly.`** The hosted server
could not be reached, the response passed 16 MiB, or the tool returned `isError`. Every hosted-tool failure gives
this one message, and upstream bodies are hidden on purpose. Check your arguments against
`tools apify mcp tools --json`, and after a paid tool, check `run list` before you retry.

**`Docs search requires --limit 1 to 20 and a nonnegative --offset.`** `docs search` caps the page at 20, although its
help text says 1000.

**`This Actor's default build does not publish an input schema.`** Read `tools apify actor details <actor>`, which
also carries the Actor's README, and build the input from it.

**`Use an ISO datetime with a timezone, such as 2026-01-01T00:00:00+01:00.`** A `costs` bound has no timezone or the
wrong shape. Add `Z` or an offset such as `+01:00`.

**`Incomplete: max-pages-reached. Increase --max-pages and rerun the same window.`** The cost scan stopped at its page
cap. Rerun with a larger `--max-pages` and the same `--since` and `--until`.

## Development

From the repository root:

```sh
bun scripts/test.ts src/apify/lib/apify.test.ts
bunx tsc -p src/apify/tsconfig.json --noEmit
```

All tests inject API fetchers, credential stores or MCP sessions. They do not read a live token or run an Actor.
Native keychain behavior and real paid Actor and Standby execution require separately authorized integration
verification. No Actor run was used to develop or test this implementation (PR #659, 2026-11-02).

## Related

- [ai](../ai/README.md): manages the shared vault and its master key (`tools ai config secret`,
  `tools ai config doctor`).
