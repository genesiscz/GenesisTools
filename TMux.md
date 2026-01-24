# Tmux Quick Reference Guide

> **Prefix**: `Ctrl+b` (press before any command)

---

## Sessions

| Command | Description |
|---------|-------------|
| `tmux` | Start new session |
| `tmux new -s name` | New named session |
| `tmux ls` | List sessions |
| `tmux a` or `tmux attach` | Attach to last session |
| `tmux a -t name` | Attach to named session |
| `Ctrl+b d` | **Detach** from session |
| `Ctrl+b $` | Rename session |
| `Ctrl+b s` | **Session tree** (native list) |

**Project Aliases:**
```bash
tcolfe         # col-fe project
treservine     # Reservine project
tgenesis       # GenesisTools project
ta             # tmux attach
tl             # tmux ls
```

---

## Windows (Tabs)

| Command | Description |
|---------|-------------|
| `Ctrl+b c` | **Create** new window |
| `Ctrl+b ,` | **Rename** window |
| `Ctrl+b n` | **Next** window |
| `Ctrl+b p` | **Previous** window |
| `Ctrl+b 0-9` | Jump to window number |
| `Ctrl+b w` | **Window picker** |
| `Ctrl+b &` | Kill window |

---

## Panes (Splits)

### Create Splits
| Command | Description |
|---------|-------------|
| `Ctrl+b \|` | Split **vertical** (custom) |
| `Ctrl+b -` | Split **horizontal** (custom) |

### Navigate Panes
| Command | Description |
|---------|-------------|
| `Ctrl+b h/j/k/l` | Navigate **vim-style** (custom) |
| `Ctrl+b arrows` | Navigate with arrows |
| `Ctrl+b z` | **Zoom** pane (toggle fullscreen) |
| `Ctrl+b x` | Kill pane |
| `Ctrl+b q` | Show pane numbers |
| `Ctrl+b space` | Cycle layouts |

### Resize Panes
| Command | Description |
|---------|-------------|
| `Ctrl+b H/J/K/L` | Resize **vim-style** (custom, hold to repeat) |
| `Ctrl+b {` | Swap with previous |
| `Ctrl+b }` | Swap with next |

---

## Copy Mode (Vim-style)

| Command | Description |
|---------|-------------|
| `Ctrl+b [` | **Enter** copy mode |
| `q` | Exit copy mode |
| `/` | Search forward |
| `?` | Search backward |
| `n/N` | Next/previous match |
| `v` | Start **selection** (custom) |
| `y` | **Copy** to clipboard (custom) |
| `Ctrl+b ]` | **Paste** |

---

## System

| Command | Description |
|---------|-------------|
| `Ctrl+b r` | **Reload config** (custom) |
| `Ctrl+b ?` | Show all keybindings |
| `Ctrl+b t` | Show time |
| `Ctrl+b :` | Command prompt |

---

## Plugins (Installed)

| Plugin | Trigger | Description |
|--------|---------|-------------|
| **tmux-fzf** | `Ctrl+b F` | Fuzzy finder for sessions/windows/panes |
| **tmux-resurrect** | `Ctrl+b Ctrl+s` | Save session |
| | `Ctrl+b Ctrl+r` | Restore session |
| **tmux-continuum** | Auto | Auto-saves every 15 min |

---

## Common Workflows

### Setup Project Session
```bash
tmux new -s myproject
Ctrl+b |           # split for tests
Ctrl+b -           # split for logs
Ctrl+b z           # zoom when needed
```

### Jump Between Projects
```bash
Ctrl+b s           # session tree (native list)
# or use aliases:
tcolfe             # switch to col-fe
treservine         # switch to Reservine
```

### Copy from Terminal
```bash
Ctrl+b [           # enter copy mode
/search term       # find what you need
v                  # start selection
y                  # copy to clipboard
Ctrl+b ]           # paste
```

### Save/Restore Sessions
Sessions auto-save every 15 minutes with `tmux-continuum`.

Manual control:
- `Ctrl+b Ctrl+s` - Save now
- `Ctrl+b Ctrl+r` - Restore

---

## Status Bar Info

Your Tokyo Night theme shows:
- **Left**: Session name, windows
- **Center**: Current path, git branch/status
- **Right**: CPU usage, prefix indicator

---

## Tips

1. **Mouse works!** Click panes, resize, scroll in copy mode
2. **Detach freely** - `Ctrl+b d` - sessions survive terminal close
3. **Use zoom** - `Ctrl+b z` - focus on one pane, toggle back
4. **FZF everything** - `Ctrl+b F` - fuzzy find sessions/windows
5. **Vim navigation** - `hjkl` everywhere (panes, copy mode)

---

## Troubleshooting

**Plugins not working?**
```bash
tmux
Ctrl+b I           # Install plugins (capital I)
Ctrl+b r           # Reload config
```

**Status bar looks wrong?**
```bash
# Check if gitmux is installed
gitmux -V
# If not: brew install gitmux
```

**Session not restoring?**
```bash
# Check tmux-resurrect directory
ls ~/.tmux/resurrect/
# Should have save files
```

---

## Config Location
`~/.tmux.conf`

To reload: `Ctrl+b r`
