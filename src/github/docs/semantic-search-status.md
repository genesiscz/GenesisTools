# Semantic and hybrid issue search

`tools github search` defaults to keyword search. Select `--search-type semantic` or `--search-type hybrid` to use GitHub's hosted issue search. Add `--local` to search previously fetched issues and pull requests offline on macOS.

| Flags | Corpus and ranking | Result `source` |
| --- | --- | --- |
| `--search-type keyword` (default) | GitHub's advanced and legacy keyword search | `advanced`, `legacy` or `both` |
| `--search-type semantic` or `hybrid` | One page from GitHub, in the order GitHub returns it | `semantic` or `hybrid` |
| Either mode with `--local` | DarwinKit embeddings rank the local GitHub cache. Hybrid also uses SQLite FTS5. | `local-semantic` or `local-hybrid` |

## Hosted REST search

The command sends one `GET /search/issues` with `advanced_search=true` and `search_type=semantic` or `search_type=hybrid`. The query parameter `q` carries the words and qualifiers. For example, `--repo owner/repo --type issue --state open` adds `repo:owner/repo`, `is:issue` and `is:open`. Use `--type pr` or `--state closed` for the corresponding qualifiers. The default `all` leaves that filter out.

`--limit` sets the page size (1 to 100, default 30). An HTTP 403 or 429 ends the search and reports the quota reset time when GitHub supplies it. The command makes no automatic retry. For a comment-reaction threshold, use keyword search to scan comments over GraphQL, or add `--local` to filter cached comments.

### Measurements on 2026-11-18

The orchestrator used `gh api` against the live REST endpoint. The base query was `repo:anthropics/claude-code which model writes the compaction summary`.

| Request | Observed response |
| --- | --- |
| Base query with `search_type=semantic` or `search_type=hybrid`, without `advanced_search` | Both returned HTTP 200 and 303 hits. The first eight in both were 101309, 109452, 108089, 94564, 97775, 96422, 104579, 104577. |
| Base query without `search_type` or `advanced_search` | Also 303 hits. The matching counts alone do not establish identical rankings. |
| Base query with `search_type=semantic` and `advanced_search=true` | 206 hits. The first eight were 109452, 107367, 104577, 105092, 107178, 108089, 103708, 109620. |
| `repo:anthropics/claude-code is:open is:issue which model writes the compaction summary` with `search_type=semantic` | 46 hits. Issue #96316 ranked fourth. This call omitted `advanced_search`. |
| `reactions:>5` inside `q` with `search_type=semantic` | HTTP 200 with 71 hits. |

The repository qualifier worked inside `q`. These responses carried `X-RateLimit-Limit: 10`, consistent with the handoff's ten requests per minute. On 2026-11-11 the handoff also recorded an empty result from `gh search issues --search-type semantic --repo ...`.

Adding `advanced_search=true` changed the semantic request's count and order. An advanced-only control would isolate the effect of `search_type` on this query. To check whether #96316 appears with both parameters, run the following command from the worktree.

```sh
./tools github search "which model writes the compaction summary" --repo anthropics/claude-code --type issue --state open --search-type semantic --limit 100 --format json | jq -e '.[] | select(.number == 96316 and .source == "semantic")'
```

The GraphQL search types `ISSUE_SEMANTIC` and `ISSUE_HYBRID` remain unverified.

## Offline cache search

```sh
tools github search "app exits while saving" --search-type semantic --local --repo owner/repo --state open
tools github search "empty window repo:owner/repo is:open" --search-type hybrid --local
```

A local search reads the issue cache populated by `tools github issue` and `tools github pr`. It filters the candidates before ranking. DarwinKit embeds the query and each candidate's title and opening body text on the Mac. Hybrid also reads the full title and body for literal matches. The index lives in memory for one invocation. Runtime grows with the number of matching cached issues. A new cache has no hits.

Use `--repo` or an inline `repo:owner/repo`, `is:open|closed` or `--state`, and `type:issue|pr` or `--type`. The issue reaction filter accepts `reactions:>=N` or `--min-reactions N`. Older cache rows have unknown totals until refreshed. A minimum excludes those rows. The comment reaction filter considers only comments already cached. Results return up to 100 issues or PRs in relevance order.

Local modes make zero GitHub or hosted embedding requests. They require macOS and the installed DarwinKit sentence embedding. Results identify their source as `local-semantic` or `local-hybrid`. Keyword search continues to support GitHub query syntax, sorting, and `--advanced` or `--legacy`.
