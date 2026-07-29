# Adding an AI provider, or a local model

Two recipes. Both are deliberately one-folder / one-entry changes: after the
2026-07 rearchitecture, nothing about a new provider should require editing call
sites scattered across tools.

Read the layer summary in the root `CLAUDE.md` ("AI subsystem") first. The rule
that makes these recipes work is that layers import only DOWNWARD: security,
then config, then providers, then catalog, then core, then tasks.

---

## Recipe 1: add a cloud provider

Worked example: `src/utils/ai/providers/plugins/huggingface.ts`, which is small
enough to read in one sitting and shows every required part.

### Step 1. Write the plugin

One file under `src/utils/ai/providers/plugins/`. It exports a `ProviderPlugin`:

```ts
export const myProviderPlugin: ProviderPlugin = {
    id: "myprovider",              // matches AccountEntry.provider
    kind: "api-key",               // api-key | subscription | local | gateway
    capabilities: new Set(["chat"]),
    credential: {
        fields: ["apiKey"],
        envKeys: ["MYPROVIDER_API_KEY"],   // DECLARED fallback, see step 2
        required: ["apiKey"],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const { apiKey } = await resolveCredential(ctx.account, this.credential);

        if (!apiKey) {
            throw new Error("No API key resolved for myprovider");
        }

        return {
            accountId: ctx.account.id,
            providerId: "myprovider",
            billed: true,
            language: (modelId: string) => /* an ai-sdk LanguageModel */,
        };
    },
};
```

Rules that are not optional:

- **`resolveCredential` is the only way to get a key.** Never read
  `process.env` and never construct an SDK client with no arguments.
  `scripts/ci/ai-credentials-guard.sh` fails the build on both.
- **Declare env fallbacks in `credential.envKeys`.** Listing them is what makes
  an ambient variable legal; an undeclared one is rejected with a message naming
  the fix command. List them in the same order the env facade reads them.
- **`capabilities` is what the code ACTUALLY routes here**, not what the vendor
  sells. A capability you declare but do not implement becomes a runtime error
  for a user who followed your own advertisement.
- **A capability you do not support should throw a useful error, not return
  undefined.** The huggingface plugin's `language()` throws with the exact
  `tools ai config default set` command that fixes it.
- **Return `dispose?()` if you hold a handle.** Task facades call it. Local
  runtimes leak native memory without it.
- **On-demand packages import at call time** (`await import(...)` inside the
  method), so a missing optional dependency is a runtime error naming the
  install rather than an import-time crash for every tool that loads the barrel.

🛑 **`bind()` and `health()` must honour `ctx.probe`.** A diagnostic caller
(`tools ai config doctor`, `account test`, the TUI's Test action) sets it. Under
`probe`, no path may spend a single-use refresh token, mint a cached session, or
migrate/delete a credential file. Put the guard immediately ABOVE the consuming
call in the shared auth function, never at the caller. See the CLAUDE.md section
"Side Effects: Diagnostics & Irreversible Operations".

### Step 2. Register it

`src/utils/ai/providers/plugins.ts`: import it and add one `registerPlugin(...)`
line. That is the whole wiring.

### Step 3. Give the catalog something to list

Add entries to `src/utils/ai/catalog/static.ts` so pickers and pricing know your
models. Provider-scoped ids matter: `byId(id, provider)` is scoped because one
id can name two products at different prices. If the vendor publishes a live
model list, a `discover()` path can overlay it (see
`src/utils/ai/catalog/discover.ts` for the OpenRouter one), but static entries
are what make the provider usable offline.

### Step 4. Verify

```bash
bun run test src/utils/ai/providers src/utils/ai/catalog
bash scripts/ci/ai-credentials-guard.sh
GENESIS_TOOLS_HOME=$(mktemp -d) tools ai config account add   # then pick your provider
GENESIS_TOOLS_HOME=$(mktemp -d) tools ai config doctor
```

Always point `GENESIS_TOOLS_HOME` at a temp dir for smokes. Writing the real
`~/.genesis-tools` from a test or a scratch run is how a stray master key and a
polluted history DB both happened.

---

## Recipe 2: add a local model

The local stack is descriptor-driven: a model is DATA, and the runtime that
executes it already exists.

### Step 1. Add a descriptor

Append to `src/utils/ai/local/descriptors/models.ts` a `LocalModelDescriptor`
(shape in `descriptors/types.ts`):

```ts
{
    id: "onnx-community/whisper-large-v3-turbo",   // the hub repo id
    name: "whisper-large-v3-turbo",                 // what a user types
    task: "transcribe",
    params: "809M",
    ramGB: 2.0,
    speed: "medium",
    license: "MIT",
    provider: "local-hf",
    description: "Best multilingual speed/quality, ~1.5GB (fp16 enc + q4 dec).",
    runtime: "transformers-js",
    artifacts: [{ source: "hf", locator: "onnx-community/whisper-large-v3-turbo" }],
}
```

- `runtime` is one of `transformers-js | coreml | sherpa | darwinkit | ollama`.
  Absent means hosted (no weights of ours to fetch).
- `artifacts` is empty when the weights are not ours to manage (a hosted API, an
  OS built-in, or the ollama daemon).
- `hf` artifacts leave `file` unset, because transformers.js owns its cache
  layout. `url` artifacts MUST set `file`: nothing else can derive the path.
- `ramGB` and `speed` are what the picker sorts and warns on. Guessing them
  produces a model that gets recommended onto a machine that cannot run it.

### Step 2. Only if the runtime is new

Add a folder under `src/utils/ai/local/runtimes/` and an adapter exposing it as
an L2 plugin. Most additions do NOT need this: if it runs on transformers.js or
sherpa, step 1 was the whole job.

### Step 3. Verify

```bash
bun run test src/utils/ai/local
RUN_LOCAL_MODELS=1 bun run test src/utils/ai/local    # gated; needs artifacts on disk
tools ai models list --local
```

The `RUN_LOCAL_MODELS` gate is off by default because those tests download
weights. A green default run says nothing about whether your model actually
loads, so run the gated pass at least once before claiming it works.
