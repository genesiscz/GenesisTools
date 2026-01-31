# MCP Web Reader

A web content reader that fetches URLs and converts HTML to Markdown using pluggable engines. Available as both an MCP server and a CLI tool.

## Features

- **Multiple Engines**: Choose between `turndown` (GFM), `mdream` (fast), or `readerlm` (AI-powered)
- **ReaderLM Support**: Optional local AI model for highest quality conversion
- **Token Management**: Limit output tokens and compact code blocks
- **MCP Server**: Use as an MCP tool for AI assistants

## CLI Usage

```bash
# Basic usage (defaults to markdown mode with turndown engine)
tools mcp-web-reader "https://example.com"

# Choose engine
tools mcp-web-reader "https://example.com" --engine turndown   # Default, GFM support
tools mcp-web-reader "https://example.com" --engine mdream     # Fast, LLM-optimized
tools mcp-web-reader "https://example.com" --engine readerlm   # AI-powered (requires model)

# Other modes
tools mcp-web-reader "https://example.com" --mode raw          # Raw HTML
tools mcp-web-reader "https://example.com" --mode jina         # Jina Reader API

# Advanced options
tools mcp-web-reader "https://example.com" --depth advanced    # YAML frontmatter
tools mcp-web-reader "https://example.com" --tokens 2048       # Limit tokens
tools mcp-web-reader "https://example.com" --save-tokens       # Compact output
tools mcp-web-reader "https://example.com" -o page.md          # Save to file
```

## ReaderLM Model

The `readerlm` engine uses [ReaderLM-v2](https://huggingface.co/jinaai/ReaderLM-v2), a local AI model for HTML-to-Markdown conversion optimized for LLMs (512K tokens, 29 languages).

```bash
# Check model status
tools mcp-web-reader --model-info

# Download model (~1GB one-time download)
tools mcp-web-reader --download-model

# Download and convert in one command
tools mcp-web-reader "https://example.com" --engine readerlm --download-model
```

## Options

```
Usage: mcp-web-reader [options] [url]

Arguments:
  url                    URL to fetch (or use --url)

Options:
  -u, --url <url>        Source URL
  -m, --mode <mode>      raw | markdown | jina (default: "markdown")
  -e, --engine <engine>  Markdown engine: turndown|mdream|readerlm (default: "turndown")
  -d, --depth <depth>    Extraction depth: basic | advanced (default: "basic")
  -T, --tokens <n>       Max AI tokens to return
  -s, --save-tokens      Compact code blocks and whitespace
  -o, --out <path>       Output file path
  --headers <json>       Additional request headers as JSON
  --server               Start as MCP server instead of CLI
  --list-engines         List available markdown engines
  --model-info           Show ReaderLM model status
  --download-model       Download ReaderLM model (~1GB)
  -h, --help             display help for command
```

## Engines Comparison

| Engine | Speed | Quality | Requirements |
|--------|-------|---------|--------------|
| `turndown` | Fast | Good | None (default) |
| `mdream` | Fastest | Good | None |
| `readerlm` | Slower | Best | ~1GB model download |

## MCP Server

Start as MCP server:

```bash
tools mcp-web-reader --server
# or
bun run src/mcp-web-reader/index.ts --server
```

### MCP Tools

- `FetchWebRaw`: Fetch raw HTML
- `FetchWebMarkdown`: Convert to Markdown (supports `engine` parameter)
- `FetchJina`: Use Jina Reader API

### MCP Configuration

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

### Tool Parameters

```json
{
  "url": "https://example.com",
  "engine": "turndown",
  "depth": "basic",
  "save_tokens": 0,
  "tokens": 2048
}
```

### Response Format

```json
{
    "content": [{ "type": "text", "text": "..." }],
    "meta": {
        "tokens": "1234",
        "engine": "turndown",
        "conversion_time_ms": "45"
    }
}
```

## Notes

- Tokenization uses `gpt-3-encoder` to approximate GPT token counts
- The `readerlm` engine requires downloading a ~1GB model on first use
- Advanced depth adds YAML frontmatter with title, URL, author, and date
