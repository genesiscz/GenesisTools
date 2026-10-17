# Claude Code MCP disable evidence

This records the local investigation of **Claude Code 2.1.296** on 2026-10-13,
not a claim about every future version. The full local research note was titled
`2026-10-13-ClaudeCodeGlobalMcpSwitch.md`; this maintained repository excerpt
keeps the evidence used by mcp-manager's provider contract.

The investigator extracted the native binary's embedded JavaScript. The
exported `isMcpServerDisabled` function was named `Ao` in that build:

```js
function Ao(e) {
    let n = Xi();
    if (mge(e)) return !yge(n.enabledMcpServers).includes(e);
    return yge(n.disabledMcpServers).includes(e);
}
```

`Xi()` selected `config.projects[currentProjectPath]`, falling back to the
empty project configuration. The five occurrences of `disabledMcpServers` in
the extracted bundle were project reads/writes or prompt text. None read the
top-level field. The MCP toggle wrote the same project entry. The policy
check separately rejected `deniedMcpServers` from merged settings before
checking any allow entry.

The investigation also used scratch `CLAUDE_CONFIG_DIR` directories. Server
names below use an invented fixture label:

| Configuration | Observed behavior |
| --- | --- |
| Top-level `disabledMcpServers: ["fixture-server"]` | Server remained enabled |
| Current project's `disabledMcpServers: ["fixture-server"]` | Disabled only in that project |
| User settings `deniedMcpServers: [{"serverName":"fixture-server"}]` | Server absent in registered and unregistered projects |
| Same deny plus a project allow entry | Still denied; enabling reported managed-policy blocking |

To recheck after an upgrade, use fresh temporary configuration directories and
an inert local stdio MCP fixture. Run `claude mcp list` in two fresh project
directories for each row, setting `CLAUDE_CONFIG_DIR` for every call. Do not use
a real account or the user's configuration. Record the binary version and
observed output here if behavior changes.

The provider removes a globally disabled server from generated `mcpServers`,
retaining its definition in unified configuration. The top-level disabled list
is mcp-manager's marker. `commands/__tests__/claude-global-disable.test.ts`
verifies those writes; it does not validate an installed Claude Code binary.
