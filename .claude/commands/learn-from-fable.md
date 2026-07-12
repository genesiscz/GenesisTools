---
description: Distill Fable 5's working style from local session transcripts into the "Fable Pack" (spec + golden traces + skill) so weaker models can imitate its procedure
argument-hint: [max-sessions] [--archive-only | --repack]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent
---

# /learn-from-fable — bottle Fable 5's working style

Incrementally mine local Claude Code transcripts of `claude-fable-5` sessions and distill them into the **Fable Pack**, so weaker models (Sonnet/Opus/Haiku) inherit Fable's *procedure*: how it plans, sequences commands, verifies before claiming done, reports outcomes, and recovers from errors.

Research & rationale behind this design: `/Users/Martin/Tresors/Projects/GenesisBrain/Claude/Fable/2026-07-08-PreserveFable5Style.md`

**Arguments** (`$ARGUMENTS`): first numeric token = max sessions to mine this run (call it **MAX**; default **3**). `--archive-only` = run Stages 0–1 only. `--repack` = skip mining, regenerate the skill from the existing spec (Stages 0 + 5 + 6 only).

**Paths** — use these exact values everywhere a snippet says `$FABLE` / `$PACK` / `$STYLE`:

```bash
FABLE="$HOME/.genesis-tools/claude/fable"   # everything lives here (own git repo)
SESSIONS="$FABLE/sessions"                  # transcript mirror (gitignored)
PACK="$FABLE/pack"                          # spec + golden traces + changelog (git-versioned)
STYLE="$FABLE/skills/fable-style"           # canonical SKILL.md (git-versioned; synced to ~/.claude/skills/fable-style/)
```

## Ground rules (read fully before acting)

- **Procedure transfers, capability doesn't.** Never claim the pack makes a model "as good as Fable".
- **Principles + rationale, not MUST-lists.** Over-prescription degrades models and goes stale. Every captured rule must carry its *why*.
- **Separate REASON from ACT** in every exemplar: the judgment block, then the command/edit block.
- **Originals are read-only.** Never modify or delete anything under `~/.claude/projects/`. Never edit or prune `$SESSIONS` either — only add.
- **Protect main context.** Raw transcripts are megabytes. Only subagents read them, and only pre-filtered. If you catch yourself Reading a `.jsonl` transcript in the main session, stop and delegate.
- **Don't improvise the pipeline.** Run the snippets as written (substituting MAX and placeholders). If a snippet fails, read its stderr, fix the one thing that broke, and note the deviation in your final report — do not invent a different pipeline.
- Mining quality depends on the running model's judgment; prefer running this on the strongest model available.

## Stage 0 — Bootstrap (always; idempotent)

```bash
FABLE="$HOME/.genesis-tools/claude/fable"
mkdir -p "$FABLE/sessions" "$FABLE/pack" "$FABLE/skills/fable-style" "$HOME/.claude/skills/fable-style"
touch "$FABLE/processed.jsonl"
[ -d "$FABLE/.git" ] || git -C "$FABLE" init -q
grep -qxF 'sessions/' "$FABLE/.gitignore" 2>/dev/null || echo 'sessions/' >> "$FABLE/.gitignore"
ls "$FABLE"
```

`$FABLE/README.md` is versioned in the fable repo — do not modify or regenerate it.

If `$PACK/FABLE-SPEC.md` does not exist, Write it with a `# Fable Operating Spec` title, one line of purpose, and these six empty section headings: `## Planning & scoping`, `## Command style & sequencing`, `## Verification before done`, `## Communication & reporting`, `## Error recovery`, `## Judgment calls (when to ask vs proceed)`.

## Stage 1 — Archive (always; incremental, never overwrites)

```bash
FABLE="$HOME/.genesis-tools/claude/fable"
before=$(find "$FABLE/sessions" -name '*.jsonl' | wc -l | tr -d ' ')
rg -l --no-messages -F '"model":"claude-fable-5"' "$HOME/.claude/projects/" --glob '*.jsonl' \
| while read -r f; do
    rel="${f#$HOME/.claude/projects/}"
    mkdir -p "$FABLE/sessions/$(dirname "$rel")"
    cp -cn "$f" "$FABLE/sessions/$rel" 2>/dev/null || cp -n "$f" "$FABLE/sessions/$rel" 2>/dev/null || true
  done
after=$(find "$FABLE/sessions" -name '*.jsonl' | wc -l | tr -d ' ')
echo "archived: $after total, $((after - before)) new"
```

Report both numbers. If `--archive-only`, stop here.

## Stage 2 — Select sessions to mine

```bash
FABLE="$HOME/.genesis-tools/claude/fable"
MAX="$(echo "$ARGUMENTS" | grep -oE '[0-9]+' | head -1)"; MAX="${MAX:-3}"
find "$FABLE/sessions" -name '*.jsonl' -print0 | xargs -0 ls -t \
| while read -r f; do grep -qF "\"$f\"" "$FABLE/processed.jsonl" || echo "$f"; done \
  > /tmp/fable-unmined.txt
grep -cv '^$' /tmp/fable-unmined.txt
grep -v '/subagents/' /tmp/fable-unmined.txt | head -n "$MAX"
```

Take that final list (main sessions, newest first). If it's empty but `/tmp/fable-unmined.txt` isn't, take `head -n "$MAX" /tmp/fable-unmined.txt` instead (subagent transcripts — execution-heavy but still useful). If nothing is unmined at all: report that and stop (unless `--repack`, then go to Stage 5).

## Stage 3 — Extract per session (subagents only)

For each selected file, spawn one Agent (up to 4 in parallel). Number them 1..N. Pass each agent the following brief **verbatim**, replacing `<FILE>` with the absolute path and `<N>` with its number:

> You are mining ONE Claude Code transcript for behavioral style. Never quote raw JSONL back; return distilled findings only.
> Step 1 — pre-filter:
>
> ```bash
> jq -r 'select(.type=="assistant" and ((.message.model // "") | test("fable")))
>   | .message.content[]? | objects
>   | if .type=="thinking" then "== THINKING ==\n" + ((.thinking // "")[0:2000])
>     elif .type=="tool_use" then "== TOOL " + (.name // "?") + " ==\n" + ((.input | tojson)[0:600])
>     elif .type=="text" then "== TEXT ==\n" + ((.text // "")[0:800])
>     else empty end' <FILE> > /tmp/fable-mine-<N>.txt 2>/tmp/fable-mine-<N>.err
> wc -c < /tmp/fable-mine-<N>.txt; head -c 300 /tmp/fable-mine-<N>.err
> ```
>
> Step 2 — if the output is empty or jq errored: run `head -c 1500 <FILE>` once to see the real field names, adapt the jq filter once, and retry. If it is still empty, reply with exactly `MINING FAILED: <one-line reason>` and stop.
> Step 3 — if the filtered file exceeds ~400 KB, do NOT read it all: sample the first ~100 KB, a middle ~100 KB, and the last ~100 KB (style is stationary across a session). Otherwise Read it fully.
> Step 4 — return, as markdown, capped at ~150 lines total:
> 1. **Principles observed** (3–8): each as `principle — why Fable does it, grounded in what you saw`. Only patterns that repeat or clearly reflect judgment; skip task-specific trivia.
> 2. **Golden-trace candidates** (0–2): short episodes worth imitating, each written as `[REASON] <the thinking, compressed>` / `[ACT] <the command or edit sequence>` / `[OUTCOME] <what happened>`. Prefer episodes showing planning, disciplined command sequencing, verification-before-done, or error recovery.
> 3. **Command idioms** (0–5): recurring shell/tool habits (how it scopes searches, tees logs, checks exits, sizes timeouts).
> 4. **Session summary**: one line on what the session was about.

## Stage 4 — Merge into the pack (main session)

Do this once per successfully mined session; skip (and report) any `MINING FAILED` ones.

1. Read `$PACK/FABLE-SPEC.md`. For each incoming principle: if an existing entry says roughly the same thing, **strengthen that entry** (add the new nuance or evidence) instead of adding a near-duplicate. Only add a new bullet when it's genuinely new. Reject one-off project trivia and model-version quirks. When unsure, strengthen rather than add.
2. Golden traces: keep `$PACK/golden-traces.md` at **≤15 episodes**. A new candidate only enters by replacing a weaker one (weaker = less generalizable, or duplicates a skill already demonstrated). Keep the `[REASON]/[ACT]/[OUTCOME]` shape.
3. Append one entry to `$PACK/changelog.md`: date, files mined, principles added/strengthened, traces swapped.
4. Append one line per mined session to the manifest — only AFTER its merge is done:

```bash
jq -cn --arg file "<FILE>" --arg minedAt "$(date +%F)" --arg notes "<one-line session summary>" \
  '{file: $file, minedAt: $minedAt, notes: $notes}' \
  >> "$HOME/.genesis-tools/claude/fable/processed.jsonl"
```

## Stage 5 — Regenerate the skill

Rewrite `$STYLE/SKILL.md` **from the spec** (the spec is the single source of truth; never hand-edit the skill separately). Frontmatter, exactly:

```yaml
---
name: fable-style
description: Work the way Fable 5 works - plan, execute, verify, then report outcome-first. Load when running on Sonnet/Opus/Haiku for nontrivial engineering tasks.
---
```

Body ≤150 lines: the strongest principles per spec section (each with its one-line why), the 3–5 best golden traces, and the command idioms. Principle-shaped prose, not MUST-lists.

Then sync the runtime copy (Claude Code loads skills from `~/.claude/skills/`; the fable-repo copy is the canonical original). The planner-side `plan-it` skill is distributed via the genesis-tools plugin, not managed here.

```bash
FABLE="$HOME/.genesis-tools/claude/fable"
cp -f "$FABLE/skills/fable-style/SKILL.md" "$HOME/.claude/skills/fable-style/SKILL.md"
diff -q "$FABLE/skills/fable-style/SKILL.md" "$HOME/.claude/skills/fable-style/SKILL.md" && echo "skill synced OK"
```

## Stage 6 — Commit the pack (traceability)

`$FABLE` is its own dedicated git repo (`sessions/` is gitignored), so committing everything is safe here — but never push anywhere:

```bash
FABLE="$HOME/.genesis-tools/claude/fable"
git -C "$FABLE" add -A
git -C "$FABLE" commit -m "fable-pack: mine <N> sessions ($(date +%F))" || echo "nothing to commit"
git -C "$FABLE" log --oneline -1
```

(Replace `<N>` with the number of sessions mined, or use `repack` for `--repack` runs. Include the commit hash in the report.)

## Stage 7 — Report

End with: sessions mined and what they taught (2–4 bullets); spec sections touched; golden-trace count; archive totals from Stage 1; the pack commit hash from Stage 6 and skill-sync status from Stage 5; any `MINING FAILED` files or pipeline deviations; and the reminder that the pack is **unmeasured** until an A/B eval (Sonnet-bare vs Sonnet+`fable-style` vs archived Fable reference) has been run — propose that once ≥ ~20 sessions are mined and the spec stabilizes.
