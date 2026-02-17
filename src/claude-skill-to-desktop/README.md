# claude-skill-to-desktop

Sync skills from `~/.claude/skills/` into Claude Desktop's local skill registry.

## Usage

```bash
tools claude-skill-to-desktop           # Interactive multiselect
tools claude-skill-to-desktop --all     # Install all skills
tools claude-skill-to-desktop --list    # List skills and install status
```

## Notes

- Requires Claude Desktop to be installed at the standard macOS location
- Restart Claude Desktop after installing to pick up changes
- Skills with `creatorType: "anthropic"` (Anthropic built-ins) are not overwritten
