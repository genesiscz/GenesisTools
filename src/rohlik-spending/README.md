# Rohlík Spending

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Region](https://img.shields.io/badge/Region-CZ-red?style=flat-square)

> **Analyze your spending on [rohlik.cz](https://www.rohlik.cz) — the Czech grocery delivery service.**

Pulls your delivered orders and their line items from the Rohlík private API, then aggregates totals, per-item trends, and monthly breakdowns. Cookies are captured once and stored locally for reuse.

---

## Quick Start

```bash
# First run — paste your browser cookies (interactive)
tools rohlik-spending

# After that, just run for updated stats
tools rohlik-spending
```

---

## How it works

1. You paste the `Cookie` header copied from a logged-in browser session at rohlik.cz.
2. Cookies are stored under `~/.genesis-tools/rohlik/config.json` along with a timestamp.
3. The tool calls `api/v3/orders/delivered` and `api/v3/orders/{id}` to pull every past order + its items.
4. Totals are aggregated and rendered with clack.

Cookies expire — if you get an auth error, the tool will ask for fresh ones.

---

## Data fetched

| Endpoint | What it gives |
|----------|---------------|
| `/api/v3/orders/delivered` | List of delivered orders with id, timestamp, total price |
| `/api/v3/orders/{id}` | Items in a specific order (name, quantity, totalPrice) |

All calls go straight to rohlik.cz — there is no server-side component.

---

## Privacy

Your cookies stay on disk under `~/.genesis-tools/rohlik/config.json`. Nothing is sent anywhere except to `rohlik.cz` itself with the headers your browser would send.
