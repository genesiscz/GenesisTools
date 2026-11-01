# apify

Discover Apify Actors, inspect their input schemas, start a run with an explicit USD limit, and retrieve its dataset. The tool also reads recorded run costs and account monthly usage.

## Credentials

```sh
tools apify login
tools apify status
tools apify status --check
tools apify logout
```

Login asks for an API token in a masked terminal prompt. Get a token from [Apify Console integrations](https://console.apify.com/settings/integrations). Use a token with only the permissions you need. Login validates it through `GET /v2/users/me` before saving, so a rejected token does not replace a working login.

The token is stored as `apify/api-token` in the existing GenesisTools AES-256-GCM encrypted vault. Its master key uses the existing OS keychain provider, or the vault's configured headless provider. The tool does not write plaintext credentials, change Apify's CLI configuration, or consume ambient `APIFY_TOKEN` variables.

For automation, pipe the token from your secret manager:

```sh
my-secret-manager read apify | tools apify login --token-stdin
```

Do not paste a token into command arguments or shell history. `login` has no token argument or token-valued flag. Stdin token input is bounded to 8 KiB and 30 seconds. The vault must already be available to the process in headless environments.

`status` checks only whether the owned encrypted entry exists. It does not decrypt, contact Apify, initialize credentials, or migrate settings. `status --check` explicitly decrypts the existing token and reads the authenticated user. Neither command saves credentials. `logout` removes only the tool's entry; it does not revoke the token remotely or delete other vault entries.

## Discover an Actor and inspect its contract

```sh
tools apify search "reddit scraper" --limit 10
tools apify search "website content crawler" --offset 10 --limit 10 --json
tools apify actor show owner/actor --json
tools apify actor schema owner/actor --json > actor-schema.json
tools apify recipes
```

Search reads the public Store without authentication and never starts an Actor. Actor details and schemas use your saved login so they also work for private Actors you can access. IDs and `owner/name` or `owner~name` are accepted. Details expose the published pricing information. Schemas come from the default build's `actorDefinition.input`, with a fallback to the legacy `inputSchema`; an Actor that does not publish one produces a clear error.

The recipes command gives research workflows for public discussion analysis, documentation corpora, competitor pricing and business directories. It runs entirely offline. Choose an Actor, review its schema and pricing, then build the exact input that Actor expects.

## Start and inspect a run

```sh
tools apify run start owner/actor --input input.json --max-cost 0.50 --max-items 20 --json
cat input.json | tools apify run start owner/actor --input - --max-cost 0.50 --json
tools apify run show RUN_ID --json
tools apify run list --limit 20 --offset 0
tools apify run abort RUN_ID
```

`run start` requires a JSON object from a file or stdin, up to 8 MiB, and a positive `--max-cost`. It passes that USD amount to Apify's `maxTotalChargeUsd`. `--max-items` passes Apify's pay-per-result charging limit; it does not guarantee the Actor returns exactly that many items. See the [run API contract](https://docs.apify.com/api/v2/actors-runs-post).

Runs start asynchronously. Save the returned run ID and inspect it with `run show`; `defaultDatasetId` identifies the output dataset. The tool never starts a sample run while logging in, searching, inspecting schemas, or reading costs. It never retries a paid start automatically. A timeout or broken connection after a start leaves the outcome unknown; inspect recent runs before trying again. Explicit aborts do not undo already incurred charges.

Run lists show actual `usageTotalUsd` values returned by Apify. Their sum is explicitly a subtotal of the returned page. Missing amounts appear as unknown, and running jobs may still accrue usage.

## Retrieve results

```sh
tools apify dataset items DATASET_ID --limit 100 --offset 0 --json > results-page.json
tools apify dataset items DATASET_ID --fields url,title,text --limit 100 --offset 100 --json
```

Dataset output contains `items`, `offset`, `limit` and `count`. It is one page, not an entire dataset. Follow with a larger offset to retrieve the next page. Server responses are limited to 16 MiB; select fields or lower the limit for large records. Store, run and dataset page limits range from 1 to 1000, with a default of 20. Dataset retention depends on your Apify plan and storage naming; export results you need to keep.

## Account usage and run costs

```sh
tools apify usage --json
tools apify costs --since 2026-01-01T09:00:00+01:00 --until 2026-01-01T12:00:00+01:00 --json
tools apify costs --since 2026-01-01T00:00:00Z --page-size 100 --max-pages 50
```

`usage` reads the account's current monthly platform usage. `costs` follows run pages and sums only the API's recorded `usageTotalUsd`. Both time bounds are inclusive and apply to when a run started, not when it finished. Supply ISO datetimes with a timezone; an omitted `--until` captures the current instant once. The bounds reach every API request through `startedAfter` and `startedBefore`.

The cost report includes individual runs and actor subtotals, missing-cost counts, unfinished runs, scanned page counts and `paginationComplete`. By default it reads at most 10 pages of 100 records. When it reaches that cap, encounters duplicates or sees the result total change, it marks the result incomplete and exposes the reason and next offset. Increase `--max-pages` and rerun the same fixed window to obtain a complete result. Never treat a capped subtotal as an account total.

`costDataComplete` means the scanned window is complete, all included runs have recorded amounts and all are terminal. Recent and running runs may still receive accounting updates, so this flag does not mean the amounts are final. Missing dates and out-of-window records are counted and prevent that flag. Recorded run usage is before account credits. It is not the amount billed to your card, an invoice, or an account balance. The account's other usage can also differ from these selected run records.

## Output and failures

All commands support the global `--json` option, including after subcommands. `--silent` suppresses human output. Human inventory lists use terminal tables; schema, dataset and detailed records print JSON. Authenticated user and run fields are selected explicitly rather than returning complete private API responses. Occurrences of the active Apify API token are redacted from results, including object keys. Actor schema definitions and dataset fields named token or password otherwise retain their original structure and data. HTTP errors report only their status, without echoing response bodies, headers or input.

The client uses only the fixed HTTPS Apify API origin, rejects redirects, bounds requests to 60 seconds and does not retry requests. Errors exit nonzero. The [API reference](https://docs.apify.com/api/v2) documents authorization and pagination; [run listing](https://docs.apify.com/api/v2/actor-runs-get) documents the cost report's filters.

## Hosted MCP parity

`actor details owner/actor` retrieves the current hosted service's README, pricing, metadata, ratings, usage, input/output schemas and Server Actor HTTP interface. It works without login for public Actors. Use `mcp call fetch-actor-details --input details.json` for section selection, HTTP operation excerpts or local JSON pointers in `output.serverInterface`.

```sh
tools apify actor details apify/web-fetch --json
tools apify docs search "standby actor" --source apify --limit 5
tools apify docs search "request queue" --source crawlee-js --limit 5
tools apify docs fetch https://docs.apify.com/mcp
tools apify kv get STORE_ID OUTPUT --json
tools apify mcp tools --json
tools apify mcp call get-dataset-items --input arguments.json --json
tools apify actor tools owner/server-actor --allow-uncapped-cost --json
tools apify actor invoke owner/server-actor tool-name --input arguments.json --allow-uncapped-cost --json
```

The generic adapter accepts `search-actors`, `fetch-actor-details`, `search-apify-docs`, `fetch-apify-docs`, `get-actor-run`, `get-dataset-items`, `get-key-value-store-record`, `fetch-actor-mcp-tool-list`, `call-actor-mcp-tool`, and `report-problem`. Argument files use the live MCP names and schemas. `mcp tools` lists the four public tools without reading credentials. Read tools preserve MCP content blocks, structured content, metadata, and follow-up guidance. An upstream `isError` result exits nonzero. Widgets are represented by their corresponding data commands. Reporting sends a message to Apify and enables its telemetry for that reporting session, as required by Apify; it requires the explicit `--allow-report` flag. Do not put personal data or secrets in a report.

For specialized Actors, use the general run mechanism with their exact input schema:

```sh
tools apify actor details apify/rag-web-browser --json
tools apify run start apify/rag-web-browser --input browser.json --max-cost 0.20 --max-items 3 --timeout 120 --memory 512 --wait 30 --json
tools apify actor details apify/web-fetch --json
tools apify run start apify/web-fetch --input fetch.json --max-cost 0.10 --timeout 120 --memory 512 --json
```

This also supports every other Store Actor. Fetch output using the returned dataset/store IDs. Dedicated MCP tools may bundle output retrieval, while this CLI makes paging explicit. Hosted discovery applies Apify's MCP safety filters; the direct REST Store search can return additional Actors. Review pricing and permissions before running them.

Run controls include `--build`, `--memory` from 128 to 32768 MiB in powers of two, `--timeout` from 1 to 86400 seconds, and `--wait` from 0 to 45 seconds. Defaults are 128 MiB, 300 seconds and no wait. A wait deadline never aborts a cloud run. Choose enough memory for the selected Actor. `maxTotalChargeUsd` and `maxItems` are upstream billing controls; the live MCP contract describes them as pricing-model-specific and they do not bound production. Put work limits in the Actor input too. The CLI cannot promise an invoice-level hard ceiling across every pricing model or account fee.

Actor MCP tool discovery can contact a Standby server. Neither discovery nor invocation currently exposes a per-call USD cap in Apify's MCP contract. Both therefore require `--allow-uncapped-cost`. That flag acknowledges the absence of a cap; it does not impose one. There is no automatic fallback from a bounded run to an uncapped tool call. Unknown tools, including new paid tools added upstream, fail closed. No Actor run was used to develop or test this implementation.

Dataset retrieval also supports `--omit`, `--flatten`, `--desc` and `--no-clean`, plus named IDs such as `owner~dataset`. `run show` retains default dataset and key-value store IDs, statistics, status messages and exit codes. The hosted `get-actor-run` command provides richer alias maps and output summaries.

The adapter uses the existing MCP SDK, a fixed `https://mcp.apify.com` origin, Bearer headers, telemetry disabled except for explicitly enabled reporting, a 16 MiB streamed response limit and bounded request deadlines. It does not follow Actor-supplied endpoint URLs itself. Transport reconnection is disabled. Tool failures suppress upstream bodies because they may echo credentials or inputs. CLI argument files can contain sensitive Actor input; protect them and their exported results yourself. Never include secrets in search queries or optional `useCase` telemetry fields.

Contracts: [hosted MCP](https://docs.apify.com/mcp), [official MCP implementation and tool list](https://github.com/apify/apify-mcp-server), [Actor run start](https://docs.apify.com/api/v2/act-runs-post), [dataset items](https://docs.apify.com/api/v2/dataset-items-get).

## Development and verification

The root Devbox recipe is source-only and has no credentials, ports or stack. From this worktree run:

```sh
devbox config check --json
devbox setup --apply --json
devbox run -- 'bun scripts/test.ts src/apify/lib/apify.test.ts'
devbox run -- 'node_modules/.bin/tsc -p src/apify/tsconfig.json --noEmit'
```

All tests inject API fetchers, credential stores or MCP sessions. They do not read a live token or run an Actor. Native keychain behavior and real paid Actor/Standby execution require separately authorized integration verification.
