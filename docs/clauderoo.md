# Clauderoo

CLI contracts for the Genesis.app usage monitor (playground `feat/clauderoo`).

This branch will add:

- `tools claude usage --json --scored`
- `tools claude usage sessions --json`

Import existing `@app/claude` modules. Do not copy ranking or cache-TTL math.
The Swift app calls these CLIs. It does not reimplement Anthropic OAuth.
