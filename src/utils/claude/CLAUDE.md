# Claude Agent SDK Types Reference

The session/message types in `src/utils/claude/` are aligned with `@anthropic-ai/claude-agent-sdk`. To check for upstream changes:

```bash
# Check latest version
npm view @anthropic-ai/claude-agent-sdk version

# Diff types between versions (no install needed)
npm diff \
  --diff=@anthropic-ai/claude-agent-sdk@<old> \
  --diff=@anthropic-ai/claude-agent-sdk@<new> \
  '**/*.d.ts'

# Read full current types (extracts ~270KB of .d.ts, no node_modules)
cd /tmp && npm pack @anthropic-ai/claude-agent-sdk && \
  mkdir -p sdk-types && \
  tar xzf anthropic-ai-claude-agent-sdk-*.tgz -C sdk-types --strip-components=1 '*.d.ts'
# Then read: /tmp/sdk-types/sdk.d.ts and /tmp/sdk-types/sdk-tools.d.ts
```

Key SDK type files: `sdk.d.ts` (session/message/streaming types), `sdk-tools.d.ts` (tool I/O schemas).

**Known gaps vs SDK** (as of v0.2.81):

| SDK Feature | Status |
|-------------|--------|
| `FileReadOutput` (image base64+dimensions, PDF, notebook) | Not tracked (tool output type, not message type) |
