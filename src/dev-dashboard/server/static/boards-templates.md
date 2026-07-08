# Board templates

Canonical compositions for the AI expression layer — compose-ready skeletons an
agent (or a human via the MCP tools) drops onto a board instead of inventing
structure each time. Every template is ONE `boards_compose_board` call
(batch-or-bust) plus at most one `boards_arrange {save:true}` for a
self-maintaining layout. All elements are data-only (~100–300 tokens each);
reference existing cards (`cardId`) — never re-upload a screen you can point at.

Vocabulary these templates draw on: `section` (journey frame, auto-indexed,
pill-navigable), `step`/`callout`/`checklist`/`compare` elements, `viz`
(`table|matrix|flow|bars|timeline|line|stat`), `cluster` (+ `role:"kanban"`),
auto-layout (`boards_arrange {scope:"section:…", mode, save:true}`).

---

## 1. QA session — one journey under test

One section per journey; steps reference the pasted/snapped screens; a
checklist tracks the sweep; callouts carry findings.

```json
boards_compose_board {
  "board": "<slug>",
  "cards": [
    {"ref":"s","kind":"section","payload":{"title":"Checkout"},
     "children":["st1","st2","cl","co"]},
    {"ref":"st1","kind":"step","payload":{"n":1,"title":"Open cart","status":"pass","cardId":<shotId>}},
    {"ref":"st2","kind":"step","payload":{"n":2,"title":"Pay","status":"fail","cardId":<shotId>,"note":"spinner never resolves"}},
    {"ref":"cl","kind":"checklist","payload":{"title":"Sweep","items":[
      {"text":"empty cart state"},{"text":"invalid card","done":true},{"text":"3DS redirect"}]}},
    {"ref":"co","kind":"callout","payload":{"tone":"warn","md":"Pay button stays enabled while the request is in flight"}}
  ]
}
```

Then: `boards_arrange {"board":"<slug>","scope":"section:Checkout","mode":"lanes","save":true}`
(steps carry `payload.lane` when testing per-device).

## 2. Iteration review — pass chains

Ship the rework as the journey's NEXT PASS (never mix takes): one compose call
opens the linked section — auto-named, beside the previous pass, layout
inherited — and fills it.

```json
boards_compose_board: {"board":"<slug>","journey":"checkout","pass":"next","cards":[…new shots/steps…]}
boards_arrange:       {"board":"<slug>","mode":"compare","sections":["Checkout","Checkout — pass 2"]}
boards_scrape_board:  {"board":"<slug>","diff":["Checkout","Checkout — pass 2"]}  → matched pairs, one line each
```

`boards_list_sections` → `journeys:[{journey,passes,latest}]` orients a fresh
session; `{"journey":"checkout"}` without pass composes into the LATEST pass.
Pixel-level: a `compare` card `{a:{cardId:v1},b:{cardId:v2},"mode":"wipe"}` per
screen pair that matters.

## 3. Decision map (brainstorm)

Heading + one idea card per decision (stakes in the md), wired in dependency
order, each with an anchored question; clusters per direction when the fork is
wide. One `boards_compose_board` call places the whole map.

## 4. Metrics / status dashboard

One auto-layout section of viz cards — data-only, no artifacts.

```json
boards_compose_board: {"board":"<slug>","section":"Metrics","cards":[
  {"kind":"viz","payload":{"viz":"stat","title":"today","data":{"items":[
    {"label":"p95","value":"118","unit":"ms","delta":"-8%"},
    {"label":"errors","value":"3","delta":"+1"},
    {"label":"tokens","value":"412k","delta":"-12%"}]}}},
  {"kind":"viz","payload":{"viz":"line","title":"tokens/day","data":{
    "series":[{"label":"in","points":[380,401,395,412]},{"label":"out","points":[90,84,88,79]}],
    "x":["mon","tue","wed","thu"]}}},
  {"kind":"viz","payload":{"viz":"bars","data":{"items":[{"label":"web","value":14},{"label":"api","value":9}]}}}
]}
boards_arrange: {"board":"<slug>","scope":"section:Metrics","mode":"grid","cols":2,"gap":"M","save":true}
```

## 5. Presentation deck — sections ARE the slides

Generate a deck as a series of sections in reading order. One slide = one
section: a heading text card + at most 2–3 supporting cards (stat/line viz,
callout, step, or a referenced shot). Keep slides sparse — it's a stage, not a
dashboard.

```json
boards_compose_board: {"board":"<slug>","cards":[
  {"ref":"s1","kind":"section","payload":{"title":"1 · Problem"},"children":["h1","c1"]},
  {"ref":"h1","kind":"text","payload":{"role":"heading","md":"## Checkout drop-off"}},
  {"ref":"c1","kind":"viz","payload":{"viz":"stat","data":{"items":[{"label":"drop-off","value":"38%","delta":"+6%"}]}}},
  {"ref":"s2","kind":"section","payload":{"title":"2 · Evidence"},"children":["st"]},
  {"ref":"st","kind":"step","payload":{"n":1,"title":"Pay fails on 3DS","status":"fail","cardId":<shotId>}},
  {"ref":"s3","kind":"section","payload":{"title":"3 · Proposal"},"children":["h3","co3"]},
  {"ref":"h3","kind":"text","payload":{"role":"heading","md":"## Inline 3DS + optimistic state"}},
  {"ref":"co3","kind":"callout","payload":{"tone":"decision","md":"Ship behind a flag; measure for a week"}}
]}
```

Per-slide layout: `boards_arrange {"board":"<slug>","scope":"section:1 · Problem","mode":"column","save":true}`
(or grid for denser slides).

## 6. Finding triage — kanban columns

Three kanban clusters; drag findings between them (purely visual v1).

```json
boards_compose_board: {"board":"<slug>","cards":[
  {"ref":"k1","kind":"cluster","payload":{"title":"Inbox","role":"kanban"},"children":[…]},
  {"ref":"k2","kind":"cluster","payload":{"title":"Doing","role":"kanban"}},
  {"ref":"k3","kind":"cluster","payload":{"title":"Done","role":"kanban"}}
]}
```

## 7. UI proposal — wireframe screens

Sketch proposed screens with `wireframe` cards (~100-250 tokens each) instead
of HTML artifacts; put 2-3 variants in one row and anchor a question.

```json
boards_compose_board: {"board":"<slug>","layout":"row","cards":[
  {"ref":"a","kind":"wireframe","payload":{"title":"Login A","device":"phone","nodes":[
    {"t":"nav","label":"‹ back"},{"t":"img","h":"m"},
    {"t":"input","label":"email"},{"t":"input","label":"password"},
    {"t":"button","label":"sign in","primary":true},{"t":"text","label":"forgot password?"}]}},
  {"ref":"b","kind":"wireframe","payload":{"title":"Login B","device":"phone","nodes":[
    {"t":"heading","label":"Welcome back"},{"t":"list","n":2},
    {"t":"divider"},{"t":"button","label":"continue with apple","primary":true},
    {"t":"tabbar","label":"home · search · profile"}]}}],
 "questions":[{"prompt":"Which login direction?","options":["A — classic","B — social-first"],"cardRef":"a"}]}
```

Escalate to a TW4 artifact only after a direction wins.

---

House rules that apply to every template: quiet-wire (no decorative boxes),
batch-or-bust, never send coordinates, viz > artifact unless it must be a live
HTML mockup, staged dispatch (the user's "Send to Claude" bar commits answers).
