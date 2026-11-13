# tools domains

> **Find a domain you can actually buy.** Generate names from a seed, check them through several providers, see the
> real price (registry premiums included), spot names parked for sale, catch names that are rude in another language,
> and watch names over time.

It exists because "is acme.tech free?" is the wrong question. The right one is "which good name for Acme Tech
can I register today for a normal price?", and the answer needs generation, checking, pricing and vetting in one pass.
No account or API key is needed. Only the optional AI suggestor (`--ai`) uses an AI account.

---

## Quick start

```bash
tools domains search "Acme Tech s.r.o."        # generate, check and rank the names you can buy
tools domains check acmete.ch acme.inc         # free / premium / taken / for sale, with prices
tools domains info acme.io                     # registrar, expiry, parking, history, vibe
tools domains hack acme tech                   # domain hacks only: acmete.ch, ac.me
tools domains vibe bereshit                    # ⚠ "shit": the reason this check exists
tools domains watch add acme.tech && tools domains watch refresh  # watch a name, then re-check it and report news
```

## Commands

| Job | Commands |
|-----|----------|
| Find names | `search`, `suggest`, `hack` |
| Check and price names | `check`, `price`, `info` (`whois`), `tlds` |
| Vet a name | `vibe` |
| Follow names over time | `watch add`, `watch ls`, `watch rm`, `watch refresh` |
| See the providers | `providers` |

Every command takes `--json`. Global flags: `-v, --verbose` (verbose logging), `--readme`, `-V, --version` and
`-h, --help`.

### Find names

#### `search <seed...>`

Runs the suggestors, checks the best candidates, and ranks the names you can buy.

```bash
tools domains search "Acme Tech s.r.o."
tools domains search "Acme Tech" --ai --rounds 2 --about "developer tools for the Mac"
tools domains search acme --tlds com,io,dev,ch,sh --max-price 30
tools domains search acme --all --limit 100 --json
```

| Flag | Default | What it does |
|------|---------|--------------|
| `-t, --tlds <list>` | 14 TLDs (below) | TLDs to combine with, comma-separated |
| `-s, --suggestors <ids>` | every default one | `exact`, `hacks`, `short`, `affixes`, `synonyms`, `ai` |
| `--ai` | off | add the AI brainstorm to the chosen suggestors |
| `--about <text>` | | one line about the business, for the AI |
| `-m, --model <ref>` | | a bare id (`sonnet`) or a full ref (`@account/<id>:<model>`) |
| `--account <name>` | auto | the AI account (see [Configuration](#configuration)) |
| `--rounds <n>` | 1 | AI rounds; needs `--ai` |
| `--offline` | off | skip the suggestors that need the network |
| `--max-price <usd>` | none | hide names whose first year costs more, or has no known price |
| `--status <list>` | `available,premium` | statuses to show (see [Statuses](#statuses)) |
| `--all` | | show every status, taken names included |
| `-n, --limit <n>` | 30 | rows to show |
| `--check-limit <n>` | 150 | how many top candidates round 1 checks |
| `--vibe-lang <list>` | all 16 | languages for the rude-word check; `none` turns it off |
| `--fresh` | | ignore cached check results |

The default TLDs are `com`, `cz`, `io`, `dev`, `app`, `ai`, `co`, `tech`, `sh`, `so`, `eu`, `net`, `org` and `xyz`.

How a search runs:

1. Round 1 runs the chosen suggestors, scores every candidate before any check, and checks the best `--check-limit`.
2. With `--ai` and `--rounds 2` or more, each later round runs only the AI suggestor. The AI is told which names
   nobody can register (taken, for sale, reserved), and the 12 best free names to imitate. Every new AI name is
   checked. Without the AI suggestor (`--ai` or `-s ai`), rounds after the first are skipped.
3. Names whose status is not in `--status` are dropped. A name with no registrar quote gets the TLD list price as an
   estimate, for `--max-price` and for the ranking.
4. Every kept name gets the rude-word check and a final score. The table shows SCORE, DOMAIN, STATUS,
   PRICE 1Y / RENEW, INFO, and VIBE when a name was flagged.

When nothing matches, the tool suggests a wider run (`--ai --tlds com,io,dev,ch,sh,so,gg`).

#### `suggest [seed...]`

Generates candidates and ranks them, with no availability checks. With no seed (or `--list`) it lists the
suggestors.

```bash
tools domains suggest "Acme Tech"
tools domains suggest acme --suggestors hacks,short --limit 100
tools domains suggest --list
```

Flags: `-t, --tlds`, `-s, --suggestors`, `--ai`, `--about`, `-m, --model`, `--account` and `--offline` work as in
`search`. `--list` lists the suggestors and exits. `-n, --limit <n>` sets the rows (default 60). The table shows
SCORE, DOMAIN, FROM (the suggestors) and WHY.

`suggest` checks nothing, but `synonyms` (Datamuse) and `ai` still call the network unless you pass `--offline`.

#### `hack <words...>`

Finds domain hacks across every delegated TLD (the TLD finishes the word), then checks them.

```bash
tools domains hack acme tech              # acmete.ch, ac.me, checked
tools domains hack delicious --no-check   # list only
tools domains hack acme --free            # only names you can register
```

| Flag | Default | What it does |
|------|---------|--------------|
| `--min-label <n>` | 2 | shortest label left of the dot |
| `--no-check` | | list the hacks, do not check them |
| `--free` | | show only `free` and `premium` names |

It tries the joined words, each word and each adjacent pair, and skips strings shorter than 4 letters.

### Check and price names

#### `check [domains...]`

Status and price for names from the arguments, `--file`, or piped stdin.

```bash
tools domains check acmete.ch acme.inc
tools domains check --file names.txt --details
cat names.txt | tools domains check --json
tools domains check acme.io --provider rdap,whois
```

| Flag | Default | What it does |
|------|---------|--------------|
| `--file <path>` | | names, one per line; `#` starts a comment |
| `-p, --provider <ids>` | the default chain | ask exactly these providers: `vercel`, `rdap`, `whois`, `dns` |
| `--details` | | also fetch registrar and expiry for taken names |
| `--fresh` | | ignore cached results |
| `-c, --concurrency <n>` | 12 | parallel per-name checks |

Arguments may be separated by spaces or commas. Stdin is read only when no argument and no `--file` gave a name.
`--provider` asks every named provider in the given order and does not stop at the first answer.

#### `price [domains...]`

The per-name quote next to the TLD list price, and the cost of holding the name.

```bash
tools domains price acmete.ch acme.dev --years 10
```

| Flag | Default | What it does |
|------|---------|--------------|
| `--file <path>` | | read names from a file |
| `-y, --years <n>` | 5 | the holding period for the total |

Names may also come from piped stdin, as for `check`.

The columns are DOMAIN, STATUS, QUOTE 1Y, RENEW, TLD LIST (Porkbun first year / renewal) and the total for the
period. The total is the first year plus `years - 1` renewals, from the quote or else the list price, and only for
names you can register. With no names, `price` prints an empty table.

#### `info <domain>` (alias `whois`)

Everything about one name, always checked live.

```bash
tools domains info acme.io
tools domains whois acme.io --no-history --json
```

It shows the status, the quote, the TLD list price, the TLD's registration rule, for-sale signals, the registration
record (RDAP, or WHOIS where the TLD has no RDAP), nameservers, the Wayback Machine and certificate history, and the
rude-word check. An expiry under 60 days is shown in yellow. `--no-history` skips the Wayback Machine and crt.sh
lookups.

For a taken name with live DNS it also opens the website. It follows up to 5 redirects by hand, connects only to
public addresses, waits 10 s and reads the first 256 KB. A final URL on a known marketplace, or a parking page
marker, turns `taken` into `for sale`. Page text such as "make an offer" is shown as a weaker signal and does not
change the status. With any for-sale signal, `info` also prints the name's Afternic listing URL, which shows a
buy-now price when the owner set one.

#### `tlds [filter]`

TLD list prices from Porkbun's public table, in USD.

```bash
tools domains tlds --cc --max 20          # cheap two-letter TLDs, by renewal price
tools domains tlds ai                     # every TLD that contains "ai"
tools domains tlds co. --sort price
tools domains tlds --promo --limit 100
```

| Flag | Default | What it does |
|------|---------|--------------|
| `[filter]` | | a substring of the TLD (a leading dot is ignored) |
| `--max <usd>` | | renewal price ceiling |
| `--sort [by]` | `renewal` | `price`, `renewal`, `name` or `tier` |
| `--promo` | | only TLDs with a first-year discount |
| `--cc` | | only two-letter country TLDs (domain-hack material) |
| `-n, --limit <n>` | 50 | rows to show |

The columns are TLD, 1ST YEAR, RENEWAL, TRANSFER and 5 YEARS (the first year plus four renewals). A green first-year
price is a promo: it is more than 10% below the renewal price. `--sort` with no value asks in a terminal and fails
with a hint in a script.

### Vet a name

#### `vibe <names...>`

Checks labels or domains for rude words in 16 Latin-script languages. The exit code is 2 when something matched.

```bash
tools domains vibe bereshit
tools domains vibe acmete.ch acm.io --lang en,cs,de
```

`-l, --lang <list>` sets the languages. The default is `en,cs,de,es,fr,it,nl,pl,pt,sv,da,fi,hu,no,tr,eo`. Each hit
names the word, its languages and where it sits (`whole`, `start`, `end`, `inside`). The lists catch spelling, not
sound, so say the name out loud too.

### Follow names over time

#### `watch add [domains...]`, `watch ls`, `watch rm <domains...>`, `watch refresh`

```bash
tools domains watch add acme.tech acme.io --note "wait for the drop"
tools domains watch ls                      # the last known state, no network
tools domains watch refresh --changed       # re-check and show only the news
tools domains watch rm acme.io
```

| Command | Flags | What it does |
|---------|-------|--------------|
| `watch add` | `--file <path>`, `--note <text>` | add names (also from stdin) |
| `watch ls` (`list`) | | show the list: last status, price, expiry, when checked, note |
| `watch rm` (`remove`) | | remove names |
| `watch refresh` | `--expiry-days <n>` (45), `--changed`, `--items` | re-check, store, report |

`refresh` checks every name live, with registration details. It reports four kinds of news:

- a status change (`taken -> available`); an `unknown` answer is not a change and keeps the old status,
- `now available`,
- `expires in N days` (or `expired N days ago`) within `--expiry-days`,
- a first-year price change of more than one cent.

The exit code is 3 when any name has news. `--changed` hides the names without news. `--items` prints the news as
Monitor item lines and exits 0 (see [For agents](#for-agents)). When two refreshes overlap, the older one never
overwrites the state that the newer one stored.

### See the providers

#### `providers`

Lists the providers, what each can do, and how each authenticates. It is read-only. The columns are ID, PROVIDER,
STATE (`ready` or `off`), CAN and AUTH, and a last line names the default chain. All four are always `ready`, because
none needs an account.

| Id | Auth | Gives |
|----|------|-------|
| `vercel` | none (public bulk search) | availability, per-name price, premium flag; only TLDs Vercel sells |
| `rdap` | none | availability, registrar, expiry, nameservers |
| `whois` | none | the same, for TLDs without RDAP |
| `dns` | none | fast "taken" pre-filter |

TLD list prices come from Porkbun's public pricing endpoint (no key).

## Statuses

| Status | Shown as | Meaning |
|--------|----------|---------|
| `available` | `free` | Registrable at the normal price, as far as the provider can tell. |
| `premium` | `premium` | Registrable, but Vercel flags a registry premium price. |
| `taken` | `taken` | Registered. |
| `for-sale` | `for sale` | Registered and parked with a marketplace (Afternic, Sedo, Park.io, HugeDomains ...). |
| `reserved` | `reserved` | Blocked by the registry (a WHOIS reply that says so). |
| `unknown` | `unknown` | No provider could decide. Rate limits, timeouts and errors land here, never in `free`. |

`--status` takes the left column. A `·c` after a domain in a table means the result came from the cache.

## How it works

### A check

The default chain stops at the first decisive answer for each name:

1. **DNS** (`dns`): a delegated name is taken, with no API call spent. No NS records proves nothing.
2. **Priced registrar** (`vercel`): one bulk call per 200 names returns availability, the exact price and the registry
   premium flag, with no account. Only TLDs on Vercel's supported list are sent.
3. **RDAP** (`rdap`): the registry's own answer, through the IANA bootstrap (cached a day). `.cz` goes to
   `rdap.nic.cz` by a built-in override, because the bootstrap misses it or gets it wrong.
4. **WHOIS** (`whois`): port 43 for TLDs without RDAP (.io, .eu, .me, .sh, .gg, .co ...), with the server found
   through whois.iana.org. A reply reads as taken only when it carries registration lines (registrar, creation date,
   nameservers). An empty, refused or unrecognized reply is unknown. A "too many queries" reply is unknown, and the
   legal text after the answer is ignored. One query has a 12 s deadline and is cut at 64 KB.

Each stage runs over the whole batch, so 150 names cost one DNS lookup each and a single Vercel request. A "taken"
from any provider beats an "available" from another, and a registry "reserved" beats "available" and "premium". A
taken name whose nameservers belong to one of 25 known parking services becomes `for sale`.

RDAP and WHOIS cannot see a registry premium: their "available" says "premium unknown" in its detail. Only a Vercel
quote reveals a premium.

`--details` (and `watch refresh`) also asks RDAP, or WHOIS where the TLD has no RDAP, about taken names, for the
registrar and the expiry.

### The cache

`search` and `hack` cache decisive results for 6 hours. `check` and `price` read that cache but never write it.
`info` and `watch refresh` always check live. `--fresh` skips the cache. `check --provider` never reads a cached
result. Only the default chain is cached, so a run with named providers always asks them live.

### Names you can type

A name may come with a scheme, a path, `www.` or a trailing dot; the tool strips them. An international name is
converted to its ASCII (punycode) form. A subdomain such as `blog.example.com` is skipped as invalid, because its
registry would answer "no such domain", which reads as free. Common second-level suffixes (`co.uk`, `com.au`,
`co.jp` and about 30 more) count as the TLD.

A seed has its diacritics folded ("Žluťoučký" becomes `zlutoucky`) and legal forms dropped (`s.r.o.`, `sro`, `a.s.`,
`as`, `inc`, `llc`, `ltd`, `gmbh`, `corp`, `co`). A seed word that equals one of them, such as `as`, disappears without
a warning.

### Suggestors

| Id | Default | What it makes |
|----|---------|---------------|
| `exact` | on | the seed on every TLD (`acmetech.cz`, `acme-tech.com`, `acme.io`) |
| `hacks` | on | the TLD finishes the word (`acmete.ch`, `ac.me`) across all ~1,400 TLDs |
| `short` | on | prefixes and vowel drops (`gentech`, `gnss`) on the first 5 TLDs |
| `affixes` | on | `get-`, `try-`, `-hq`, `-labs` ... on the first 4 TLDs |
| `synonyms` | on (online) | related words from Datamuse (`emergence.cz`) on the first 4 TLDs |
| `ai` | `--ai` | an AI brainstorm: coinages, translations, hacks |

Each suggestor keeps at most 60 names (the AI 180). A name that two suggestors found lists both.

`--offline` wins over `--suggestors` and `--ai`: `synonyms` and `ai` do not run, and the seed stays on the Mac.
`hacks` still reads the IANA TLD list (cached a week), and falls back to a built-in list of about 120 TLDs when the
download fails. `search --offline` still checks the names over the network.

The AI suggestor asks for up to 40 ideas per round, with a TLD when the idea needs one (a hack), else on the first 3
TLDs. The prompt asks it to avoid words that sound rude in Czech, German, Spanish or English.

### Ranking

A score from 0 to 100. Short, sayable, hyphen-free labels on a good TLD rank high, and a hack gets 15 points.
Hyphens cost 12 and digits 8. After the check, a taken or reserved name loses 60, a name for sale 40, an unknown one
15, and a price above $10 loses up to 40 as it grows. A rude reading in any checked language costs 30 points and
shows a ⚠ in the VIBE column, but the name stays in the list.

The TLD tier counts too: `.com` is 10; `.io`, `.ai` and `.dev` are 8; other unlisted two-letter TLDs are 4 and the
rest 3.

### Registration rules

Names whose TLD has a registration rule show the rule in the INFO column while they are registrable, and `info`
shows it as "Rule". Examples: EU residency for .eu, a US nexus for .us, a 2-year minimum term for .ai, and HTTPS only
for .dev, .app and .page. Registry policies change: the list is a warning, not legal advice.

### The rude-word check

The word lists are the LDNOOBW lists on GitHub, cached for 4 weeks. When GitHub cannot be reached, a short built-in
list covers English, Czech, German and Spanish. Words of 4 or more letters match anywhere in the label. Words of 3
letters match only the whole label, because they hide inside innocent words ("ass" in "class"). A list of innocent
words ("cocktail", "therapist", "scunthorpe" ...) is masked first.

### Data on disk

Everything lives in `~/.genesis-tools/domains/`:

| Path | What | Fresh for |
|------|------|-----------|
| `config.json` | the watchlist (`watch`) | not a cache |
| `cache/results/` | check results, one file per name | 6 hours |
| `cache/iana/tlds.txt` | every delegated TLD | 7 days |
| `cache/rdap/dns.json` | the IANA RDAP bootstrap | 1 day |
| `cache/whois/servers.json` | WHOIS server per TLD | 7 days |
| `cache/vercel/tlds.json` | the TLDs Vercel sells | 7 days |
| `cache/porkbun/pricing.json` | TLD list prices | 1 day |
| `cache/vibe/<lang>.txt` | rude-word lists | 4 weeks |

A cache file older than its time is not deleted. The tool ignores it and fetches the data again on its next use.

Every HTTP call is logged at debug level with its URL (keys redacted), status and time, in the day log
`~/.genesis-tools/logs/<date>.log`.

### Network and cost

The tool calls only public endpoints that need no key: the system DNS resolver, Vercel's registrar search, the
registries' RDAP and WHOIS servers, IANA, Porkbun's pricing table, Datamuse, the LDNOOBW lists on GitHub, the Wayback
Machine CDX API and crt.sh. `info` also opens the name's own website. None of them costs money.

The AI suggestor is the only part that can cost money, and only when it runs on a paid API account.

## Configuration

There is nothing to set up. `config.json` holds only the watchlist; change it through `watch add` and `watch rm`.

The AI suggestor picks its account in this order:

1. `--account <name>`: that account, with a bare `--model` if you give one. A full `--model` ref with `--account` is
   an error.
2. A full `--model` ref (`@account/<id>:<model>`): that ref.
3. The `domains` app's chat default, when you passed neither flag.
4. Auto (also `--account auto`): your subscription accounts, Claude first, then Codex, then Grok, preferring accounts
   with more than 10% weekly room left. When one refuses (a full account answers 429 for hours), the next one runs.
5. When no subscription account exists: the `ask` app's default.

Options 1 to 3 and 5 can be a paid API account. Then the tool warns once that every round costs money. Set a
subscription account as the `domains` default:

```bash
tools ai config account list
tools ai config default set chat @account/<id> --app domains
```

`GENESIS_TOOLS_HOME` moves the whole `~/.genesis-tools` root, as it does for every tool.

## For agents

- `--json` prints one JSON object on stdout; progress and warnings go to stderr. The top-level keys:
  - `search`: `hits` (cut to `--limit`; each with `domain`, `score`, `sources`, `reason`, `result`, `vibe`,
    `round`), `generated`, `checked`, `rounds`.
  - `check`: `results`, `invalid`. `price`: `years`, `rows`, `invalid`. `hack`: `results` (`hacks` with
    `--no-check`).
  - `suggest`: `total`, `candidates` (`suggestors` with `--list`). `tlds`: `total`, `tlds`. `vibe`: `languages`,
    `report`.
  - `info`: `domain`, `unicode` (for an international name), `check`, `registration`, `dnsNameservers`, `parking`,
    `landing`, `listPrice`, `restriction`, `history`, `certificates`, `vibe`.
  - `watch add`: `added`, `invalid`. `watch ls`: `watch`. `watch rm`: `removed`. `watch refresh`: `changes`.
    `providers`: `providers`.
- A `result` carries `domain`, `status`, `provider` (the provider whose answer decided the status; `none` when no
  provider answered), `price` (`registration`, `renewal`, `currency`, `provider`, `premium`),
  `detail`, `registrar`, `expiresAt`, `nameservers`, `checkedAt`, `cached`, and `verdicts`: every provider's own
  answer, in the order asked.
- Exit codes: 0 on success; 1 on bad input (no names for `check`, not a domain for `info`, an unknown status,
  provider, suggestor or sort, a bad price or `--expiry-days`, a seed with no usable words, or a `--file` that
  cannot be read); 2 when `vibe` found a rude word; 3 when `watch refresh` reported news. An error that the command
  throws, such as the last two, prints `ERROR: <message>` on stderr.
- Watch from Monitor: `watch refresh --items` prints one JSON line per fact, with `guid` (`<domain>:<fact>`),
  `title`, `summary` (the note) and `publishedAt`, and exits 0. The fact keys are `status:<status>`, `available`,
  `expires:<date>` and `price:<amount>`, so a name that keeps expiring is one item per expiry date, not one a day.

  ```bash
  tools monitor add "tools domains watch refresh --items" --kind command --items --interval 3600
  ```

- The GenesisTools hub's Watching screen lists the watchlist. It marks a name that is available, or expires within
  45 days.

## Troubleshooting

- **Many names come back `unknown`.** A registry rate-limited the run (RDAP 429, a WHOIS "too many queries"), or a
  server timed out. The detail in the INFO column names the reason. Wait and run again, or give `check` a lower
  `-c`. `search` and `hack` keep the decisive results for 6 hours, so a rerun asks only about the rest.
- **A name says `free`, but the registrar asks for much more.** RDAP and WHOIS cannot see a registry premium; only
  a Vercel quote can, and Vercel does not sell every TLD. `info` and `price` show the quote next to the list price.
  Confirm at checkout.
- **"Skipped N invalid name(s)".** The name is a subdomain, has no dot, or has a label the DNS does not allow.
- **"stdin sent nothing for 10 s".** The command waited for piped names. Pass the names as arguments or `--file`.
- **`--sort` fails in a script.** Give it a value: `--sort price`.
- **"No AI account", "no subscription account and no default", or "is a full ref".** The AI suggestor could not
  pick an account. This does not stop `search` or `suggest`: the run prints a `suggestor failed` warning, goes on
  without AI names, and exits 0. For "No AI account", check the name with `tools ai config account list`, or pass
  `--account auto`. For "no subscription account and no default", set a default as
  [Configuration](#configuration) shows, or pass `--account <name>`. For "is a full ref", pass a bare `--model`
  with `--account`, or drop `--account`.
- **`watch refresh` exits 3 on every run.** A watched name sits inside the expiry window, and that fact is news on
  every refresh. Lower `--expiry-days`, or run it through Monitor with `--items`, which reports each expiry date once.
- **Anything else.** Run with `-v`, and search the day log: `rg domains ~/.genesis-tools/logs/<date>.log`.

## Related

- [tools monitor](../monitor/README.md): runs `watch refresh --items` on a schedule and notifies you.
- [tools hub](../hub/README.md): its Watching screen shows the watchlist.
- [tools ai](../ai/README.md): the accounts and defaults the AI suggestor uses.
- [tools ask](../ask/README.md): its default model is the AI suggestor's last fallback.
