# MCP Web Reader

A web content reader that fetches raw HTML, Jina Reader Markdown, or local-extracted Markdown. Available as both an MCP server and a CLI tool.

## CLI Usage

```bash
# Raw HTML
tools mcp-web-reader --mode raw --url https://example.com > page.html

# Local Markdown (basic depth)
tools mcp-web-reader --mode markdown --depth basic --url https://example.com > page.md

# Local Markdown (advanced depth: anchors, metadata, absolute links)
tools mcp-web-reader --mode markdown --depth advanced --url https://example.com > page.md

# Jina Reader Markdown
tools mcp-web-reader --mode jina --url https://example.com > page.md

# Token limiting and compaction
# Limit to ~2048 tokens and compact code blocks/whitespace
tools mcp-web-reader --mode markdown --url https://example.com --tokens 2048 --save-tokens > clipped.md
```

Options:

-   `--mode, -m`: `raw | markdown | jina`
-   `--url, -u`: Source URL (required)
-   `--depth, -d`: `basic | advanced` (default: basic). Advanced adds:
    -   absolute anchors on headings
    -   Jina-like header (title, URL Source, published time)
    -   absolute URLs for links/images
-   `--tokens, -T`: Maximum output tokens (approx. GPT-3 tokenizer)
-   `--save-tokens, -s`: Compact code blocks (strip trailing spaces, collapse blank lines) and mild whitespace normalization
-   `--out, -o`: Write to file

## MCP Tools

Server command:

```bash
bun run src/mcp-web-reader/index.ts --server
```

Exposed tools:

-   `FetchWebRaw`: Fetch raw HTML of a URL
-   `FetchWebMarkdown`: Extract Markdown locally (Readability + Turndown)
-   `FetchJina`: Fetch Markdown via Jina Reader proxy

All tools accept the same parameters:

```json
{
  "url": "https://example.com",
  "depth": "basic" | "advanced",
  "save_tokens": 0 | 1,
  "tokens": 2048
}
```

Return format includes a token count in metadata:

```json
{
    "content": [{ "type": "text", "text": "..." }],
    "meta": { "tokens": "1234" }
}
```

## Notes

-   Tokenization uses `gpt-3-encoder` to approximate GPT token counts.
-   Compaction aims to preserve semantics while reducing token usage, focusing on fenced code blocks.
-   Advanced extraction attempts to mimic Jina Reader structure for headings and metadata.
