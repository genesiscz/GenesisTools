# Code Block Rendering

## TypeScript (with line numbers)

```ts
interface ToolInfo {
    name: string;
    description: string;
    hasReadme: boolean;
    path: string;
}

export function discoverTools(srcDir: string): ToolInfo[] {
    const tools: ToolInfo[] = [];
    return tools.sort((a, b) => a.name.localeCompare(b.name));
}
```

## Shell Commands (no line numbers)

```bash
# Install dependencies
bun install

# Run a tool
tools markdown-cli demo

# Watch mode
tools markdown-cli README.md --watch
```

## JSON Configuration

```json
{
    "name": "genesis-tools",
    "version": "1.0.0",
    "type": "module",
    "scripts": {
        "start": "bun run tools"
    }
}
```

## Inline Code

Use `renderMarkdownToCli()` to render markdown. The `--watch` flag enables live reload.
