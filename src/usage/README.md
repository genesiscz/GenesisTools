# Usage

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Usage and cost analytics for the `ask` tool.**

Reports on the local SQLite usage DB that `tools ask` writes after every LLM call. See how much you've spent, how many tokens flowed through which model, and which sessions cost the most.

---

## Quick Start

```bash
# Last 30 days (default table view)
tools usage

# Last 7 days
tools usage --days 7

# Only one provider
tools usage --provider openai

# Only one model
tools usage --model gpt-5

# Summary only
tools usage --format summary

# JSON for piping / dashboards
tools usage --format json
```

---

## Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--days <n>` | `-d` | Number of days to analyze | `30` |
| `--provider <name>` | `-p` | Filter by provider (openai, anthropic, groq, ...) | — |
| `--model <name>` | `-m` | Filter by model | — |
| `--format <fmt>` | `-f` | `table`, `json`, or `summary` | `table` |
| `--help-full` | `-?` | Detailed help |  |

---

## Output

- **Summary** — totals, avg cost/message, avg tokens/message.
- **Daily usage** — one row per day with cost, tokens, message count.
- **Per-provider / per-model** — breakdowns when filters are unset.
- Costs come from the `DynamicPricing` manager, which pulls live OpenRouter pricing so numbers stay accurate even as models change prices.

---

## Related

- `tools ask` — the actual LLM client that writes the usage records.
- `tools claude usage` — separate analytics for Claude Code session costs.
