# Files to Prompt

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Cross--platform-blue?style=flat-square)
![AI Ready](https://img.shields.io/badge/AI-Ready-purple?style=flat-square)

> **Convert files and directories into AI-ready prompts with smart filtering and multiple output formats.**

Concatenate multiple files into a single output optimized for AI systems like Claude, with automatic binary exclusion, gitignore support, and token estimation.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Multiple Formats** | Plain text, Claude XML (`--cxml`), or Markdown (`--markdown`) |
| **Smart Filtering** | Respects `.gitignore`, excludes 50+ binary extensions by default |
| **Token Estimation** | Preview token counts with `--dry` before processing |
| **Stdin Support** | Pipe file lists from `find`, `fd`, or other tools |
| **Line Numbers** | Optional line numbering for code references |
| **Flat Copy Mode** | Copy files to flat folder with path-encoded names |

---

## Quick Start

```bash
# Process all files in a directory
tools files-to-prompt src/

# Output Claude-optimized XML format
tools files-to-prompt src/ --cxml > prompt.xml

# Preview what would be processed (with token estimate)
tools files-to-prompt src/ --dry

# Only TypeScript files with line numbers
tools files-to-prompt -e ts -e tsx src/ --line-numbers

# Pipe from find command
find . -name "*.py" -print0 | tools files-to-prompt -0
```

---

## Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `[paths...]` | - | Files or directories to process | stdin |
| `--extension` | `-e` | File extensions to include (repeatable) | all |
| `--include-hidden` | - | Include hidden files/folders (starting with `.`) | `false` |
| `--ignore-files-only` | - | `--ignore` only ignores files, not directories | `false` |
| `--ignore-gitignore` | - | Ignore `.gitignore` rules | `false` |
| `--ignore` | - | Patterns to ignore (repeatable) | - |
| `--output` | `-o` | Output file (or directory for `--flat-folder`) | stdout |
| `--cxml` | `-c` | XML format optimized for Claude | `false` |
| `--markdown` | `-m` | Markdown with fenced code blocks | `false` |
| `--line-numbers` | `-n` | Add line numbers to output | `false` |
| `--flat-folder` | `-f` | Copy to flat folder with renamed files | `false` |
| `--null` | `-0` | NUL separator for stdin (use with `find -print0`) | `false` |
| `--dry` | - | Show statistics without processing | `false` |

---

## Output Formats

### Default (Plain Text)

```
src/index.ts
---
import { foo } from './foo';
console.log('Hello');

---
```

### Claude XML (`--cxml`)

```xml
<document index="1">
<source>src/index.ts</source>
<document_content>
import { foo } from './foo';
console.log('Hello');
</document_content>
</document>
```

### Markdown (`--markdown`)

```markdown
src/index.ts
```typescript
import { foo } from './foo';
console.log('Hello');
```
```

---

## Usage Examples

<details>
<summary><b>Common Use Cases</b></summary>

### Prepare Code for Claude

```bash
# XML format is optimal for Claude's context window
tools files-to-prompt src/ --cxml -o context.xml

# With line numbers for precise code references
tools files-to-prompt src/ --cxml --line-numbers > prompt.xml
```

### Filter by Extension

```bash
# Only JavaScript and TypeScript
tools files-to-prompt -e js -e ts -e jsx -e tsx src/

# Only Python files
tools files-to-prompt -e py project/
```

### Preview Before Processing

```bash
# See file count, size, and token estimate
tools files-to-prompt src/ --dry

# Output example:
# Files to process: 42
# Directories found: 8
# Total size: 156.2 KB
# Estimated tokens: 45,230
```

### Pipe from External Commands

```bash
# From find (with null separator for safety)
find . -name "*.ts" -print0 | tools files-to-prompt -0 --cxml

# From fd
fd -e ts | tools files-to-prompt --markdown
```

### Copy to Flat Structure

```bash
# Copies files with path-encoded names: src__lib__utils.ts
tools files-to-prompt src/ --flat-folder -o ./flat-output/
```

### Custom Ignore Patterns

```bash
# Ignore test files and mocks
tools files-to-prompt src/ --ignore "*.test.ts" --ignore "*.mock.ts"

# Include everything (bypass gitignore)
tools files-to-prompt src/ --ignore-gitignore --include-hidden
```

</details>

---

## Default Exclusions

The tool automatically excludes 50+ binary file types:

| Category | Extensions |
|----------|------------|
| **Images** | png, jpg, jpeg, gif, svg, webp, ico, bmp, tiff, heic |
| **Media** | mp4, avi, mov, mkv, mp3, wav, flac, aac, ogg |
| **Archives** | zip, tar, gz, bz2, 7z, rar, tgz |
| **Binaries** | exe, dll, so, dylib, bin, app, deb, rpm |
| **Fonts** | ttf, otf, woff, woff2, eot |
| **Documents** | pdf, doc, docx, xls, xlsx, ppt, pptx |
| **Data** | db, sqlite, sqlite3, lockb |

Additionally, `.env.*` files are always excluded for security.

---

## Dry Run Output

The `--dry` flag provides detailed statistics:

```
============================================================
DRY RUN STATISTICS
============================================================

Files to process: 23
Directories found: 5
Total size: 45.2 KB
Estimated tokens: 12,450

Ignored files: 156

  By gitignore (89: 3 directories, 86 files):
    - node_modules/ (86 files)
    - dist/
    - coverage/

  By extension filter (67):
    - assets/ (45 files)
    - public/images/ (22 files)

Files that would be processed (23):
  - src/index.ts
  - src/lib/utils.ts
  - src/components/ (12 files)
  ... and 8 more items

============================================================
```

---

## Important Notes

> **Gitignore Behavior**: By default, `.gitignore` rules are respected. Files and directories matching gitignore patterns are excluded. Use `--ignore-gitignore` to include everything.

> **Hidden Files**: Files starting with `.` are excluded by default. Use `--include-hidden` to include them.

> **Flat Folder Mode**: When using `--flat-folder`, paths are converted to flat names using `__` as separator: `src/lib/utils.ts` becomes `src__lib__utils.ts`.

---

## Technical Details

- Built with **Bun** for fast file operations
- Uses **minimatch** for glob pattern matching
- Respects nested `.gitignore` files in subdirectories
- Token estimation uses character-based heuristics
- Supports both newline and NUL-separated stdin input
