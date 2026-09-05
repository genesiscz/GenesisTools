# `tools codex`

Spawn, monitor, and steer long-lived Codex app-server sessions from GenesisTools.

```bash
tools codex spawn \
  --name reviewer \
  --mode review \
  --prompt "Review the current working tree"

tools codex status --name reviewer
tools codex tail --name reviewer --follow
tools codex steer --name reviewer --body "Focus on the auth path"
tools codex interrupt --name reviewer
tools codex read --name reviewer
tools codex review --name reviewer --scope working-tree
tools codex review --name reviewer --base main --scope branch --adversarial auth rollback
tools codex stop --name reviewer

tools codex login [name] [--home ~/.codex-work]   # browser login, written to the codex home's auth.json
tools codex usage [--json] [--range 24h]          # the shared usage dashboard pinned to this provider
```

`login` and `usage` are doors onto the provider-neutral account core: the same code runs behind `tools ai accounts login --provider codex` and `tools ai usage --provider codex`. `tools ai accounts discover --provider codex` lists every `~/.codex*` profile on the machine and `--bind` turns the unbound ones into accounts.

Sessions are read-only by default. For implementation work, use `--write ask` for supervised approvals or
`--write allow` for a trusted bounded worker. `--write deny` is explicitly read-only.

With `--write ask`, Codex uses its `untrusted` approval policy: commands outside Codex's built-in trusted read-only
set, sandbox escalations, and file-change approval requests pause and are forwarded to `lead` as `approval_request`
messages. Resolve one with `tools codex approve --name <n> --request <id>` or `deny`. Codex 0.144.5 has no protocol
mode that pauses its built-in trusted read-only commands; `untrusted` is its strictest supported command policy.

The driver joins the parent Claude Code swarm through `tools agents`. Use `--no-agents` to disable that integration,
or `--session <id>` when the parent session cannot be discovered from `CLAUDE_CODE_SESSION_ID`.
