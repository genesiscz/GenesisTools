# MCP Web Reader

Fetch a web page and return its main content as Markdown, its raw HTML, or the Markdown that the Jina Reader service renders. It works as a CLI and as an MCP stdio server; both call the same core in `lib/read.ts`.

## Features

- **Main-content extraction**: navigation, banners, footers, sidebars, link lists, ad and cookie blocks are dropped. The content root is the page's `<main>`, an `<article>` that holds most of its text, or the container whose paragraphs score highest.
- **Clean Markdown**: GFM tables, fenced code blocks with the language detected from the page, figure captions, absolute links and images, no base64 placeholder images.
- **Token management**: cap the output at a token count, and compact whitespace or code blocks.
- **MCP server**: three read-only tools for AI assistants.

## CLI usage

```bash
# Main content as Markdown (default mode)
tools mcp-web-reader "https://example.com"

# Other modes
tools mcp-web-reader "https://example.com" --mode raw          # Raw HTML
tools mcp-web-reader "https://example.com" --mode jina         # Markdown rendered by Jina Reader (https://r.jina.ai)

# Options
tools mcp-web-reader "https://example.com" --depth advanced    # YAML front matter: title, url, author, date
tools mcp-web-reader "https://example.com" --tokens 2048       # At most 2048 tokens
tools mcp-web-reader "https://example.com" --save-tokens       # Compact whitespace / code blocks
tools mcp-web-reader "https://example.com" -o page.md          # Write to a file
tools mcp-web-reader "https://example.com" --headers '{"Cookie":"a=b"}'   # Extra request headers (not sent to Jina)
tools mcp-web-reader --list-engines
```

`--mode`, `--engine` and `--depth` take a fixed set of values. Given bare in a terminal, they open a picker. Given an unknown value, or bare without a terminal, they print the possible values and a corrected command, and exit 1.

## Options

```
Usage: mcp-web-reader [options] [url]

Arguments:
  url                    URL to fetch (or use --url)

Options:
  -u, --url <url>        Source URL
  -m, --mode [mode]      Output: markdown | raw | jina (default: "markdown")
  -e, --engine [engine]  Markdown engine: turndown (default: "turndown")
  -d, --depth [depth]    basic | advanced (advanced adds YAML front matter) (default: "basic")
  -T, --tokens <n>       Return at most this many tokens
  -s, --save-tokens      Compact whitespace (raw) or code blocks (markdown, jina)
  -o, --out <path>       Write to a file instead of stdout
  --headers <json>       Extra request headers as a JSON object (not sent in jina mode)
  --server               Start the MCP stdio server instead of the CLI
  --list-engines         List the markdown engines
```

## Engines

`turndown` is the only engine. The `mdream` and `readerlm` engines were removed on 2026-10-05 together with their packages (`mdream`, `@nanocollective/get-md`, `@mozilla/readability`). The `readerlm` engine never ran the ReaderLM model: `get-md` 1.7 ignores `useLLM` for HTML input and `node-llama-cpp` was not installed, so it was Readability plus Turndown. Asking for a removed engine fails with a message that names the engines that remain.

## MCP server

```bash
tools mcp-web-reader --server
# or
bun run src/mcp-web-reader/index.ts --server
```

### Tools

All three are annotated read-only, idempotent and open-world. Arguments are validated; a bad argument returns an error result that names the field.

- `FetchWebMarkdown`: `url`, `headers?`, `engine?` (`turndown`), `depth?` (`basic` | `advanced`), `save_tokens?`, `tokens?`
- `FetchWebRaw`: `url`, `headers?`, `save_tokens?`, `tokens?`
- `FetchJina`: `url`, `save_tokens?`, `tokens?`. The page URL goes to Jina; use it for pages that need JavaScript.

`save_tokens` accepts `true`/`false` or `0`/`1`. A cancelled call aborts the HTTP request. Every request has a 30 s timeout.

### Configuration

```json
{
    "mcpServers": {
        "web-reader": {
            "command": "tools",
            "args": ["mcp-web-reader", "--server"]
        }
    }
}
```

### Result

```json
{
    "content": [{ "type": "text", "text": "# Title\n\n..." }],
    "_meta": {
        "tokens": 1234,
        "truncated": false,
        "source": "https://example.com/",
        "engine": "turndown",
        "method": "main",
        "conversionTime": "45ms",
        "issues": []
    }
}
```

`source` is the address after redirects. `method` names the rule that picked the content root (`main`, `article`, `scored`, `body`). `issues` lists conversion leftovers such as HTML tags outside code or an unclosed code block. `FetchWebRaw` and `FetchJina` return only `tokens`, `truncated` and `source`.

## Notes

- Token counts use `gpt-3-encoder` (through `@genesiscz/utils/tokens`) to approximate GPT token counts.
- Relative links resolve against the final URL after redirects.
- Up to 5 redirects are followed, and only to http or https addresses. `--headers` go to the origin you asked for (an `http` address that upgrades to `https` on the same host counts as the same origin), never to another origin a redirect leads to.
- Text is decoded as UTF-8.
