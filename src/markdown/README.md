# tools markdown

Work on markdown files. The first verb resolves `{{kind …}}` tokens into excerpts that live inside
the file and can be refreshed.

```bash
tools markdown resolve Note.md                    # bare tokens → include blocks; existing blocks refreshed
tools markdown resolve Note.md --new-only         # only the bare tokens
tools markdown resolve Note.md --convert-links    # first, a {{lines}} token under every link to source lines
tools markdown resolve Note.md --dry-run          # proposal + patch in the run folder; the file untouched
tools markdown tokens                             # every kind, and the ones a note may not carry
```

A resolved token:

```
<!-- md:include sig=<content hash> {{lines path="src/a.ts" range="5-15"}} -->
…the excerpt and its footer…
<!-- /md:include -->
```

Every changed file is backed up to `/tmp/GenesisTools/transclude/<YYYY-MM-DD_HH-MM-SS>-<pid>/` with a
`.patch` and a `manifest.jsonl` line; the command prints the restore command and the day log gets the
same record. A run refuses to write when collapsing the blocks back to their tokens does not give the
input back.

The logic is `@genesiscz/utils/markdown/includes` (`resolveIncludes`, `collapseIncludes`,
`codeLinksToTokens`); `tools json2md build` resolves tokens in generated documents with it. The
plugin skill `gt:markdown` has the full rules.
