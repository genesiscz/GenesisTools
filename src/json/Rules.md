# JSON/TOON Conversion Tool - LLM Instructions

## ⚠️ IMPORTANT NOTE

**"jq" and "tools json" are NOT the same tool and should be treated as such.**

-   `jq` - Standard JSON processor for filtering, querying, and transforming JSON data
-   `tools json` - Custom GenesisTools utility that converts JSON to TOON format for LLM token efficiency

Do not confuse these tools; they serve completely different purposes.

## Instruction

**When reading JSON data from APIs or files, always pipe through `tools json` to ensure optimal token efficiency.**

## Why

TOON format reduces token usage by 30-60% compared to standard JSON. The tool automatically selects the most compact format.

## Required Pattern

**DO NOT:** `cat data.json` or read JSON directly  
**ALWAYS:** `cat data.json | tools json` or `tools json data.json`

## When to Apply

Apply when reading JSON files, receiving JSON from APIs, or processing structured data for LLM workflows.

## Example

```bash
# ❌ WRONG
curl https://api.example.com/data.json

# ✅ CORRECT
curl https://api.example.com/data.json | tools json
```

This automatically selects the most compact format for optimal token efficiency.
