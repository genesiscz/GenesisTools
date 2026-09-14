# Pending ask forms — consumer contract

GenesisTools owns the **blocking ask**: an agent posts a question and the user answers it.
This file is the wire contract for clients. It exists so the Genesis.app side can retarget
`QaSseClient` / `QaFormController` without reading GenesisTools internals.

Ported from Genesis Spec 02 (`Genesis/docs/QA.md`). Field names are unchanged, so existing
`QaModels.swift` Codable types decode a GenesisTools form as-is. The differences are listed
at the bottom.

State as of 2026-09-14 14:30.

## Where it lives

| Thing | Location |
|---|---|
| Store | `~/.genesis-tools/question/qa.db`, table `qa_pending` (same file as the Q→A read model) |
| Lifecycle events | `~/.genesis-tools/question/pending/<YYYY-MM-DD>.jsonl`, append-only |
| Answered Q→A | the normal question log, so `/qa` history stays one list |
| Server | the dev-dashboard (port from `src/utils/ui/dashboards.ts`, 3042 locally, `https://mac.foltyn.dev` publicly) |

Genesis' own `~/.genesis/genesis.db` `qa_pending` table is **not** used and is not read.

## HTTP

All paths are on the dev-dashboard, behind the same basic-auth gate as the rest of its API.

| Method | Path | Body | Success | Failure |
|---|---|---|---|---|
| POST | `/api/qa/pending` | `{ projectPath, items[], timeoutMs?, source?, sessionHint? }` | `201 { form }` | `400 { error }` when `items[]` is empty |
| GET | `/api/qa/pending` | — | `200 { forms: AskForm[] }` (pending only) | — |
| GET | `/api/qa/pending?ids=a,b` | — | `200 { forms: { [id]: AskForm \| null } }` | — |
| GET | `/api/qa/pending/:id` | — | `200 { form }` | `404 { error }` |
| DELETE | `/api/qa/pending/:id` | — | `200 { form }` (status `cancelled`) | `404` if unknown or already resolved |
| POST | `/api/qa/pending/:id/answer` | `{ answers: AskAnswer[] }` | `200 { ok: true, form, entryId }` | `400 { ok:false, code:"incomplete", missing:[itemId] }`, `404 { ok:false, code:"not_found"\|"not_pending" }` |
| POST | `/api/qa/pending/:id/wait` | `{ timeoutMs? }` (default 120000) | `200 { form, waiter }` | `404 { error }` |
| GET | `/api/qa/stream` | — | SSE, see below | — |

`entryId` on a successful answer is the id of the Q→A history entry that was written. Use it
to deep-link to the answered question after the form is gone: `/qa?id=<entryId>`.

Path builders are in `src/dev-dashboard/contract/endpoints.ts` (`paths.qaPending`,
`paths.qaPendingOne`, `paths.qaPendingAnswer`, `paths.qaPendingWait`).

## SSE

One multiplexed stream, `GET /api/qa/stream`. Every message is a `data:` line holding JSON
with a `type` discriminator. Ignore types you do not handle; more will be added.

| `type` | Meaning |
|---|---|
| `qa` | a Q→A history entry was logged |
| `handoff` | a handoff event |
| `pending` | an ask-form lifecycle event |

A `pending` frame:

```json
{
  "type": "pending",
  "ev": "created" | "answered" | "cancelled" | "timeout",
  "id": "ask_5f1c…",
  "ts": 1789390571437,
  "form": { "…": "the full AskForm" }
}
```

**On connect the server replays one `created` frame per form that is still pending**, so a
client that attaches while questions are already waiting renders them without a reload. Treat
`created` as upsert-by-id, not as "this is new".

A frame whose `form.status` is not `pending` means: remove it from your pending list. The
answered content reappears as a `qa` frame.

Keep-alive comments (`: ping`) arrive every 12s.

## Types

```ts
type AskFormStatus = "pending" | "answered" | "timeout" | "cancelled";
type WaiterStatus  = "answered" | "timeout" | "cancelled" | "budget_exhausted" | "not_found";

interface AskChoice { id: string; label: string }

interface AskItem {
    id: string;                  // q1, q2, … when the poster omits it
    promptMarkdown: string;
    choices?: AskChoice[];       // plain strings are normalized to id+label on POST
    allowMultiple?: boolean;     // default false
    allowFreeText?: boolean;     // default true
    allowFileTags?: boolean;     // default false
    allowImagePaste?: boolean;   // default false
    required?: boolean;          // default true
}

interface AskImage { name: string; mime: string; base64: string }   // no data: prefix

interface AskAnswer {
    itemId: string;
    freeText?: string;
    selectedChoices?: string[];
    fileTags?: string[];
    images?: AskImage[];
}

interface AskForm {
    id: string;                  // "ask_<uuid>"
    createdAt: number;           // epoch ms
    source?: string;
    sessionHint?: string;        // the agent's session id; drives the card's session actions
    projectPath: string;
    cwd: string;                 // nearest git root above projectPath, else projectPath
    items: AskItem[];
    status: AskFormStatus;
    answers?: Record<string, AskAnswer>;   // keyed by itemId
    timeoutMs?: number;
    resolvedAt?: number;
    entryId?: string;            // the Q→A history entry written on answer
}
```

Source of truth: `src/question/lib/pending/types.ts`.

## Semantics a client must not get wrong

- **`waiter` is not `status`.** `budget_exhausted` means *your* wait ran out while the form is
  still pending. The form is alive; wait again. Only `form.timeoutMs` retires a form, and that
  reports `timeout`.
- **Blocking is opt-in.** `POST /api/qa/pending` never blocks. Block with `/wait` only when you
  genuinely cannot continue, because blocking by default hangs agent loops.
- **Answering is single-shot.** The second submit gets `404 not_pending`; it cannot overwrite a
  recorded answer.
- **The server drops what the item did not offer.** Choices outside `item.choices`, `@file`
  tags when `allowFileTags` is false, images when `allowImagePaste` is false. Do not rely on
  client-side validation alone, and do not treat the echo as a rejection.
- **`@file` tags are relative to `form.cwd`**, never absolute, no `..` segment, and the walk
  that resolves `cwd` stops at `$HOME`.
- **Timeouts are evaluated lazily on read.** There is no daemon. A form that passed its
  `timeoutMs` flips on the next read and emits its `timeout` event then.
- **Answering writes a Q→A history entry.** That is deliberate: `/qa` shows one list, not two.

## Limits

| Limit | Value |
|---|---|
| free text | 16 000 chars per item |
| images | 4 per answer, ~2 000 000 base64 chars each, `image/*` only |
| `@file` tags | 20 per answer |
| default wait budget | 120 000 ms |

## The same surface from the CLI and MCP

One core (`src/question/lib/pending/ask.ts`) behind three doors. Anything an HTTP client can
do, the CLI and the MCP server can do too.

| Verb | CLI | MCP tool |
|---|---|---|
| create | `tools question ask` (alias `post`) | `question_post` |
| block | `tools question ask --wait`, `tools question wait <id>` | `question_wait` |
| poll | `tools question poll [ids…]` | `question_poll` |
| answer | `tools question answer <id>` | `question_respond` |
| cancel | `tools question cancel <id>` | `question_cancel` |

The MCP answer verb is `question_respond`, not `question_answer_form`: `question_answer` is a
different tool that LOGS a question you already answered yourself, and the MCP capability
filter matches by name prefix, so an overlapping name would drag one capability into the other.

CLI exit codes on a wait: `0` answered, `1` not_found, `2` timeout, `3` cancelled, `4` budget_exhausted.

## Differences from the Genesis implementation

| Genesis | GenesisTools | Why |
|---|---|---|
| `imageRefs` on `AskAnswer` (deprecated) | dropped | nothing produced it; `images` covers the case |
| form id `ask_<base36>_<rand>` | `ask_<uuid>` | collision-free without a clock assumption |
| in-process waiter registry | waiter polls the row every 250ms | the waiting agent and the answering dashboard are separate processes, so an in-memory emitter would only ever see its own writes |
| form auto-timeout on a server timer | evaluated lazily on read | no daemon; matches how the Q→A read model catches up |
| `qa.gtLogUrl` bridge, off by default | always writes the Q→A entry | the two systems are one system now, so there is nothing to bridge |
| `AskForm` has no `entryId` | `entryId` added | lets a deep link survive the form being answered |
