# GitHub Search REST API Reference

## Endpoints

### Issue & PR Search (`GET /search/issues`)

Search issues and pull requests across repositories.

**Rate limit:** 30 requests/min (authenticated), 10/min (unauthenticated)

**Max results:** 1000 total, 100 per page

#### Query Qualifiers

| Qualifier | Example | Description |
|-----------|---------|-------------|
| `is:issue` / `is:pr` | `is:issue` | Filter by type (legacy) |
| `type:issue` / `type:pr` | `type:issue` | Filter by type (advanced) |
| `is:open` / `is:closed` | `is:open` | Filter by state |
| `repo:owner/name` | `repo:expo/expo` | Limit to repository |
| `org:name` | `org:facebook` | Limit to organization |
| `author:user` | `author:brentvatne` | Filter by author |
| `assignee:user` | `assignee:me` | Filter by assignee |
| `label:name` | `label:bug` | Filter by label |
| `milestone:title` | `milestone:"v1.0"` | Filter by milestone |
| `in:title,body,comments` | `in:title` | Where to search |

#### Sort Options

`created`, `updated`, `comments`, `reactions`, `interactions`

Order: `asc` or `desc` (default: `desc`)

#### Advanced Search (`advanced_search=true`)

Append `advanced_search=true` as a **query parameter** (not in the `q` string) to activate the newer search backend.

**Key differences:**
- Uses `type:issue`/`type:pr` instead of `is:issue`/`is:pr`
- Supports `OR` operators: `(repo:cli/cli OR repo:cli/go-gh)`
- Supports grouped qualifiers: `(is:open OR is:closed)`
- Better relevance ranking for natural language queries
- Only for issues/PRs, NOT code search

**Reference:** gh CLI PR [#11638](https://github.com/cli/cli/pull/11638) (merged Sept 2025)

### Code Search (`GET /search/code`)

Search code content in repositories.

**Rate limit:** 10 requests/min (most restrictive)

**Max results:** 1000 total, 100 per page

#### Query Qualifiers

| Qualifier | Example | Description |
|-----------|---------|-------------|
| `repo:owner/name` | `repo:facebook/react` | Limit to repository |
| `path:glob` | `path:src/**/*.ts` | Filter by file path |
| `language:lang` | `language:typescript` | Filter by language |
| `extension:ext` | `extension:json` | Filter by extension |
| `filename:name` | `filename:package.json` | Filter by filename |
| `size:range` | `size:>1000` | Filter by file size |

#### Limitations

- **Legacy engine only** — does NOT use the newer search engine from github.com
- Default branch only
- Files must be < 384 KB
- No regex support via API (web UI only)
- No sort options (best match only)
- Must include at least one search term (qualifiers alone are insufficient)

> **gh CLI disclaimer:** "Note that these search results are powered by what is now a legacy GitHub code search engine. The results might not match what is seen on github.com."

#### Text Match Metadata

Add header to get highlighted text fragments:

```
Accept: application/vnd.github.text-match+json
```

Returns `text_matches` array with `fragment` and `matches` for each result.

## General Limits

- Max query length: 256 characters
- Max AND/OR operators: 5
- Max total results: 1000 (pagination ceiling)
- Authentication recommended for higher rate limits
