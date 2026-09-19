# Probably Lang (lab port)

This directory ports the Probably 0.1 parser and interpreter from Steve Faulkner's
experimental language (downloaded 2026-09-19 from
`https://probably-lang.southpolesteve.workers.dev/probably-source.zip`).

Upstream demo: https://probably-lang.southpolesteve.workers.dev/
Announcement: https://x.com/southpolesteve/status/2100767781868150938

Adaptations in GenesisTools:

- Provider wiring uses `tools jev` / TypeSafe for judgments and `ai.chat` for `llm`/`write`
- Named program storage under `~/.genesis-tools/jev/probably/`
- CLI as `tools jev evaluation …` (fun lab, not a production language runtime)
- GT formatting, logging, and profiler scopes

Bundled `.prob` examples and `examples/corpus.json` are from the same upstream package.
The original author has not endorsed this lab.
