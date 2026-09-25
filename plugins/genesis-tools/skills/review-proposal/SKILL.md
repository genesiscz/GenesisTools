---
name: gt:review-proposal
description: Review a GitHub PR or GitLab MR and push the result into the GenesisTools.app review window as a proposal (verdict, draft comments anchored to lines, and the agent's analysis stuck to each draft). Use when asked to "review PR/MR N", "give a review", "draft review comments", "push the review to the hub", or when a review skill says to push a proposal. Only when `tools hub status` exits 0; otherwise present the review in chat as usual.
---

# review-proposal

A proposal is the agent's review of one PR/MR, shown on the code in the GenesisTools.app review
window. Martin reads each draft next to its lines, accepts, edits or rejects it, and only then
promotes it to a real review draft or posts it. **You never post anything yourself.**

## 1. Gate (always first)

```bash
tools hub status --json
```

Exit 1 means the window is not installed: skip this skill and present the review in chat the way
the calling skill describes. Exit 0 means continue.

## 2. Gather facts

- GitLab: `tools gitlab pr review <iid> --repo <checkout> --proposal-skeleton > /tmp/review-<iid>.json`
  writes the proposal with provider, host, project, number, branches, `baseSha`, `headSha`, `repoPath`
  and every existing thread already filled (a resolved one with `resolved: true`); you add `author.agent`,
  the verdict and the drafts.
  The same run saves the facts (`<tmp>/gitlab-pr-<project>-<key>-<iid>.json`, path on stderr; JSON by default on stdout
  without the flag) and the numbered report (`.md`, or `--md` on stdout): diff hunks with new-side
  line numbers, the file checklist, existing threads, your pending drafts, other open MRs this one
  breaks or overlaps, and the configured gates. `--llm` is a compact view; `--expand f3,t1` prints
  one file or thread in full. `tools gitlab fetch-review <iid> --md` shows existing threads with
  the code at their anchor.
- GitHub: `tools github review <pr> --llm` for existing threads; `tools github pr <pr>` for details.
  A GitHub thread's `threadId` is its review-thread node id (`PRRT_…`, the `threadId` field of
  `tools github review <pr> --json`): the window replies with `tools github review comment --thread`.
- Read the changed code at the PR's head commit, not your working tree. Note `baseSha` and `headSha`.
- A local checkout must contain both commits (`git fetch origin <source-branch>`); put its path in `repoPath`.

## 3. Write the proposal JSON

```json
{
  "provider": "gitlab",
  "host": "gitlab.example.com",
  "project": "group/app",
  "number": 42,
  "title": "MR title",
  "url": "https://…",
  "sourceBranch": "feat/x",
  "targetBranch": "main",
  "baseSha": "<merge-base or target sha>",
  "headSha": "<source head sha>",
  "repoPath": "/abs/path/to/checkout",
  "author": { "agent": "claude", "sessionId": "<your session id>", "model": "<model>" },
  "verdict": { "decision": "request_changes", "summary": "Two blockers, one question.", "confidence": 80, "proof": "…" },
  "drafts": [
    {
      "id": "d1",
      "path": "src/a.ts",
      "side": "additions",
      "startLine": 40,
      "line": 44,
      "severity": "blocker",
      "body": "The comment exactly as it would be posted (markdown).",
      "meta": {
        "verdict": "One line: what is wrong here",
        "proof": "A checkable fact: file:line, a test result, a spec quote",
        "confidence": 85,
        "reasoning": "Optional: the longer why"
      },
      "replyToThread": "<existing thread id, only when replying instead of opening a new thread>"
    }
  ],
  "threads": [
    {
      "threadId": "<existing discussion id>",
      "path": "src/file.ts", "line": 42,
      "author": "reviewer-handle", "body": "The thread's first note.", "noteCount": 2, "resolved": false,
      "verdict": "already-fixed", "proof": "…", "suggestedReply": "…"
    }
  ],
  "notes": "Anything that does not belong on a line."
}
```

Rules:
- `line` / `startLine` are line numbers of the file **at `headSha`** for `side: "additions"`, or at
  `baseSha` for `"deletions"`. A draft whose path is not in `baseSha..headSha` shows as "not in this diff".
- Every draft has `meta.verdict`; give `proof` for anything that is not a nit. No proof, no blocker.
- `severity`: `blocker` · `major` · `minor` · `nit` · `question` · `praise`.
- `decision`: `approve` · `request_changes` · `comment`.
- `body` is written for the PR author. `meta` is written for Martin. Do not repeat one in the other.
- Do not set `status`: the window owns it (proposed → accepted / edited / rejected → sent / drafted → posted).
- Carry **every** existing thread over with its own facts (`path`, `line`, `author`, `body`, `noteCount`,
  `resolved`; GitLab: the skeleton's `threads`, or the JSON of `tools gitlab fetch-review <iid>`). The window shows
  them on their lines. Add `verdict` + `proof` only for a thread
  you actually checked at `headSha`; add `suggestedReply` when a reply is worth sending.
- The window turns each draft and each suggested reply into an editable suggestion with three
  sends: **For agent** (outbox + cmux), **Draft on PR** (`tools gitlab draft-reply`, a pending review
  draft) and **Post on PR** (`--now`, asks first). Write `body` and `suggestedReply` so they can go
  out as they are; Martin rewords them in the window when he wants to.

## 4. Push

```bash
tools hub proposal push /tmp/review-<n>.json --open
```

Pushing again for the same PR is safe: drafts Martin already accepted, edited or rejected keep his
decision (matched by `id`, so keep ids stable between pushes). `tools hub proposal show <key>`
prints the proposal as markdown (json2md) for the chat.

The window does the provider writes itself, through `tools hub pr … --json` on the checkout's branch
(GitHub and GitLab alike): `threads` shows existing threads inline, `draft add|update|delete` turns
a proposal draft into a pending review comment (the returned `draftId` is its `providerId`),
`reply` and `resolve` answer threads, `comment` posts one new line comment at once, and `publish`
sends every pending draft as one review. 🛑 An agent never runs `publish` or `comment`: both are
Martin's click, because both are visible to everyone the moment they run.

## 5. Report in chat

One short paragraph: the verdict, the number of drafts by severity, and that they are waiting in
the review window. Do not paste every draft again.
