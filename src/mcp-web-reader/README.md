# tools mcp-web-reader

Fetch a web page and return its main content as clean Markdown, its raw HTML, or the Markdown that the Jina Reader
service renders. It is a CLI and an MCP stdio server with three read-only tools, so an AI assistant can read a page
without navigation, banners, cookie notices and other page furniture.

## Quick start

```bash
# The page's main content as Markdown (a bare host such as example.com gets https://)
tools mcp-web-reader https://example.com

# Markdown with YAML front matter (title, url, author, date), cut at 2048 tokens, written to a file
tools mcp-web-reader https://example.com/blog/post --depth advanced --tokens 2048 -o post.md

# The raw HTML, with runs of whitespace compacted
tools mcp-web-reader https://example.com --mode raw --save-tokens

# A page that needs JavaScript: Jina Reader renders it on its side
tools mcp-web-reader https://app.example.com/dashboard --mode jina

# A page behind a login: send your own request headers
tools mcp-web-reader https://example.com/account --headers '{"Cookie":"session=abc123"}'

# Start the MCP stdio server
tools mcp-web-reader --server
```

## Command and flags

The tool has one command and no subcommands: `tools mcp-web-reader [options] [url]`.

| Flag | Default | What it does |
| --- | --- | --- |
| `[url]`, `-u, --url <url>` | | The page to fetch. The positional wins over `--url`. |
| `-m, --mode [mode]` | `markdown` | `markdown`, `raw` or `jina` (see Modes). |
| `-e, --engine [engine]` | `turndown` | Markdown engine. `turndown` is the only one. |
| `-d, --depth [depth]` | `basic` | `advanced` adds YAML front matter (markdown mode). |
| `-T, --tokens <n>` | no limit | Return at most this many tokens. A positive whole number. |
| `-s, --save-tokens` | off | Compact whitespace (raw) or code blocks (markdown, jina). |
| `-o, --out <path>` | stdout | Write the result to a file instead of stdout. |
| `--headers <json>` | | Extra request headers as a JSON object of strings. Not sent in jina mode. |
| `--server` | | Start the MCP stdio server instead of the CLI. |
| `--list-engines` | | Print the Markdown engines and exit. |
| `-v, --verbose` | | Print the debug log lines on stderr. |
| `--readme` | | Print this README and exit. |

- The URL is trimmed. A value without `http://` or `https://` gets `https://`. A value that does not parse fails with
  `Not a valid URL: "<value>"`.
- `--mode`, `--engine` and `--depth` take a fixed set of values. Given bare in a terminal, they open a picker. Given
  an unknown value, or bare without a terminal, they print the possible values and a corrected command, and exit 1.
- `--engine` and `--depth` change only markdown mode. `--headers` is used in markdown and raw mode.
- `--server` ignores `--mode`, `--engine`, `--depth`, `--headers`, `-o` and the URL (but `--help`, `--readme` and a bad
  `--tokens` value come first), and `--list-engines` wins over a URL.
- The page text goes to stdout. The status lines (`Fetching …`, `Wrote post.md: 1234 tokens …`, errors) go to
  stderr, so `tools mcp-web-reader https://example.com > page.md` and a pipe get only the page.

### Modes

- `markdown` (default): fetch the page, find its main content, and convert it to Markdown locally. No request goes
  anywhere except to the page and its redirects.
- `raw`: the page's HTML as the server sent it. `--save-tokens` turns each run of spaces and tabs into one space and
  keeps at most one blank line.
- `jina`: fetch `https://r.jina.ai/<url>` and return the Markdown that Jina Reader renders. The page URL goes to Jina,
  your `--headers` do not, and no API key is sent. Use it for a page that builds its content with JavaScript.

## How it works

### Fetching

- One GET with a desktop Chrome User-Agent (Chrome 126 on macOS) and `Accept: */*`. A `User-Agent` key in `--headers`,
  spelled exactly `User-Agent`, replaces that default. Another casing, such as `user-agent`, is appended to it. The
  same holds for `Accept`.
- Up to 5 redirects are followed by hand, and only to http or https addresses. A redirect to `file:` or any other
  scheme is refused.
- `--headers` go only to the origin you asked for. An `http` address that upgrades to `https` on the same host, with
  no explicit port, counts as the same origin. A redirect to another origin gets no caller headers.
- The whole read (every redirect and the body) is cut after 30 s. In the MCP server, a cancelled call aborts the request.
- A status outside 200 to 299 fails with `HTTP <status> <text> for <url>`.
- The body is always decoded as UTF-8.
- The jina request sends the User-Agent `GenesisTools-mcp-web-reader`. Jina sits behind a bot challenge that answered
  a browser User-Agent from a script with HTTP 403 (checked 2026-10-05).

### Finding the main content (markdown mode)

1. Drop elements that never hold readable content: `script`, `style`, `noscript`, `template`, `iframe`, `object`,
   `embed`, `canvas`, `svg` and form controls.
2. Drop page furniture: hidden elements and dialogs (`hidden`, `aria-hidden="true"`, `dialog`, `aria-modal`),
   `nav` and the `navigation`, `search`, `banner` and `contentinfo` roles, every `footer`, a `header` outside an
   `article`, and an `aside` that sits outside the content, holds a `nav`, or is more than half link text.
3. Drop an element whose class or id holds a noise word as a whole word: `ad`, `ads`, `advert`, `cookie`, `consent`,
   `gdpr`, `sidebar`, `breadcrumb`, `newsletter`, `subscribe`, `share`, `social`, `related`, `comments`, `popup`,
   `modal`, `promo`, `sponsored` and a few more. So `ad-slot` goes but `download-button` and `lead-in` stay. Code
   inside `pre` and `code` is never touched.
4. Steps 2 and 3 never remove an element that is, or holds, `main`, `[role="main"]`, `article` or an `h1`.
5. Pick the content root. The rule that won is reported as `method`:
   - `article`: an `<article>` (inside `<main>` when there is one) that holds at least half of the readable text.
   - `main`: the largest `<main>` or `[role="main"]` with real text: at least 140 characters that are not link
     text (half the page on a shorter page).
   - `scored`: no usable `main`: the container whose paragraphs score highest, the way Readability scores at its
     core (commas and length count, link text counts against).
   - `body`: nothing scored, so the whole body.
6. Inside the root, drop link lists: a block of 10 or more links whose text is at least 85% link text and less than
   half of the root (language pickers, category footers, navboxes). Keep the page's `h1` when it sits above the root.
7. Make links and images absolute against the page's `<base href>`, or against the final URL after redirects when
   the page has none. A lazy image (`data-src`, `data-lazy-src`) gets its real address. An image that is still a
   `data:` placeholder is dropped, so no base64 lands in the Markdown.

### Converting to Markdown

- Turndown with the GFM plugin: tables, strikethrough and task lists. ATX headings, `-` bullets, `*em*`, `**strong**`.
- Fenced code blocks keep their line breaks (a `<br>` from a highlighter becomes a newline) and their language, read
  from `data-language`, `data-lang`, or a `language-*`, `lang-*`, `highlight-*` or `brush:` class. Short names are
  widened: `js`, `ts`, `py`, `rb`, `sh`, `yml` become `javascript`, `typescript`, `python`, `ruby`, `bash`, `yaml`.
  A one-word label above a block that only repeats its language is dropped.
- A fence or an inline code span grows longer than any backtick run inside the code.
- A figure keeps its images and paragraphs; its caption becomes an italic line.
- A heading's permalink glyph (`#`, `¶`, `§`) is dropped. A `#fragment` or `javascript:` link keeps only its text.
- The Markdown is normalized: no trailing spaces, at most one blank line between prose blocks, and one final newline.
  Blank lines inside code blocks are kept.
- The converted Markdown is checked for leftovers: HTML tags in prose (HTML inside code is content), empty links,
  images with an empty `src`, and an unclosed code block. They are reported as `issues` in the MCP result and in
  the `-v` debug line. The CLI prints the Markdown either way.

### Front matter (`--depth advanced`)

`--depth advanced` puts YAML front matter before the Markdown. A field appears only when the page has it, `url` is
the final URL after redirects, and every value is quoted, so a `:` stays text:

```yaml
---
title: "Example Domain"
url: "https://example.com/"
---
```

- `title`: `og:title`, then `<title>`, then the first `h1`.
- `author`: `meta name="author"`, then `article:author` (when it is not a URL), then `rel="author"`, then
  `itemprop="author"`.
- `date`: `article:published_time`, then `publication_date`, then `itemprop="datePublished"`, then the first
  `time[datetime]`.

### Token limit

- `--tokens` and `--save-tokens` apply after conversion. In markdown and jina mode, `--save-tokens` trims trailing
  spaces and collapses runs of blank lines inside code blocks.
- Tokens are counted with `gpt-3-encoder` (through `@genesiscz/utils/tokens`), an approximation of GPT token counts.
  Other models count somewhat differently. If the encoder cannot load, the count falls back to words times 1.3.
- A cut ends at a token boundary and adds no marker. On stdout the cut is silent; with `-o` the status line says
  `(truncated)`, and the MCP result says `truncated: true`.

### Data, logs and cost

- The tool keeps no config, cache or state.
- Debug lines go to the day log `~/.genesis-tools/logs/<date>.log`: the URL, the mode, the final URL, the HTTP
  status, the size, the content rule and the token count. The tool's own debug lines log header names, never header
  values, but they log the URL.
- A failed run (any exit 1) is recorded in `~/.genesis-tools/logs/<date>-failures.jsonl` with its command line. A
  `--headers` value is not masked there (only a Bearer token and some key-shaped values are), and a JSON parse error
  echoes the whole value. A secret in `--headers` or in the URL can land in that file when a fetch fails.
- It costs nothing. Jina mode sends the page URL to a third-party service.

### Code layout

- `index.ts`: the CLI. `mcp/server.ts`: the MCP server (version 0.3.0).
- `lib/read.ts`: `readPage`, the one read path. `lib/fetch.ts`: the request and redirects. `lib/urls.ts`: URL checks
  and the Jina address. `lib/extract.ts`: the main-content rules. `lib/convert.ts`: engines and Turndown rules.
  `lib/markdown.ts`: normalizing, compacting, front matter and the leftover check.
- `tools fetch` imports `lib/convert.ts`, `lib/markdown.ts`, `lib/urls.ts` and `keepsHeaders` from `lib/fetch.ts`. A
  change there changes `tools fetch` too.

## Engines

`turndown` is the only engine. The `mdream` and `readerlm` engines were removed on 2026-10-05, together with their
packages (`mdream`, `@nanocollective/get-md`, `@mozilla/readability`). The `readerlm` engine never ran the ReaderLM
model: `get-md` 1.7 ignores `useLLM` for HTML input and `node-llama-cpp` was not installed, so it was Readability
plus Turndown. Asking for a removed engine fails with a message that names the reason and the engines that remain,
for example `Engine "mdream" was removed (it needed the mdream package). Available engines: turndown.`

## For agents: the MCP server

```bash
tools mcp-web-reader --server
# or, from a checkout
bun run src/mcp-web-reader/index.ts --server
```

Add it to a client's config by hand:

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

Or through `tools mcp-manager`:

```bash
tools mcp-manager install web-reader "tools mcp-web-reader --server" \
    -t stdio \
    -p claude
```

### Tools

All three are annotated read-only, not destructive, idempotent and open-world.

- `FetchWebMarkdown`: `url`, `headers?`, `engine?` (`turndown`), `depth?` (`basic` | `advanced`), `save_tokens?`,
  `tokens?`. Markdown mode.
- `FetchWebRaw`: `url`, `headers?`, `save_tokens?`, `tokens?`. Raw mode.
- `FetchJina`: `url`, `save_tokens?`, `tokens?`. Jina mode: the page URL goes to Jina. Use it for pages that need
  JavaScript.

`url` takes a bare host like the CLI. `tokens` is a positive whole number. `save_tokens` accepts `true`/`false` or
`0`/`1`. The arguments are validated: a bad argument returns an error result that names the field. An argument the
tool does not list is ignored, not an
error, so check the spelling (`tokens`, `save_tokens`). Any failure
(HTTP status, timeout, redirect) returns `isError: true` with `Error: <message>`. An unknown tool name is a protocol
error, `Unknown tool: <name>`.

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

`source` is the address after redirects (for `FetchJina`, the Jina address). `method` names the rule that picked the
content root (`main`, `article`, `scored`, `body`). `conversionTime` covers extraction plus conversion. `FetchWebRaw`
and `FetchJina` return only `tokens`, `truncated` and `source`.

### The CLI from a script

The CLI has no `--json` flag. For the token count, the final URL and the content rule as data, call the MCP server,
or use `tools fetch --json`.

The CLI exits 0 when it printed or wrote the page. It exits 1 when the URL is missing or invalid, an enumerated flag
has a bad value, `--tokens` is not a positive whole number, `--headers` is not a JSON object of strings, or the fetch
fails.

## Troubleshooting

- **`HTTP 403 Forbidden for <url>`** on a site behind Cloudflare or another bot wall. Plain Bun fetch is refused
  there. Use `tools fetch <url>`: its default `auto` transport retries with a real Chrome fingerprint. Or try
  `--mode jina`.
- **Almost no content, or the wrong part of the page.** The page builds its content with JavaScript, or it has no
  `main` or `article`. Write it with `-o page.md`: the status line names the rule that picked the root (for example
  `body content`). `body` or `scored` on a thin result points at a JavaScript page. Use `--mode jina`.
- **Broken accented letters.** The page is served in another charset (for example `windows-1250`), and the body is
  always decoded as UTF-8.
- **`More than 5 redirects for <url>`.** The site loops or chains redirects. Fetch the final address directly.
- **`Refusing the redirect from <a> to <b>: it is not an http or https address`.** The site redirects to another
  scheme. Nothing is read.
- **`Failed: Unexpected token ... is not valid JSON`.** The shell removed the quotes. Wrap the JSON in single quotes.
- **`--headers must be a JSON object of string values`.** Give every value as a string:
  `--headers '{"X-Count":"3"}'`, not `3`.
- **You get the login page although you sent the cookie.** A redirect went to another origin (for example
  `example.com` to `www.example.com`, or to a login host), and the headers were not sent there. Use the final
  address. With `-v`, the line `mcp-web-reader redirected to another origin` names both origins.
- **An MCP client cannot start the server.** The client may not see your shell's PATH. Put the absolute path of
  `tools` (from `command -v tools`) in `command`.
- **What happened on a run?** Add `-v`, or read the `mcp-web-reader` lines in `~/.genesis-tools/logs/<date>.log`.

## Related

- [fetch](../fetch/README.md): the same Markdown conversion plus a Chrome TLS fingerprint for bot walls, JSON-LD
  output and `--json`.
- [mcp-manager](../mcp-manager/README.md): install this MCP server into Claude Code, Codex, Cursor and others.
- [markdown-cli](../markdown-cli/README.md): render the Markdown in a terminal, for example
  `tools mcp-web-reader https://example.com | tools markdown-cli`.
