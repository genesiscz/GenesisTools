# Semantic and hybrid issue search

`tools github search` accepts `--search-type keyword|semantic|hybrid` for issues and pull requests.

| Mode | Corpus | Ranking |
| --- | --- | --- |
| keyword (default) | GitHub | Existing advanced and legacy issue endpoints |
| semantic | Issues and PRs already fetched into the local GitHub cache | Cosine similarity of English DarwinKit sentence embeddings |
| hybrid | The same local cache | Reciprocal rank fusion of cosine similarity and SQLite FTS5 matches |

```sh
tools github search "app exits while saving" --search-type semantic --repo owner/repo --state open
tools github search "empty window repo:owner/repo is:open" --search-type hybrid
```

A local search reads the issue cache populated by `tools github issue` and `tools github pr`. It filters the candidates before ranking. DarwinKit embeds the query and each candidate's title and opening body text on the Mac. Hybrid also reads the full title and body for literal matches. The index lives in memory for one invocation. Runtime grows with the number of matching cached issues. A new cache has no hits.

Use `--repo` or an inline `repo:owner/repo`, `is:open|closed` or `--state`, and `type:issue|pr` or `--type`. The issue reaction filter accepts `reactions:>=N` or `--min-reactions N`. Older cache rows have unknown totals until refreshed. A minimum excludes those rows. The comment reaction filter considers only comments already cached. Results return up to 100 issues or PRs in relevance order.

Local modes make zero GitHub or hosted embedding requests. They require macOS and the installed DarwinKit sentence embedding. Results identify their source as `local-semantic` or `local-hybrid`. Keyword search continues to support GitHub query syntax, sorting, and `--advanced` or `--legacy`.

## GitHub-hosted search

The November 2026 handoff records GitHub-hosted semantic issue search as generally available on April 2, 2026, with CLI support in gh 2.98.0. Its REST example uses `GET /search/issues` with `search_type=semantic` or `hybrid` and `repo:owner/repo` inside `q`. The handoff reports that this repository qualifier returned hits in a case where gh 2.100's `--repo` returned none. It gives a limit of ten hosted semantic or hybrid requests per minute. This implementation does not call those endpoints. The installed gh 2.100.0 manual also describes the hosted modes as issues-only, relevance-ranked, and limited to one page. The GraphQL enum values and combinations with `advanced_search` have not been verified here.
