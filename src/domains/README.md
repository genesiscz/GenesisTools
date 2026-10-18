# tools domains

> **Find a domain you can actually buy.** Generate names from a seed, check them through several providers, see the real price (registry premiums included), spot names parked for sale, catch names that are rude in another language, and watch names over time.

It exists because "is genesis.tech free?" is the wrong question. The right one is "which good name for Genesis Tech can I register today for a normal price?", and the answer needs generation, checking, pricing and vetting in one pass.

---

## Quick start

```bash
tools domains search "Genesis Tech s.r.o."          # generate, check, rank (genesiste.ch comes out on top)
tools domains search "Genesis Tech" --ai --rounds 2 # add an LLM brainstorm that learns from what was taken
tools domains check genesiste.ch genesis.inc        # free / premium / taken / for sale, with prices
tools domains info genesis.io                       # registrar, expiry, parking, history, vibe
tools domains hack genesis tech                     # domain hacks only: genesiste.ch, genes.is
tools domains vibe bereshit                         # ⚠ "shit" — the reason this check exists
tools domains tlds --cc --max 20                    # cheap two-letter TLDs, by renewal price
tools domains watch add genesis.tech && tools domains watch refresh
```

## Commands

| Command | What it does |
|---------|--------------|
| `search <seed...>` | Runs the suggestors, checks the best candidates, ranks what you can buy. `--ai`, `--rounds <n>`, `--about <text>`, `--model <ref>`, `--tlds`, `--suggestors`, `--max-price`, `--status`, `--all`, `--check-limit`, `--vibe-lang`, `--offline`. |
| `check [domains...]` | Status and price for names from args, `--file` or stdin. `--provider <ids>` asks exactly those providers; `--details` adds registrar and expiry for taken names. |
| `suggest [seed...]` | Candidates only, ranked, no network checks. `--list` shows the suggestors. |
| `hack <words...>` | Domain hacks across every delegated TLD, checked. `--no-check`, `--free`, `--min-label`. |
| `info <domain>` (`whois`) | Status, quote, TLD list price, registration rules, for-sale signals, RDAP or WHOIS registration, Wayback and certificate history, vibe. |
| `price [domains...]` | Per-name quote next to the TLD list price, and the cost of holding the name for `--years`. |
| `tlds [filter]` | TLD list prices (Porkbun's public table). `--max`, `--sort price\|renewal\|name\|tier`, `--promo`, `--cc`. |
| `vibe <names...>` | Rude-word check in 16 Latin-script languages. Exit code 2 when something matched. |
| `watch add\|ls\|rm\|refresh` | A watchlist. `refresh` re-checks, stores the state, and reports names that became free, changed price or expire within `--expiry-days`. Exit code 3 when something changed. |
| `providers` | Which providers can run here and how they authenticate (read-only). |

Every command takes `--json` for scripts and agents.

## Statuses

| Status | Meaning |
|--------|---------|
| `free` (`available`) | Registrable at the normal price. |
| `premium` | Registrable, but the registry charges a premium (the per-name quote is above the TLD's standard price). |
| `taken` | Registered. |
| `for sale` | Registered and parked with a marketplace (Afternic, Sedo, Park.io, HugeDomains ...). |
| `reserved` | Blocked by the registry (a WHOIS reply that says so). |
| `unknown` | No provider could decide. Rate limits, timeouts and errors land here, never in `free`. |

## How a check works

The default chain stops at the first decisive answer:

1. **DNS** (`dns`): a delegated name is taken, with no API call spent. No NS records proves nothing.
2. **Priced registrar** (`vercel`): one bulk call per 200 names returns availability, the exact price and the registry premium flag, with no account.
3. **RDAP** (`rdap`): the registry's own answer, via the IANA bootstrap (cached a day).
4. **WHOIS** (`whois`): port 43 for TLDs without RDAP (.io, .eu, .me, .gg, .co ...), server found through whois.iana.org. A reply reads as taken only when it carries registration lines (registrar, creation date, nameservers); an empty, refused or unrecognized reply is unknown.

Each stage runs over the whole batch, so 150 names cost one DNS lookup each and a single Vercel request. A "taken" from any provider beats an "available" from another. `search` and `hack` cache decisive results for 6 hours; `check`, `price` and `info` read that cache but never write it. `--fresh` skips the cache.

## Providers

| Id | Auth | Gives |
|----|------|-------|
| `vercel` | none (public bulk search) | availability, per-name price, premium flag; only TLDs Vercel sells |
| `rdap` | none | availability, registrar, expiry, nameservers |
| `whois` | none | the same, for TLDs without RDAP |
| `dns` | none | fast "taken" pre-filter |

TLD list prices come from Porkbun's public pricing endpoint (no key).

## Suggestors

| Id | Default | What it makes |
|----|---------|---------------|
| `exact` | on | the seed on every TLD (`genesistech.cz`, `genesis-tech.com`) |
| `hacks` | on | the TLD finishes the word (`genesiste.ch`, `genes.is`) across all ~1,400 TLDs |
| `short` | on | prefixes and vowel drops (`gentech`, `gnss`) |
| `affixes` | on | `get-`, `try-`, `-hq`, `-labs` ... on the top TLDs |
| `synonyms` | on (online) | related words from Datamuse (`origin.tech`, `emergence.cz`) |
| `ai` | `--ai` | an LLM brainstorm: coinages, translations, hacks. Uses the `domains` app's chat default, else the `ask` app's. With `--rounds 2+`, later rounds are told which names were taken and which free ones scored best. |

## Ranking

A score from 0 to 100: short, sayable, hyphen-free labels on a good TLD rank high; hacks get a bonus; taken, unknown and expensive names sink; a rude reading in any checked language costs 30 points and shows a ⚠ in the VIBE column. Names whose TLD has a registration rule (EU residency for .eu, a US nexus for .us, HTTPS-only for .dev) show the rule in the INFO column.

## Data

- Cache and watchlist: `~/.genesis-tools/domains/` (config holds the watchlist; `cache/` holds the RDAP bootstrap, TLD lists, price table, word lists and check results).
- Logs: every HTTP call is logged at debug level with its status and time, credentials redacted.
