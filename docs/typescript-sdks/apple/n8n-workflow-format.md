# n8n Workflow JSON Format — Research for GenesisTools Automation Presets

> Researched: 2026-02-16

## Overview

n8n is a workflow automation tool that defines workflows as JSON. This document analyzes the format to inform our simpler `src/automate/` preset format.

## Top-Level Structure

```json
{
  "id": "rUXzWNGsUDUmgaFS",
  "name": "My Workflow",
  "active": false,
  "nodes": [ ... ],
  "connections": { ... },
  "settings": { ... },
  "staticData": null,
  "pinData": { ... },
  "meta": { "instanceId": "..." },
  "versionId": "9fa91e54-...",
  "tags": []
}
```

## Node Definition

```json
{
  "id": "5babc228-...",
  "name": "Webhook",
  "type": "n8n-nodes-base.webhook",
  "typeVersion": 2,
  "position": [40, 0],
  "parameters": { "httpMethod": "POST", "path": "my-endpoint" },
  "credentials": { "openAiApi": { "id": "cred-id", "name": "openAiApi Credential" } },
  "disabled": false,
  "onError": "stopWorkflow",
  "continueOnFail": false,
  "retryOnFail": false,
  "maxTries": 3,
  "waitBetweenTries": 1000
}
```

## Connections (Most Complex Part)

Triple-nested structure: `sourceNode → connectionType → outputIndex[] → destinations[]`

```json
"connections": {
  "IF Node": {
    "main": [
      [{ "node": "Handle True", "type": "main", "index": 0 }],
      [{ "node": "Handle False", "type": "main", "index": 0 }]
    ]
  },
  "Webhook": {
    "main": [[
      { "node": "Node A", "type": "main", "index": 0 },
      { "node": "Node B", "type": "main", "index": 0 }
    ]]
  }
}
```

## Expressions System

`={{ }}` syntax with JavaScript inside:

| Variable | Purpose | Example |
|----------|---------|---------|
| `$json` | Current item's data | `{{ $json.email }}` |
| `$("NodeName")` | Reference any node | `{{ $("HTTP Request").first().json.id }}` |
| `$input.first()` | First input item | `{{ $input.first().json.name }}` |
| `$now` | Current DateTime | `{{ $now.toFormat("yyyy-MM-dd") }}` |
| `$vars` | Workflow variables | `{{ $vars.apiKey }}` |

## Conditional Logic

### IF Node (2 outputs: true/false)

```json
{
  "type": "n8n-nodes-base.if",
  "parameters": {
    "conditions": {
      "combinator": "and",
      "conditions": [{
        "operator": { "type": "boolean", "operation": "true" },
        "leftValue": "={{ $json.is_fragile }}"
      }]
    }
  }
}
```

### Switch Node (N outputs)

```json
{
  "type": "n8n-nodes-base.switch",
  "parameters": {
    "rules": {
      "values": [{
        "outputKey": "London",
        "conditions": {
          "combinator": "and",
          "conditions": [{
            "operator": { "type": "string", "operation": "equals" },
            "leftValue": "={{ $json.destination }}",
            "rightValue": "London"
          }]
        }
      }]
    }
  }
}
```

## Error Handling

- Per-node: `onError: "stopWorkflow" | "continueErrorOutput" | "continueRegularOutput"`
- Retry: `retryOnFail: true, maxTries: 3, waitBetweenTries: 1000`
- Workflow-level: `settings.errorWorkflow` references error handler workflow

## Triggers

```json
// Schedule
{ "type": "n8n-nodes-base.scheduleTrigger", "parameters": { "rule": { "interval": [{ "field": "weeks", "weeksInterval": 1 }] } } }

// Manual
{ "type": "n8n-nodes-base.manualTrigger" }

// Webhook
{ "type": "n8n-nodes-base.webhook", "parameters": { "httpMethod": "POST", "path": "endpoint" } }
```

## Essential vs. Bloated Analysis

### Keep
- Step identity (`name`, `type`/`action`)
- Step config (`parameters`)
- Step ordering/wiring
- Error handling
- Variables/expressions

### Drop
- `position: [x, y]` — visual canvas layout
- `typeVersion` — internal versioning
- `id` (UUID) — use name as identifier
- `webhookId`, `staticData`, `pinData`, `meta`, `versionId` — UI/internal state
- Deep nested condition structures — use flat expressions
- Connection `type: "main"` / `index: 0` — redundant defaults

## Our Simplified Preset Format

**Design principles:**
- Sequential by default (array order = execution order)
- Connections only for branches
- Flat conditions (expressions returning boolean)
- No visual metadata
- ~30-60 tokens per step vs n8n's ~150-300

```json
{
  "name": "Monthly Invoice Search",
  "trigger": { "type": "manual" },
  "vars": {
    "startDate": "2026-01-01",
    "outputDir": "./invoices"
  },
  "steps": [
    {
      "name": "Search Mail",
      "action": "macos-mail.search",
      "params": { "query": "invoice OR faktura OR receipt", "--from": "{{ vars.startDate }}" },
      "onError": "stop"
    },
    {
      "name": "Check results",
      "action": "if",
      "condition": "{{ output.count > 0 }}",
      "then": "Download",
      "else": "No Results"
    },
    {
      "name": "Download",
      "action": "macos-mail.download",
      "params": { "ids": "{{ steps['Search Mail'].output.ids }}", "--dir": "{{ vars.outputDir }}" },
      "interactive": true
    },
    {
      "name": "No Results",
      "action": "log",
      "params": { "message": "No invoices found for period" }
    }
  ]
}
```

### Comparison

| Aspect | n8n | Our Presets |
|--------|-----|-------------|
| Step ordering | Explicit connections object | Array order |
| Branching | Connections per output index | Inline `then`/`else` |
| Node identity | UUID + name + type + typeVersion | name + action |
| Previous output | `={{ $("Node").first().json.x }}` | `{{ steps['Name'].output.x }}` |
| Conditions | Deep nested combinator/operator | `{{ expression }}` → boolean |
| Error handling | 4 separate fields | `onError: "stop" \| "continue" \| "retry:3"` |
| Tokens per step | ~150-300 | ~30-60 |
