# GitHub Semantic Search Status

*Last updated: February 2026*

## Overview

GitHub has three separate "semantic/improved search" efforts. Only one is partially accessible via REST API.

| Feature | Status | Public API? | Where Available |
|---------|--------|-------------|-----------------|
| Copilot semantic code search | GA (March 2025) | No | VS Code, GitHub.com Copilot Chat |
| New code search engine | GA on web (2023+) | No | github.com web UI only |
| Improved Issue search | Public preview (Jan 29, 2026) | No (web UI only) | Issues tab on github.com |
| Advanced issue search (`advanced_search=true`) | GA (Sept 2025) | **Yes** | REST API, gh CLI |

## What Works via API

### `advanced_search=true` Query Parameter

The **only** API-accessible improvement. Append to `GET /search/issues`:

```
GET /search/issues?q=deep+linking+type:issue+repo:expo/expo&advanced_search=true
```

- Uses newer search backend with better relevance ranking
- Supports OR operators and grouped qualifiers
- Uses `type:issue`/`type:pr` instead of `is:issue`/`is:pr`
- Merged in gh CLI [PR #11638](https://github.com/cli/cli/pull/11638) (Sept 8, 2025)
- Results genuinely differ from legacy — natural language queries return different (often more relevant) results

## What Does NOT Work via API

### Copilot Semantic Code Search

Vector embeddings that find code by meaning. GA since March 12, 2025.

- Copilot-internal feature, no public API
- Works in VS Code Copilot Chat, GitHub.com Copilot Chat
- [Changelog announcement](https://github.blog/changelog/2025-03-12-instant-semantic-code-search-indexing-now-generally-available-for-github-copilot/)

### New Code Search Engine

Supports regex, symbol search, boolean operators on github.com web UI.

- NOT exposed via REST API — API still uses legacy engine
- gh CLI maintainer confirmed (issue [#8522](https://github.com/cli/cli/issues/8522)):
  > "The code search used on the web is using a newer search engine to power the queries, this search engine does not have API endpoints."
- `gh search code --help` disclaimer: "these search results are powered by what is now a legacy GitHub code search engine"

### Improved Issue Search (Jan 2026)

Semantic index for issue search. 39% better results in testing.

- Public preview (Jan 29, 2026)
- Web UI only — no REST API endpoints, headers, or parameters
- Natural language queries → semantic matching; quoted queries → lexical matching
- [Changelog announcement](https://github.blog/changelog/2026-01-29-improved-search-for-github-issues-in-public-preview/)

## What to Watch For

If GitHub exposes more search capabilities via API, look for:
- New REST API endpoints or API versions
- Preview headers like `application/vnd.github.<feature>-preview+json`
- `gh` CLI removing the "legacy engine" disclaimer from `gh search code --help`
- New parameters on existing `/search/code` endpoint
- GraphQL `SearchType` enum gaining new values (like `ISSUE_ADVANCED` did)

## Sources

- [gh CLI PR #11638: Use advanced issue search](https://github.com/cli/cli/pull/11638)
- [gh CLI issue #8522: search code not returning all results](https://github.com/cli/cli/issues/8522)
- [GitHub Changelog: Improved Issue search preview (Jan 2026)](https://github.blog/changelog/2026-01-29-improved-search-for-github-issues-in-public-preview/)
- [GitHub Changelog: Copilot semantic code search (March 2025)](https://github.blog/changelog/2025-03-12-instant-semantic-code-search-indexing-now-generally-available-for-github-copilot/)
- [GitHub REST API: Search endpoints](https://docs.github.com/en/rest/search/search)
- [GitHub Docs: About GitHub Code Search](https://docs.github.com/en/search-github/github-code-search/about-github-code-search)
