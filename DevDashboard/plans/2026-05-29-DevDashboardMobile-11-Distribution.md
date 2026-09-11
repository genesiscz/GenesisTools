# 11 — Distribution & Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Read
> `…-00-Overview.md` and `…-ADR.md` first, then `…-01-ServerExtraction.md` (the Agent CLI you will
> package) and `…-04-MobileFoundation.md` (the Expo project this plan builds). Work in the
> `feat/dev-dashboard-mobile` worktree. **Search docs on demand** before any EAS/expo-updates step —
> query `context7` (`/expo/eas-cli`, `/websites/expo_dev_versions_v55_0_0`), the local `expo:*`
> skills (`expo:expo-deployment`, `expo:expo-dev-client`, `expo:eas-update-insights`), and web search
> (Jina/Brave). Versions move; never code a native/EAS integration from memory.

**Goal:** Ship the **DevDashboard Mobile** Expo SDK 55 app to TestFlight + Play internal testing and
the stores via EAS (a `development` dev-client carrying the native deps, plus `preview`/`production`
profiles), carry the `react-native-webview` #3880 native diff with `patch-package`, run OTA via
`expo-updates` channels, and give a customer a **one-line installer + cloudflared wizard + launchd
autostart** to run the **DevDashboard Agent** — all gated by a release-readiness checklist and a
smoke Appium run against the installed dev-client.

**Architecture:** Two distribution surfaces. (1) **Mobile** is an EAS project: `eas.json` defines
`development` (internal, `developmentClient: true`, simulator + device variants), `preview`
(internal `.apk`/ad-hoc `.ipa` for TestFlight-style sharing), and `production` (store binaries);
native deps (`react-native-webview`+`@react-native-cookies/cookies`, `@shopify/react-native-skia`,
`expo-sqlite`, `react-native-zeroconf`) force `runtimeVersion.policy = "fingerprint"` so OTA never
ships JS that mismatches the native ABI; `patch-package` re-applies the #3880 diff on every
`bun install` via a `postinstall` hook so the iOS New-Arch `source`-prop bug stays fixed in every EAS
build. (2) **Agent** ships as a `tools dev-dashboard` subtree the customer installs with a `curl | sh`
bootstrap that installs Bun + GenesisTools, runs the `tools dev-dashboard tunnel setup` cloudflared
wizard (plan 02), and registers a per-user **launchd** agent for autostart. expo-updates channels
map 1:1 to build profiles (`development`→none, `preview`→`preview`, `production`→`production`); OTA
JS-only fixes go out with `eas update --channel`, native-dep changes force a new store build (the
fingerprint changes).

**Tech Stack:** EAS CLI (`eas build`/`eas submit`/`eas update`), Expo SDK 55 (`expo-updates`,
`expo-dev-client`, `expo-build-properties`), `patch-package` + `postinstall-postinstall`, Bun (Agent
runtime + installer), `cloudflared`, macOS `launchd`, Appium (`appium_*` MCP) for the smoke run.

---

## File Structure

**Create (Mobile — under `DevDashboard/mobile/`):**
- `DevDashboard/mobile/eas.json` — build + submit profiles (`development`/`development-simulator`/`preview`/`production`) + the CLI version pin + channel mapping.
- `DevDashboard/mobile/patches/react-native-webview+13.16.1.patch` — the #3880 native diff (iOS Fabric `source`-prop fix).
- `DevDashboard/mobile/scripts/apply-patches.ts` — Bun wrapper that runs `patch-package` (invoked by `postinstall`), with a guard test verifying the patch is present + applied.
- `DevDashboard/mobile/scripts/apply-patches.test.ts` — RN test runner: patch exists, references `RNCWebViewManager.mm`, and a clean `bun install` leaves it applied.
- `DevDashboard/mobile/lib/updates/runtime-channel.ts` — pure helper exposing the running channel + embedded-vs-OTA flag (wraps `expo-updates`) for the in-app "About" + the eas-update-insights gate.
- `DevDashboard/mobile/lib/updates/runtime-channel.test.ts` — RN test runner: maps `Updates.channel`/`isEmbeddedLaunch` to the `UpdateRuntimeInfo` DTO.
- `DevDashboard/mobile/store/metadata/` — `eas metadata` store-listing config (`store.config.json`) + screenshots dir + privacy/trust copy (must match the ADR §4 per-tier trust claims).

**Create (Agent packaging — under `src/dev-dashboard/`):**
- `src/dev-dashboard/install/install.sh` — one-line `curl | sh` bootstrap (Bun + GenesisTools + wizard + launchd).
- `src/dev-dashboard/install/com.genesistools.devdashboard.plist.tmpl` — launchd user-agent template.
- `src/dev-dashboard/install/launchd.ts` — render+install/uninstall the launchd plist; `tools dev-dashboard service install|uninstall|status`.
- `src/dev-dashboard/install/launchd.test.ts` — `bun:test`: plist renders with the resolved bun path, agent args, and log paths; install/uninstall are idempotent (dry-run mode).
- `src/dev-dashboard/install/install.test.ts` — `bun:test`: the installer script passes `bash -n` and `shellcheck`, and contains the pinned repo URL + the wizard + service-install calls.

**Modify:**
- `src/dev-dashboard/index.ts` — add the `service` subcommand group (`install`/`uninstall`/`status`) wired to `launchd.ts`.
- `DevDashboard/mobile/app.config.ts` — add `runtimeVersion: { policy: "fingerprint" }`, the `expo-updates` config (`url`, `requestHeaders`), `updates.channel` left to EAS, and the EAS `projectId` under `extra.eas`.
- `DevDashboard/mobile/package.json` — `postinstall` → `bun run scripts/apply-patches.ts`; add `patch-package` + `postinstall-postinstall` devDeps (via `bun add -d`).
- `src/dev-dashboard/README.md` — "Install the Agent (customers)" section + the service commands.

**Untouched:** all `src/dev-dashboard/server/*` (plan 01) and `src/dev-dashboard/contract/*` (plan 03);
this plan only packages and ships what those built.

---

### Task 1: `patch-package` setup carrying the react-native-webview #3880 native diff

> ADR §5 + research file 06: on iOS New Architecture (Fabric), `react-native-webview` issue #3863
> leaves the `source` prop blank → the ttyd terminal never renders. The fix is PR #3880 (CLOSED
> stale, never merged) — a ~13-line native diff to `apple/RNCWebViewManager.mm`. The distribution
> model is dev-client/prebuild, so applying an unmerged native patch is **within the rules**. This
> task makes the patch re-apply automatically on every `bun install` (local AND in EAS Build), so it
> can never silently drop out of a release.

**Files:**
- Create: `DevDashboard/mobile/patches/react-native-webview+13.16.1.patch`
- Create: `DevDashboard/mobile/scripts/apply-patches.ts`
- Create: `DevDashboard/mobile/scripts/apply-patches.test.ts`
- Modify: `DevDashboard/mobile/package.json`

- [ ] **Step 1: Confirm the installed version (the patch filename must match exactly)**

Run: `cd DevDashboard/mobile && cat node_modules/react-native-webview/package.json | tools json | rg '"version"'`
Expected: `"version": "13.16.1"` (the SDK-55-pinned version from `npx expo install react-native-webview`).
If the installed version differs, name the patch `react-native-webview+<that-version>.patch` instead —
`patch-package` keys patches by exact `name+version`.

- [ ] **Step 2: Add the dev dependencies (NOT a native module — use `bun add -d`, not `expo install`)**

> `patch-package` is a build-time JS tool, so the ADR's "native via `npx expo install`" rule does NOT
> apply — it has no native code. `postinstall-postinstall` makes the hook also fire after `bun add`.

Run: `cd DevDashboard/mobile && bun add -d patch-package postinstall-postinstall`
Expected: both appear under `devDependencies` in `package.json`.

- [ ] **Step 3: Write the patch file (verified #3880 diff against `apple/RNCWebViewManager.mm`)**

Create `DevDashboard/mobile/patches/react-native-webview+13.16.1.patch`:

```diff
diff --git a/node_modules/react-native-webview/apple/RNCWebViewManager.mm b/node_modules/react-native-webview/apple/RNCWebViewManager.mm
index 1111111..2222222 100644
--- a/node_modules/react-native-webview/apple/RNCWebViewManager.mm
+++ b/node_modules/react-native-webview/apple/RNCWebViewManager.mm
@@ -1,3 +1,12 @@
+// patch-package: react-native-webview PR #3880 (iOS New-Arch source-prop fix, issue #3863).
+// Upstream PR was closed stale 2026-03-26; confirmed working on Expo SDK 55 / RN 0.83 (kulek1,
+// 2026-01-25). Without this, the Fabric updateProps path never forwards `source` -> blank WebView
+// -> the ttyd terminal never loads. See DevDashboard/research/06-terminal-recommendation.md.
+RCT_CUSTOM_VIEW_PROPERTY(newSource, NSDictionary, RNCWebViewImpl) {
+  if (json == nil) {
+    [view setSource:@{}];
+  } else {
+    [view setSource:json];
+  }
+}
```

> NOTE: the `@@` hunk header line numbers + the surrounding context are illustrative. The patch MUST
> be generated, not hand-typed: in Step 4 you edit the real `node_modules` file to add this
> `RCT_CUSTOM_VIEW_PROPERTY(newSource, …)` body (replacing the upstream empty macro at the exact site
> #3880 targets), then `bunx patch-package react-native-webview` writes the correctly-anchored diff.
> Hand-anchored line numbers WILL fail to apply. Commit the generated file, not this sketch.

- [ ] **Step 4: Generate the real patch from an edited node_modules file**

1. Open `node_modules/react-native-webview/apple/RNCWebViewManager.mm`, find the empty
   `RCT_CUSTOM_VIEW_PROPERTY(newSource, …)` macro body (the site #3863 identifies as the bypassed
   Fabric path), and replace it with the `[view setSource:json]` forwarding body above.
2. Run: `cd DevDashboard/mobile && bunx patch-package react-native-webview`
   Expected: writes `patches/react-native-webview+13.16.1.patch` and prints
   `Created file patches/react-native-webview+13.16.1.patch`.
3. Verify the diff touches only `RNCWebViewManager.mm`:
   Run: `rg -n "RNCWebViewManager.mm|setSource" DevDashboard/mobile/patches/react-native-webview+13.16.1.patch`
   Expected: both strings present; no other files in the diff.

- [ ] **Step 5: Write the `apply-patches.ts` wrapper (invoked by `postinstall`)**

Create `DevDashboard/mobile/scripts/apply-patches.ts`:

```typescript
import { spawnSync } from "node:child_process";

const result = spawnSync("bunx", ["patch-package"], { stdio: "inherit" });

if (result.status !== 0) {
    console.error("[apply-patches] patch-package failed; the react-native-webview #3880 fix is NOT applied.");
    process.exit(result.status ?? 1);
}
```

> Kept deliberately tiny and dependency-free — it runs in EAS Build's sandbox before prebuild. Using
> `process.exit(non-zero)` on failure makes a missing/un-appliable patch FAIL the build loudly
> instead of shipping a blank-WebView binary. (This script is plain Node-compatible JS, not a `tools`
> entrypoint, so it does not use `@app/logger`/`out`.)

- [ ] **Step 6: Wire the `postinstall` hook in `package.json`**

Add to `DevDashboard/mobile/package.json` `"scripts"`:

```json
{
  "scripts": {
    "postinstall": "bun run scripts/apply-patches.ts"
  }
}
```

- [ ] **Step 7: Write the failing guard test**

Create `DevDashboard/mobile/scripts/apply-patches.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PATCH = join(ROOT, "patches", "react-native-webview+13.16.1.patch");

describe("react-native-webview #3880 patch", () => {
    it("the patch file exists and targets the iOS manager", () => {
        expect(existsSync(PATCH), "patch file missing").toBe(true);
        const src = readFileSync(PATCH, "utf8");
        expect(src).toContain("RNCWebViewManager.mm");
        expect(src).toContain("setSource");
    });

    it("postinstall is wired to apply-patches", () => {
        // NOTE: bare `JSON.parse` (not SafeJSON) is intentional throughout DevDashboard/mobile — the
        // Expo project is isolated from the repo's `@app/*` aliases and does not import `@app/utils/json`.
        const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
        expect(pkg.scripts?.postinstall ?? "").toContain("apply-patches");
    });

    it("the patch is actually applied in node_modules (forwards source)", () => {
        const mm = join(ROOT, "node_modules", "react-native-webview", "apple", "RNCWebViewManager.mm");
        expect(existsSync(mm), "react-native-webview not installed").toBe(true);
        expect(readFileSync(mm, "utf8")).toContain("[view setSource:json]");
    });
});
```

- [ ] **Step 8: Run the test to verify the patch re-applies on a fresh module (no bare `rm`)**

> To prove `bun install`/`postinstall` re-applies #3880 WITHOUT a bare `rm -rf node_modules` (blocked
> by the harness, and overkill), delete ONLY the webview module via `node:fs` and re-run the
> postinstall script directly:

Run:
```bash
cd DevDashboard/mobile \
  && bun -e "import('node:fs').then(fs => fs.rmSync('node_modules/react-native-webview', { recursive: true, force: true }))" \
  && bun install \
  && bun run scripts/apply-patches.ts \
  && bun test scripts/apply-patches.test.ts
```
Expected: PASS (3 tests) — proves `bun install` + `postinstall` re-apply #3880 with no manual step.
(`fs.rmSync` targets one regenerable package dir, not user data — within the no-bare-`rm` rule.)

- [ ] **Step 9: Commit**

```bash
git add DevDashboard/mobile/patches DevDashboard/mobile/scripts/apply-patches.ts DevDashboard/mobile/scripts/apply-patches.test.ts DevDashboard/mobile/package.json
git commit -m "build(dd-mobile): patch-package carries react-native-webview #3880 (iOS Fabric source fix)"
```

---

### Task 2: `eas.json` build + submit profiles

> Three build profiles map onto the three trust/usage stages. `development` carries the native deps
> via `developmentClient: true` (so Skia/webview/sqlite/zeroconf actually link); `preview` produces
> an internal-distributable binary for hand-to-device testing; `production` produces store binaries.
> `autoIncrement` keeps build numbers monotonic. The `channel` field on `preview`/`production` is
> what binds a build to its OTA stream (Task 5).

**Files:**
- Create: `DevDashboard/mobile/eas.json`

- [ ] **Step 1: Initialize EAS (creates the project + `projectId`)**

Run: `cd DevDashboard/mobile && eas init`
Expected: prompts to create/link an EAS project, writes `extra.eas.projectId` into `app.config.ts`'s
output (and `owner`). Confirm with: `eas project:info`.
(If non-interactive in CI, this is a human-in-the-loop one-time step — note it, don't fake it.)

- [ ] **Step 2: Write `eas.json`**

Create `DevDashboard/mobile/eas.json`:

```json
{
  "cli": {
    "version": ">= 16.0.0",
    "appVersionSource": "remote"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "channel": "development",
      "ios": { "resourceClass": "m-medium" },
      "android": { "buildType": "apk" }
    },
    "development-simulator": {
      "extends": "development",
      "ios": { "simulator": true }
    },
    "preview": {
      "distribution": "internal",
      "channel": "preview",
      "autoIncrement": true,
      "ios": { "resourceClass": "m-medium" },
      "android": { "buildType": "apk" }
    },
    "production": {
      "distribution": "store",
      "channel": "production",
      "autoIncrement": true,
      "ios": { "resourceClass": "m-medium" },
      "android": { "buildType": "app-bundle" }
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "REPLACE_WITH_APPLE_ID_EMAIL",
        "ascAppId": "REPLACE_WITH_APP_STORE_CONNECT_APP_ID",
        "appleTeamId": "REPLACE_WITH_TEAM_ID"
      },
      "android": {
        "serviceAccountKeyPath": "../credentials/play-service-account.json",
        "track": "internal"
      }
    }
  }
}
```

> Decisions encoded here, each load-bearing:
> - `appVersionSource: "remote"` → EAS owns `buildNumber`/`versionCode`; `autoIncrement` bumps them
>   server-side so two parallel builds never collide. (`app.config.ts` keeps only the marketing
>   `version`.)
> - `development-simulator` `extends` `development` and flips `ios.simulator: true` — that build runs
>   on the iOS simulator for fast iteration AND is what the Appium smoke run (Self-Review) drives.
> - `preview` uses `distribution: "internal"` so it produces an installable `.apk` + an ad-hoc/UDID
>   `.ipa` shareable via a QR link without TestFlight — the fast inner loop before TestFlight.
> - `production` Android is an `app-bundle` (Play requires `.aab`); `submit.production.android.track:
>   "internal"` lands it in Play **internal testing** first (Task 3).
> - The `REPLACE_WITH_*` and `serviceAccountKeyPath` are real config the human fills once — NOT
>   placeholders for logic. The service-account JSON lives OUTSIDE the repo (gitignored credentials
>   dir); never commit it.

- [ ] **Step 3: Validate the schema**

Run: `cd DevDashboard/mobile && eas build:inspect --profile development --platform ios --output /tmp/eas-inspect 2>&1 | tee /tmp/eas-inspect.log | tail -5 || true ; eas config --profile production --platform ios 2>&1 | tee /tmp/eas-config.log | tail -20`
Expected: `eas config` prints the resolved `production` profile with `distribution: store`,
`channel: production`, `autoIncrement: true` — and NO schema-validation error. (If `eas config` is
unavailable in the installed CLI, `eas build --profile production --platform ios --dry-run` is the
fallback validator.)

- [ ] **Step 4: Gitignore credentials**

Add to `DevDashboard/mobile/.gitignore` (create if absent):

```
credentials/
*.keystore
*.p8
*.mobileprovision
```

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/eas.json DevDashboard/mobile/.gitignore
git commit -m "build(dd-mobile): eas.json profiles (development/preview/production) + submit config"
```

---

### Task 3: `expo-updates` config + `runtimeVersion` fingerprint policy

> The app carries native deps that can change ABI (`react-native-webview` + cookies, Skia,
> `expo-sqlite`, `react-native-zeroconf`). With a naive `appVersion` runtime policy, an OTA JS bundle
> could land on a binary whose native side doesn't match → crash. `runtimeVersion.policy:
> "fingerprint"` derives the runtime version from a hash of the native project (deps + config), so
> **OTA only reaches builds with an identical native fingerprint** — a native-dep change forces a new
> store build, exactly the safety we want. This task installs `expo-updates`, sets the policy, and
> exposes a tiny pure helper for the in-app "About" + the eas-update-insights gate (Task 7).

**Files:**
- Modify: `DevDashboard/mobile/app.config.ts`
- Create: `DevDashboard/mobile/lib/updates/runtime-channel.ts`
- Create: `DevDashboard/mobile/lib/updates/runtime-channel.test.ts`

- [ ] **Step 1: Install expo-updates (native module → `expo install`)**

Run: `cd DevDashboard/mobile && npx expo install expo-updates`
Expected: adds the SDK-55-pinned `expo-updates` (`~55.0.x`). Then `eas update:configure` wires the
`updates.url` + the EAS `projectId`:
Run: `eas update:configure`
Expected: writes `expo.updates.url` (`https://u.expo.dev/<projectId>`) and `expo.updates.requestHeaders`
into the config; prints the next-steps about `channel`.

- [ ] **Step 2: Set the runtimeVersion policy + updates block in `app.config.ts`**

Add/confirm in the `expo` config object (alongside the `extra.eas.projectId` from Task 2 Step 1):

```typescript
// DevDashboard/mobile/app.config.ts  (excerpt — merge into the existing expo() return)
export default (): { expo: Record<string, unknown> } => ({
    expo: {
        // ...existing name/slug/ios/android/plugins from plan 04...
        runtimeVersion: { policy: "fingerprint" },
        updates: {
            url: "https://u.expo.dev/REPLACE_WITH_PROJECT_ID",
            requestHeaders: { "expo-channel-name": "production" },
            fallbackToCacheTimeout: 0,
        },
        extra: {
            eas: { projectId: "REPLACE_WITH_PROJECT_ID" },
        },
    },
});
```

> `fallbackToCacheTimeout: 0` = launch instantly from cache, fetch the update in the background, apply
> next launch (no startup jank). The `requestHeaders.expo-channel-name` is the build-time default; EAS
> overrides it per build profile via the `channel` field in `eas.json` (Task 2). The
> `REPLACE_WITH_PROJECT_ID` is filled by `eas update:configure`/`eas init` — real config, not logic.

- [ ] **Step 3: Write the failing test for the runtime-channel helper**

Create `DevDashboard/mobile/lib/updates/runtime-channel.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { toUpdateRuntimeInfo, type UpdatesModuleShape } from "./runtime-channel";

const base: UpdatesModuleShape = {
    channel: null,
    runtimeVersion: "fp-abc123",
    isEmbeddedLaunch: true,
    updateId: null,
    createdAt: null,
};

describe("toUpdateRuntimeInfo", () => {
    it("reports an embedded launch with no channel (dev/sideloaded build)", () => {
        const info = toUpdateRuntimeInfo(base);
        expect(info.source).toBe("embedded");
        expect(info.channel).toBe("(none)");
        expect(info.runtimeVersion).toBe("fp-abc123");
    });

    it("reports an OTA launch with the channel name", () => {
        const info = toUpdateRuntimeInfo({ ...base, channel: "production", isEmbeddedLaunch: false, updateId: "u1" });
        expect(info.source).toBe("ota");
        expect(info.channel).toBe("production");
        expect(info.updateId).toBe("u1");
    });
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `cd DevDashboard/mobile && bun test lib/updates/runtime-channel.test.ts`
Expected: FAIL — `toUpdateRuntimeInfo` not defined.

- [ ] **Step 5: Implement the helper**

Create `DevDashboard/mobile/lib/updates/runtime-channel.ts`:

```typescript
export interface UpdatesModuleShape {
    channel: string | null;
    runtimeVersion: string | null;
    isEmbeddedLaunch: boolean;
    updateId: string | null;
    createdAt: Date | null;
}

export interface UpdateRuntimeInfo {
    source: "embedded" | "ota";
    channel: string;
    runtimeVersion: string;
    updateId: string | null;
    createdAt: string | null;
}

/** Pure mapper from the expo-updates module surface to a display/telemetry DTO. */
export function toUpdateRuntimeInfo(mod: UpdatesModuleShape): UpdateRuntimeInfo {
    return {
        source: mod.isEmbeddedLaunch ? "embedded" : "ota",
        channel: mod.channel ?? "(none)",
        runtimeVersion: mod.runtimeVersion ?? "(unknown)",
        updateId: mod.updateId,
        createdAt: mod.createdAt ? mod.createdAt.toISOString() : null,
    };
}

/** Live reader — call from the About screen. Imports the native module at the edge only. */
export async function readUpdateRuntimeInfo(): Promise<UpdateRuntimeInfo> {
    const Updates = await import("expo-updates");

    return toUpdateRuntimeInfo({
        channel: Updates.channel,
        runtimeVersion: Updates.runtimeVersion,
        isEmbeddedLaunch: Updates.isEmbeddedLaunch,
        updateId: Updates.updateId,
        createdAt: Updates.createdAt,
    });
}
```

> The pure `toUpdateRuntimeInfo` is unit-tested under `bun:test`; the thin `readUpdateRuntimeInfo`
> edge reader is exercised only on-device (it touches the native module). The `await import` is the
> sanctioned exception to the no-dynamic-import rule: the native `expo-updates` module must not be
> evaluated in the `bun:test` (Node) environment, so it is loaded lazily at the call edge only.

- [ ] **Step 6: Run it to confirm it passes**

Run: `cd DevDashboard/mobile && bun test lib/updates/runtime-channel.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Surface the runtime info on the Settings screen (the Appium smoke target)**

In the Settings screen (plan 04/09's `SettingsPage`), render a row that calls `readUpdateRuntimeInfo()`
and exposes it with `accessibilityLabel="settings-update-runtime"` so the distribution-smoke Appium
spec (`SettingsPage.assertUpdateRuntime()`) can read the live channel + source:

```tsx
// excerpt for the Settings screen
const [runtime, setRuntime] = useState<UpdateRuntimeInfo | null>(null);
useEffect(() => {
    readUpdateRuntimeInfo().then(setRuntime).catch(() => setRuntime(null));
}, []);

return (
    <Text accessibilityLabel="settings-update-runtime">
        {runtime ? `${runtime.channel} · ${runtime.source}` : "—"}
    </Text>
);
```

> The accessibility-id `settings-update-runtime` is the locator the Appium `assertUpdateRuntime()`
> method (defined in the Appium E2E section) finds via `appium_find_element` — never xpath (ADR §8).

- [ ] **Step 8: Commit**

```bash
git add DevDashboard/mobile/app.config.ts DevDashboard/mobile/lib/updates/ DevDashboard/mobile/app
git commit -m "feat(dd-mobile): expo-updates fingerprint runtimeVersion + channel runtime helper + Settings surface"
```

---

### Task 4: Dev-client builds (the native-dep carrier) — iOS + Android

> The whole reason for a custom dev-client (vs Expo Go): the app needs native modules Expo Go can't
> provide (`react-native-webview` + the #3880 patch, `@shopify/react-native-skia`, `expo-sqlite`,
> `react-native-zeroconf`, `@react-native-cookies/cookies`). The `development` profile from Task 2
> produces that client. Build the simulator variant for the inner loop + Appium, and a device variant
> for the on-device terminal/cookie spike (ADR §5 / plan 06 Task 0).

**Files:**
- (no new files — uses `eas.json` + the build service)

- [ ] **Step 1: Build the iOS simulator dev-client (fast inner loop + Appium target)**

Run: `cd DevDashboard/mobile && eas build --profile development-simulator --platform ios 2>&1 | tee /tmp/eas-dev-ios-sim.log`
Expected: a successful build; the log ends with a `.tar.gz`/`.app` artifact URL. Note the URL.
(This build runs `bun install` in the EAS sandbox → the `postinstall` re-applies the #3880 patch —
verify in the build log: `rg -n "patch-package|Applying patch|react-native-webview" /tmp/eas-dev-ios-sim.log`.)

- [ ] **Step 2: Install + boot the simulator dev-client**

Run: `cd DevDashboard/mobile && eas build:run --platform ios --latest 2>&1 | tee /tmp/eas-run-ios.log | tail -10`
Expected: downloads + installs the dev-client onto a booted iOS simulator and launches it.
Then start the bundler: `npx expo start --dev-client` and confirm the app connects.

- [ ] **Step 3: Build the iOS device dev-client (for the real-device terminal/cookie spike)**

> Real-device build needs the device UDID registered. ADR §5 requires an on-device confirmation that
> (a) `/ttyd/<id>/` renders with #3880 patched and (b) the `dd_session` cookie survives the WS
> handshake — that spike runs on THIS build (plan 06 owns the spike; this task just produces the client).

Run: `cd DevDashboard/mobile && eas device:create` (register the test iPhone, once), then
`eas build --profile development --platform ios 2>&1 | tee /tmp/eas-dev-ios-device.log`
Expected: an ad-hoc-signed `.ipa` installable via the QR link in the build output.

- [ ] **Step 4: Build the Android dev-client**

Run: `cd DevDashboard/mobile && eas build --profile development --platform android 2>&1 | tee /tmp/eas-dev-android.log`
Expected: a `.apk` (the `development` profile sets `android.buildType: "apk"`); install via
`eas build:run --platform android --latest` or `adb install`.

- [ ] **Step 5: Verify the native deps actually linked (smoke the JS bridge)**

In the running dev-client, confirm via the in-app About/diagnostics (or a temporary log) that
`react-native-webview`, `@shopify/react-native-skia`, `expo-sqlite`, and `react-native-zeroconf` each
resolve their native module (no "native module not found" red screen). This is the gate proving the
dev-client carries the stack — record the result in the plan-06 spike notes.

- [ ] **Step 6: Commit (artifacts are remote; commit only any config tweaks the build surfaced)**

```bash
git add -A DevDashboard/mobile
git commit -m "build(dd-mobile): dev-client builds (iOS sim+device, Android) carrying native deps" --allow-empty
```

---

### Task 5: TestFlight + Play internal testing, then store submission

> The path to users: `preview` for hand-to-device internal testing (no review), then `production`
> builds submitted to **TestFlight** (iOS) + **Play internal testing** (Android), then promotion to
> the store. `eas submit` does the upload; review/promotion happens in App Store Connect / Play
> Console. `submit.production.android.track: "internal"` (Task 2) lands Android in internal testing
> automatically.

**Files:**
- Create: `DevDashboard/mobile/store/metadata/store.config.json`
- (uses `eas.json` submit profiles)

- [ ] **Step 1: Internal preview distribution (fastest loop, no review)**

Run: `cd DevDashboard/mobile && eas build --profile preview --platform all 2>&1 | tee /tmp/eas-preview.log`
Expected: an internal-distribution `.ipa` (ad-hoc) + `.apk`. EAS prints a shareable install URL/QR.
Hand the link to testers; they install directly. This is the pre-TestFlight gate.

- [ ] **Step 2: Build the production binaries**

Run: `cd DevDashboard/mobile && eas build --profile production --platform all 2>&1 | tee /tmp/eas-prod.log`
Expected: a store `.ipa` and an `.aab`, each tagged `channel: production` (so they pull production OTA).
Confirm: `rg -n "channel|production" /tmp/eas-prod.log`.

- [ ] **Step 3: Submit iOS to TestFlight (with an internal testing group)**

Run: `cd DevDashboard/mobile && eas submit --profile production --platform ios --latest --groups "DevDashboard Internal" --what-to-test "First TestFlight build: connect over LAN/Tailscale, open a terminal, view Pulse." 2>&1 | tee /tmp/eas-submit-ios.log`
Expected: uploads the `.ipa` to App Store Connect; appears in TestFlight after Apple processing
(~5-30 min). The `--groups` flag adds it to the named internal TestFlight group automatically.
(Requires the `appleId`/`ascAppId`/`appleTeamId` filled in `eas.json` submit profile from Task 2.)

- [ ] **Step 4: Submit Android to Play internal testing**

Run: `cd DevDashboard/mobile && eas submit --profile production --platform android --latest 2>&1 | tee /tmp/eas-submit-android.log`
Expected: uploads the `.aab` to the `internal` track (per the submit profile). Appears in Play Console
→ Internal testing. (Requires `credentials/play-service-account.json` with the Play Developer API
enabled — set once; never committed.)

- [ ] **Step 5: Write the store metadata config (for `eas metadata`)**

Create `DevDashboard/mobile/store/metadata/store.config.json`:

```json
{
  "configVersion": 0,
  "apple": {
    "info": {
      "en-US": {
        "title": "DevDashboard",
        "subtitle": "Your dev machine, on your phone",
        "description": "Monitor and control your development machine from your phone: live system metrics, interactive tmux/cmux terminals, a live Q&A stream, and your Obsidian notes. Connect over your LAN, your own Tailscale tailnet, or your own Cloudflare tunnel — on those tiers the vendor is never in the data path.",
        "keywords": ["developer", "terminal", "tmux", "ssh", "monitoring", "tailscale"],
        "privacyPolicyUrl": "https://devdashboard.app/privacy"
      }
    },
    "categories": ["DEVELOPER_TOOLS", "UTILITIES"]
  }
}
```

> The description's trust language MUST match ADR §4: "vendor is never in the data path" is stated
> ONLY for LAN / Tailscale-WireGuard / self-hosted-cloudflared. Do NOT make an unconditional no-see
> claim that would also cover the managed tier (that tier's claim is a property of the E2E layer, with
> the metadata caveat — keep store copy honest per the ADR's trust policy).

- [ ] **Step 6: Push metadata (optional, after the App Store Connect app record exists)**

Run: `cd DevDashboard/mobile && eas metadata:push 2>&1 | tee /tmp/eas-metadata.log | tail -10`
Expected: pushes the listing to App Store Connect (or reports validation errors to fix before the
store review). Screenshots go in `store/metadata/` per the `eas metadata` schema.

- [ ] **Step 7: Commit**

```bash
git add DevDashboard/mobile/store/metadata/store.config.json
git commit -m "release(dd-mobile): store metadata + TestFlight/Play internal submission config"
```

> Store **promotion to public release** (TestFlight → App Store, Play internal → production) is a
> human action in App Store Connect / Play Console after review — it is NOT scripted here. The
> release-readiness checklist (end of plan) is the gate for that human step.

---

### Task 6: `expo-updates` OTA channel strategy

> OTA is for **JS-only** fixes (logic, styles, copy) on a binary whose native fingerprint is
> unchanged. Channels (`preview`, `production`) match the `eas.json` build profiles 1:1. A
> native-dep change (new pin, a new patch, an `expo install`) changes the `fingerprint`
> `runtimeVersion` → the OTA simply won't reach old binaries → you ship a new store build. This task
> documents + scripts the publish/promote flow and the rollback.

**Files:**
- Create: `DevDashboard/mobile/scripts/ota.md` (the runbook — short, copy-pasteable commands)

- [ ] **Step 1: Publish a JS-only update to the preview channel (this DOES re-bundle)**

> `eas update --channel <c>` re-bundles the current working tree and publishes a NEW update group.
> SDK 55+ REQUIRES `--environment` (per the EAS CLI `eas update` flags). Use this to publish the
> fix to `preview` first, where testers verify it before it ever touches production.

Run: `cd DevDashboard/mobile && eas update --channel preview --environment preview --message "fix: keybar Ctrl modifier sticky state" 2>&1 | tee /tmp/eas-update-preview.log`
Expected: bundles + uploads; prints the update group ID + the matching `runtimeVersion`. Only
`preview`-channel builds with that fingerprint receive it. Capture the group ID:
`GROUP_ID=$(rg -o '[0-9a-f-]{36}' /tmp/eas-update-preview.log | head -1)` (or `eas update:list --branch preview --json --non-interactive | jq -r '.currentPage[0].group'`).

- [ ] **Step 2: PROMOTE the verified group to production WITHOUT re-bundling (`update:republish`)**

> CRITICAL: do NOT use `eas update --channel production` here — that would re-bundle the working tree
> and ship an UNVERIFIED rebuild to production. The command that promotes the exact group testers
> verified on `preview` is `eas update:republish` (confirmed via the EAS CLI flags: it selects an
> existing group via `--group`/`--channel` and republishes to `--destination-channel`, no bundler run).

Run: `cd DevDashboard/mobile && eas update:republish --group "$GROUP_ID" --destination-channel production --message "promote: keybar Ctrl fix" --non-interactive 2>&1 | tee /tmp/eas-update-prod.log`
Expected: the production channel now serves the SAME bytes verified on preview to production-fingerprint
binaries; no re-bundle line in the log. (For a staged rollout, add `--rollout-percentage 10` and ramp
with `eas update:edit <GROUPID> --rollout-percentage 100` once Task 7's health gate is green.)

- [ ] **Step 3: Rollback (the safety valve) — non-interactive `roll-back-to-embedded`**

> If an OTA is bad: publish a roll-back-to-embedded directive so devices fall back to the binary's
> embedded bundle, then fix-forward. `eas update:rollback` is INTERACTIVE; the scriptable form (and
> the one the CLI itself recommends for non-interactive use) is `eas update:roll-back-to-embedded`.

Run: `cd DevDashboard/mobile && eas update:roll-back-to-embedded --channel production --message "rollback: bad keybar OTA" --non-interactive 2>&1 | tee /tmp/eas-rollback.log`
Expected: devices on `production` revert to the embedded (last-shipped-binary) bundle on next launch.
(Interactive alternative: `eas update:rollback`.)

- [ ] **Step 4: Write the OTA runbook**

Create `DevDashboard/mobile/scripts/ota.md` documenting, in order: when OTA is allowed (JS-only,
fingerprint unchanged) vs when a store build is required (any native change), the
publish-to-preview→verify→**republish (not re-bundle)** to production flow from Steps 1-2, the
roll-back-to-embedded from Step 3, and a one-line "how to tell which a change needs" rule: *if `eas
fingerprint:hash` changes vs the shipped build, you need a new binary, not an OTA.* Spell out the
re-bundle-vs-promote distinction explicitly (it is the single easiest way to ship an unverified
build). Verify the fingerprint tool exists:
Run: `cd DevDashboard/mobile && eas fingerprint:hash 2>&1 | tee /tmp/eas-fp.log | tail -3 || echo "use 'npx expo fingerprint' if eas subcommand absent"`
Expected: a fingerprint hash (or the documented fallback command).

- [ ] **Step 5: Commit**

```bash
git add DevDashboard/mobile/scripts/ota.md
git commit -m "docs(dd-mobile): expo-updates OTA channel strategy + rollback runbook"
```

---

### Task 7: EAS Update health insights gate (`eas-update-insights`)

> After an OTA, you must know it's healthy before promoting wider: crash rate, install/launch counts,
> embedded-vs-OTA split, payload size. The `expo:eas-update-insights` skill covers querying this. Wire
> a CI-friendly check so a bad rollout is caught, plus surface the running update in-app via the Task 3
> helper.

**Files:**
- Create: `DevDashboard/mobile/scripts/check-update-health.ts`
- Create: `DevDashboard/mobile/scripts/check-update-health.test.ts`

- [ ] **Step 1: The verified `eas update:insights --json` schema (from the `expo:eas-update-insights` skill)**

> Confirmed against the `expo:eas-update-insights` skill. `eas update:insights <groupId> --json
> --non-interactive` returns `{ groupId, timespan, platforms[] }` where each platform entry has:
> `platforms[].totals.{ uniqueUsers, installs, failedInstalls, crashRatePercent }` and
> `platforms[].payload.{ launchAssetCount, averageUpdatePayloadBytes }`. The CLI's display labels
> "Launches"/"Crashes" map to the JSON fields `installs`/`failedInstalls` (NOT `launches`/`crashes`).
> `crashRatePercent = failedInstalls / (installs + failedInstalls) * 100`. The embedded-vs-OTA split
> is a SEPARATE command: `eas channel:insights --channel <name> --runtime-version <v> --json` →
> `{ embeddedUpdateTotalUniqueUsers, otaTotalUniqueUsers, mostPopularUpdates[] }`. Caveat (skill):
> `installs` lags real launches up to ~24h, `failedInstalls` is self-reported. The DTO below mirrors
> these exact field names so the live parser is a 1:1 lift from the JSON.

- [ ] **Step 2: Write the failing test for the health gate (pure parser, real field names)**

Create `DevDashboard/mobile/scripts/check-update-health.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { evaluatePlatformHealth, type PlatformInsights } from "./check-update-health";

// Field names match `eas update:insights --json` -> platforms[].totals / .payload exactly.
const healthy: PlatformInsights = {
    platform: "ios",
    totals: { uniqueUsers: 480, installs: 500, failedInstalls: 2, crashRatePercent: 0.4 },
    payload: { launchAssetCount: 1, averageUpdatePayloadBytes: 1_200_000 },
};

describe("evaluatePlatformHealth", () => {
    it("passes a low-crash, well-adopted platform", () => {
        const r = evaluatePlatformHealth(healthy, { maxCrashRatePercent: 2, minInstalls: 100 });
        expect(r.ok).toBe(true);
    });

    it("fails when crashRatePercent exceeds the threshold", () => {
        const r = evaluatePlatformHealth(
            { ...healthy, totals: { ...healthy.totals, failedInstalls: 60, crashRatePercent: 10.7 } },
            { maxCrashRatePercent: 2, minInstalls: 100 },
        );
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("crash");
    });

    it("is inconclusive below the minimum install sample", () => {
        const r = evaluatePlatformHealth(
            { ...healthy, totals: { ...healthy.totals, installs: 10 } },
            { maxCrashRatePercent: 2, minInstalls: 100 },
        );
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("sample");
    });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd DevDashboard/mobile && bun test scripts/check-update-health.test.ts`
Expected: FAIL — `evaluatePlatformHealth` not defined.

- [ ] **Step 4: Implement the health gate (DTO mirrors the `--json` schema)**

Create `DevDashboard/mobile/scripts/check-update-health.ts`:

```typescript
/** Mirrors one entry of `eas update:insights <groupId> --json`'s `platforms[]`. */
export interface PlatformInsights {
    platform: "ios" | "android";
    totals: {
        uniqueUsers: number;
        installs: number;        // CLI label: "Launches"
        failedInstalls: number;  // CLI label: "Crashes"
        crashRatePercent: number;
    };
    payload: {
        launchAssetCount: number;
        averageUpdatePayloadBytes: number;
    };
}

/** Full `eas update:insights --json` envelope. */
export interface UpdateInsightsReport {
    groupId: string;
    platforms: PlatformInsights[];
}

export interface HealthThresholds {
    /** Reject above this crashRatePercent (e.g. 2 = 2%). */
    maxCrashRatePercent: number;
    /** Require at least this many installs before the verdict is conclusive. */
    minInstalls: number;
}

export interface HealthVerdict {
    ok: boolean;
    crashRatePercent: number;
    reason: string;
}

/** Pure per-platform verdict — testable without the network. Trusts the CLI's crashRatePercent. */
export function evaluatePlatformHealth(p: PlatformInsights, thresholds: HealthThresholds): HealthVerdict {
    const { installs, failedInstalls, crashRatePercent } = p.totals;
    const sample = installs + failedInstalls;

    if (sample < thresholds.minInstalls) {
        return { ok: false, crashRatePercent, reason: `insufficient sample (${sample} < ${thresholds.minInstalls} installs)` };
    }

    if (crashRatePercent > thresholds.maxCrashRatePercent) {
        return { ok: false, crashRatePercent, reason: `crash rate ${crashRatePercent.toFixed(2)}% exceeds ${thresholds.maxCrashRatePercent.toFixed(2)}%` };
    }

    return { ok: true, crashRatePercent, reason: "healthy" };
}

/** Gate the whole report: every platform must be healthy. */
export function evaluateReportHealth(report: UpdateInsightsReport, thresholds: HealthThresholds): HealthVerdict {
    for (const platform of report.platforms) {
        const verdict = evaluatePlatformHealth(platform, thresholds);

        if (!verdict.ok) {
            return { ...verdict, reason: `${platform.platform}: ${verdict.reason}` };
        }
    }

    return { ok: true, crashRatePercent: 0, reason: "all platforms healthy" };
}
```

> The live fetch is a thin edge: `eas update:insights "$GROUP_ID" --json --non-interactive` →
> `SafeJSON.parse` is NOT used here (this script is plain Node in the isolated mobile project, no
> `@app/*` alias), so `JSON.parse` the stdout into `UpdateInsightsReport`, then call
> `evaluateReportHealth` and `process.exit(verdict.ok ? 0 : 1)`. That non-zero exit lets CI block the
> Task 6 Step 2 republish-to-production until the preview rollout is proven healthy. `embeddedShare`
> (from `eas channel:insights`) is reported separately when you need adoption, not gated on here.

- [ ] **Step 5: Run it to confirm it passes**

Run: `cd DevDashboard/mobile && bun test scripts/check-update-health.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add DevDashboard/mobile/scripts/check-update-health.ts DevDashboard/mobile/scripts/check-update-health.test.ts
git commit -m "feat(dd-mobile): eas-update-insights health gate (crash rate / sample / adoption)"
```

---

### Task 8: Agent packaging — launchd autostart service (macOS)

> A customer must be able to keep the DevDashboard Agent running across reboots without a terminal
> open. On macOS the idiomatic answer is a per-user **launchd** agent (`~/Library/LaunchAgents/`).
> This task adds `tools dev-dashboard service install|uninstall|status` that renders + loads the plist.
> The Agent binary is `tools dev-dashboard agent` (plan 01 Task 11).

**Files:**
- Create: `src/dev-dashboard/install/com.genesistools.devdashboard.plist.tmpl`
- Create: `src/dev-dashboard/install/launchd.ts`
- Create: `src/dev-dashboard/install/launchd.test.ts`
- Modify: `src/dev-dashboard/index.ts`

- [ ] **Step 1: Write the launchd plist template**

Create `src/dev-dashboard/install/com.genesistools.devdashboard.plist.tmpl`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.genesistools.devdashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>__BUN_PATH__</string>
        <string>__AGENT_ENTRY__</string>
        <string>agent</string>
        <string>--port</string>
        <string>__PORT__</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>__LOG_OUT__</string>
    <key>StandardErrorPath</key>
    <string>__LOG_ERR__</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>__PATH__</string>
    </dict>
</dict>
</plist>
```

> `KeepAlive: true` restarts the Agent if it crashes; `RunAtLoad: true` starts it at login. The
> `__TOKENS__` are substituted by `launchd.ts` with the resolved absolute Bun path, the Agent entry
> file, the configured port, and log paths under `~/.genesis-tools/dev-dashboard/`. A per-user
> LaunchAgent (not a system LaunchDaemon) so no `sudo` is required and the Agent runs as the user with
> their tmux/cmux/Reminders/Obsidian access.

- [ ] **Step 2: Write the failing test**

Create `src/dev-dashboard/install/launchd.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { renderLaunchdPlist } from "@app/dev-dashboard/install/launchd";

describe("renderLaunchdPlist", () => {
    it("substitutes every token with concrete values", () => {
        const xml = renderLaunchdPlist({
            bunPath: "/Users/x/.bun/bin/bun",
            agentEntry: "/Users/x/GenesisTools/src/dev-dashboard/index.ts",
            port: 3043,
            logOut: "/Users/x/.genesis-tools/dev-dashboard/agent.out.log",
            logErr: "/Users/x/.genesis-tools/dev-dashboard/agent.err.log",
            pathEnv: "/usr/local/bin:/usr/bin:/bin",
        });

        expect(xml).toContain("<string>/Users/x/.bun/bin/bun</string>");
        expect(xml).toContain("<string>agent</string>");
        expect(xml).toContain("<string>3043</string>");
        expect(xml).toContain("com.genesistools.devdashboard");
        expect(xml).not.toContain("__");
    });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `bun test src/dev-dashboard/install/launchd.test.ts`
Expected: FAIL — `renderLaunchdPlist` not defined.

- [ ] **Step 4: Implement `launchd.ts`**

Create `src/dev-dashboard/install/launchd.ts`:

```typescript
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger, out } from "@app/logger";

const LABEL = "com.genesistools.devdashboard";
const TEMPLATE = join(import.meta.dir, "com.genesistools.devdashboard.plist.tmpl");

export interface LaunchdRenderInput {
    bunPath: string;
    agentEntry: string;
    port: number;
    logOut: string;
    logErr: string;
    pathEnv: string;
}

export function renderLaunchdPlist(input: LaunchdRenderInput): string {
    const template = readFileSync(TEMPLATE, "utf8");

    return template
        .replaceAll("__BUN_PATH__", input.bunPath)
        .replaceAll("__AGENT_ENTRY__", input.agentEntry)
        .replaceAll("__PORT__", String(input.port))
        .replaceAll("__LOG_OUT__", input.logOut)
        .replaceAll("__LOG_ERR__", input.logErr)
        .replaceAll("__PATH__", input.pathEnv);
}

function plistPath(): string {
    return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function resolveBunPath(): string {
    const which = spawnSync("which", ["bun"], { encoding: "utf8" });

    if (which.status === 0 && which.stdout.trim()) {
        return which.stdout.trim();
    }

    return join(homedir(), ".bun", "bin", "bun");
}

export interface ServiceInstallOptions {
    port: number;
    agentEntry: string;
    /** When true, render + return the plist but do not write/load it (test/dry-run). */
    dryRun?: boolean;
}

export function installService(opts: ServiceInstallOptions): string {
    const logDir = join(homedir(), ".genesis-tools", "dev-dashboard");
    const xml = renderLaunchdPlist({
        bunPath: resolveBunPath(),
        agentEntry: opts.agentEntry,
        port: opts.port,
        logOut: join(logDir, "agent.out.log"),
        logErr: join(logDir, "agent.err.log"),
        pathEnv: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    });

    if (opts.dryRun) {
        return xml;
    }

    const target = plistPath();
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(target, xml, "utf8");

    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, target], { stdio: "ignore" });
    const load = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? ""}`, target], { encoding: "utf8" });

    if (load.status !== 0) {
        logger.warn({ stderr: load.stderr }, "launchctl bootstrap failed");
    }

    out.log.success(`DevDashboard Agent service installed (${target}). It will start at login and on reboot.`);

    return xml;
}

export function uninstallService(): void {
    const target = plistPath();

    if (!existsSync(target)) {
        out.log.info("No DevDashboard Agent service installed.");
        return;
    }

    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, target], { stdio: "ignore" });
    rmSync(target, { force: true });
    out.log.success("DevDashboard Agent service uninstalled.");
}

export function serviceStatus(): void {
    const result = spawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? ""}/${LABEL}`], { encoding: "utf8" });

    if (result.status === 0) {
        out.result({ installed: true, label: LABEL, detail: result.stdout.split("\n").slice(0, 12).join("\n") });
        return;
    }

    out.result({ installed: false, label: LABEL });
}
```

> `uninstallService` uses `rmSync(target, { force: true })` (from `node:fs`, NOT a bare `rm` shell-out)
> on a file IT created (the rendered plist) — sanctioned because it is service-managed config the
> install command owns, not user data. The `out.log.*`/`out.result` split obeys the logger contract
> (status → stderr, the status DTO → stdout).

- [ ] **Step 5: Run it to confirm it passes**

Run: `bun test src/dev-dashboard/install/launchd.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the `service` subcommand in `index.ts`**

Add to `src/dev-dashboard/index.ts` (before `runTool`):

```typescript
import { resolve } from "node:path";
import { installService, serviceStatus, uninstallService } from "@app/dev-dashboard/install/launchd";

const service = program.command("service").description("Manage the DevDashboard Agent autostart service (macOS launchd)");

service
    .command("install")
    .description("Install + start the Agent as a login/boot service")
    .option("--port <port>", "agent port", (v) => Number.parseInt(v, 10), 3043)
    .action((opts: { port: number }) => {
        installService({ port: opts.port, agentEntry: resolve(import.meta.dir, "index.ts") });
    });

service
    .command("uninstall")
    .description("Stop + remove the Agent service")
    .action(() => {
        uninstallService();
    });

service
    .command("status")
    .description("Show the Agent service status")
    .action(() => {
        serviceStatus();
    });
```

- [ ] **Step 7: Smoke the service end-to-end (dry-run first, then real)**

Run: `tools dev-dashboard service install --port 3043 && sleep 2 && tools dev-dashboard service status | tools json`
Expected: `{ installed: true, label: "com.genesistools.devdashboard", … }`; then
`curl -s -u <user>:<pw> localhost:3043/api/system/pulse | tools json` returns a snapshot. Clean up
with `tools dev-dashboard service uninstall` if this is a test machine.

- [ ] **Step 8: Commit**

```bash
git add src/dev-dashboard/install/launchd.ts src/dev-dashboard/install/launchd.test.ts src/dev-dashboard/install/com.genesistools.devdashboard.plist.tmpl src/dev-dashboard/index.ts
git commit -m "feat(dd-agent): launchd autostart service (service install/uninstall/status)"
```

---

### Task 9: One-line Agent installer (`curl | sh`) tying it all together

> A non-technical "vibecoder" customer should run ONE command to: install Bun, install GenesisTools,
> run the cloudflared pairing wizard (plan 02's `tools dev-dashboard tunnel setup`), and register the
> launchd service (Task 8). This is the customer-facing entry point. Idempotent + safe to re-run.

**Files:**
- Create: `src/dev-dashboard/install/install.sh`
- Create: `src/dev-dashboard/install/install.test.ts`
- Modify: `src/dev-dashboard/README.md`

- [ ] **Step 1: Write the installer script**

Create `src/dev-dashboard/install/install.sh`:

```sh
#!/usr/bin/env sh
# DevDashboard Agent installer. Run: curl -fsSL https://devdashboard.app/install.sh | sh
# Idempotent: safe to re-run. Installs Bun + GenesisTools, runs the tunnel wizard, registers autostart.
set -eu

REPO_URL="https://github.com/martin/GenesisTools.git"   # REPLACE with the public repo URL
INSTALL_DIR="${DEVDASHBOARD_HOME:-$HOME/.devdashboard/GenesisTools}"

say() { printf '\033[1;36m[devdashboard]\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m[devdashboard] error:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "v1 supports macOS only. Linux/Windows are on the roadmap."

# 1. Bun
if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || die "Bun install failed; open a new shell and re-run."

# 2. GenesisTools (clone or update)
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating GenesisTools..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  say "Cloning GenesisTools..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

say "Installing dependencies..."
( cd "$INSTALL_DIR" && bun install )
( cd "$INSTALL_DIR" && ./install.sh )   # the repo's own PATH installer (adds `tools`)

# 3. Tunnel wizard (plan 02) — auto-detects/installs cloudflared, CF login, route, persist, QR pairing
say "Setting up your private tunnel (you own the Cloudflare account; the vendor is never in the data path)..."
"$INSTALL_DIR/tools" dev-dashboard tunnel setup

# 4. Autostart service (Task 8)
say "Registering the Agent to start at login..."
"$INSTALL_DIR/tools" dev-dashboard service install

say "Done. Scan the QR shown above in the DevDashboard app to pair. Manage with: tools dev-dashboard service status"
```

> Notes: POSIX `sh` (not bash-isms) for portability across the default macOS shell; `set -eu` fails
> fast; every external step is guarded/idempotent. The `REPO_URL` is filled when the repo is public.
> The wizard + service-install are the two `tools dev-dashboard` subcommands this plan + plan 02 add.
> The "vendor is never in the data path" line is honest for the self-hosted-cloudflared tier per ADR
> §4 (the customer owns their CF account).

- [ ] **Step 2: Write the failing test (lint + content guards)**

Create `src/dev-dashboard/install/install.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "install.sh");

describe("install.sh", () => {
    it("is syntactically valid sh", () => {
        const r = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
    });

    it("installs Bun, GenesisTools, runs the wizard, and registers the service", () => {
        const src = readFileSync(SCRIPT, "utf8");
        expect(src).toContain("bun.sh/install");
        expect(src).toContain("dev-dashboard tunnel setup");
        expect(src).toContain("dev-dashboard service install");
        expect(src).toContain("set -eu");
    });

    it("guards macOS-only for v1", () => {
        expect(readFileSync(SCRIPT, "utf8")).toContain("Darwin");
    });
});
```

- [ ] **Step 3: Run it to confirm it fails, then make `install.sh` executable**

Run: `bun test src/dev-dashboard/install/install.test.ts`
Expected: FAIL initially if the file is absent; after Step 1, `chmod +x src/dev-dashboard/install/install.sh`
and re-run → PASS (3 tests).

- [ ] **Step 4: Optional shellcheck (if available)**

Run: `command -v shellcheck >/dev/null && shellcheck src/dev-dashboard/install/install.sh || echo "shellcheck not installed; sh -n passed"`
Expected: no errors (or the skip message).

- [ ] **Step 5: Document the customer install in the README**

Add to `src/dev-dashboard/README.md` an "Install the Agent (customers)" section: the one-line
`curl -fsSL https://devdashboard.app/install.sh | sh`, what it does (Bun + GenesisTools + your-own
tunnel + autostart), the trust statement matching ADR §4 (LAN / Tailscale / your-own-cloudflared =
vendor not in path), and the `tools dev-dashboard service status|uninstall` management commands.

- [ ] **Step 6: Commit**

```bash
git add src/dev-dashboard/install/install.sh src/dev-dashboard/install/install.test.ts src/dev-dashboard/README.md
git commit -m "feat(dd-agent): one-line installer (Bun + GenesisTools + tunnel wizard + autostart)"
```

---

### Task 10: Cross-platform future story (documented seam, not v1 code)

> ADR §1 + research file 00: the Agent is macOS-only today (`SystemCollector` is `MacSystemCollector`;
> the launchd service is macOS). The product roadmap needs Linux (`systemd --user`) and a Windows
> story. This task records the seam so a future agent can extend without rediscovery — and adds the
> ONE guard that keeps the installer/service honest about the gap.

**Files:**
- Create: `src/dev-dashboard/install/PLATFORMS.md`

- [ ] **Step 1: Write the cross-platform note**

Create `src/dev-dashboard/install/PLATFORMS.md` documenting:
  - **macOS (v1, shipped):** launchd user-agent (Task 8); `MacSystemCollector` (plan 01 Task 4).
  - **Linux (roadmap):** a `systemd --user` unit mirroring the plist (`ExecStart=bun … agent --port`,
    `Restart=always`, `WantedBy=default.target`); a `LinuxSystemCollector` reading `/proc/stat`,
    `/proc/meminfo`, `free`, `df`, `nmcli` behind the SAME `SystemCollector` interface (plan 01 §4 —
    the interface already exists for this). tmux works; cmux/ttyd availability is advertised as a
    capability (research file 00 §"capability plugins"). The installer gains a `uname -s = Linux`
    branch installing the systemd unit instead of the plist.
  - **Windows (later):** a Task Scheduler / Windows Service wrapper; `WindowsSystemCollector` via
    `wmic`/PowerShell `Get-Counter`; no tmux/cmux (advertise as unavailable). Lowest priority.
  - **The single shared seam:** `installService`/`uninstallService`/`serviceStatus` (Task 8) +
    `defaultSystemCollector()` (plan 01) are the two extension points; per-OS impls slot behind them.
    The mobile app needs NO change — capabilities are advertised over the contract and the UI degrades
    gracefully (a Linux box without cmux simply hides that tab).

- [ ] **Step 2: Commit**

```bash
git add src/dev-dashboard/install/PLATFORMS.md
git commit -m "docs(dd-agent): cross-platform packaging roadmap (systemd/Windows seams)"
```

---

## Release-readiness checklist

Run before every store submission (Task 5 Step 2+). A release is NOT ready until every box is ticked.

**Mobile — build integrity**
- [ ] `bun test DevDashboard/mobile/scripts/apply-patches.test.ts` green — the #3880 patch is present AND applied in `node_modules` (a clean `bun install` re-applies it).
- [ ] The latest EAS build log contains the patch-package application line (`rg -n "patch-package|Applying patch" /tmp/eas-prod.log`) — proves the iOS Fabric `source` fix shipped, so the terminal won't be blank.
- [ ] `eas config --profile production --platform ios` resolves with `distribution: store`, `channel: production`, `autoIncrement: true`, no schema error.
- [ ] `runtimeVersion.policy === "fingerprint"` in `app.config.ts`; `eas fingerprint:hash` recorded for the shipped build (so OTA targeting is correct).
- [ ] `appVersionSource: "remote"` + `autoIncrement` — build numbers are server-owned and monotonic (no duplicate-version submit rejection).

**Mobile — OTA + insights**
- [ ] Channels `preview` + `production` exist and map to the build profiles (`eas channel:list`).
- [ ] OTA runbook (`scripts/ota.md`) present; promote uses `eas update:republish` (NOT `eas update --channel`, which re-bundles); rollback uses `eas update:roll-back-to-embedded --channel production --non-interactive`, verified valid in the installed CLI.
- [ ] `bun test DevDashboard/mobile/scripts/check-update-health.test.ts` green; the health gate's thresholds (`maxCrashRatePercent`, `minInstalls`) are set for this app, and the CI promotion step blocks on `evaluateReportHealth`.
- [ ] In-app About shows the running channel + embedded-vs-OTA via `readUpdateRuntimeInfo()` (Task 3) — confirmed on a real OTA.

**Mobile — store**
- [ ] TestFlight build processed + assigned to the "DevDashboard Internal" group (`--groups`), `--what-to-test` set.
- [ ] Play `.aab` in the internal track; `play-service-account.json` present locally, NOT committed.
- [ ] `store.config.json` trust copy matches ADR §4 (no unconditional no-see claim covering the managed tier); `privacyPolicyUrl` live.
- [ ] iOS `NSLocalNetworkUsageDescription` + `NSBonjourServices` (LAN/zeroconf) and any camera/notification usage strings present in `app.config.ts` (App Store review rejects missing usage strings).
- [ ] Screenshots for required device sizes in `store/metadata/`.

**Agent — packaging**
- [ ] `bun test src/dev-dashboard/install/` green (launchd render + installer lint).
- [ ] `tools dev-dashboard service install` → `status` shows `installed: true`, and `curl` against the port returns a pulse snapshot.
- [ ] `tools dev-dashboard tunnel setup` (plan 02) completes the cloudflared wizard end-to-end and emits a scannable pairing QR.
- [ ] `install.sh` passes `sh -n` (+ shellcheck if available); `REPO_URL` points at the public repo; re-running it is idempotent.
- [ ] `PLATFORMS.md` records the systemd/Windows seams (no surprise when a Linux customer asks).

**Cross-cutting**
- [ ] `bash scripts/ci/logging-guard.sh` green (Agent install code uses `out`/`logger` correctly — no result via `logger`).
- [ ] `bunx tsgo --noEmit | rg "dev-dashboard/install|DevDashboard/mobile"` — no type errors in this plan's files.
- [ ] The **smoke Appium run** (below) passes against the freshly installed dev-client.

---

## Appium E2E (per ADR §8) — distribution smoke

> Per ADR §8, a feature is "done" only when its Appium spec passes on the iOS simulator/dev-client.
> Distribution's spec is a **post-install smoke**: it proves the artifact this plan ships (the
> `development-simulator` dev-client from Task 4, carrying the #3880-patched WebView + the native
> stack) actually boots, reaches an Agent, and renders the core surfaces — i.e. that packaging didn't
> break anything the feature plans (05-08) verified in isolation. It is the gate the
> release-readiness checklist's last box refers to.

**Spec:** `DevDashboard/mobile/e2e/specs/distribution-smoke.spec.ts`

**Page Objects used (defined by the feature plans; this spec only consumes them):**
- `ConnectPage` (plan 02/04) — `connectViaLan()`, `assertConnected()`.
- `PulsePage` (plan 05) — `assertVisible()`, `assertMetricUpdates()`.
- `TerminalPage` (plan 06) — `open(sessionId)`, `assertLiveShell()` (this is the load-bearing one for
  distribution: it proves the #3880 patch shipped — a blank WebView fails here).
- `SettingsPage` (plan 09/04, the ADR §8 POM name) — `assertUpdateRuntime()` reading the
  `readUpdateRuntimeInfo()` channel/source line.

**New Page Object method this plan needs (add to `SettingsPage` — the ADR §8 POM list has `SettingsPage`, not a separate AboutPage):**
- `assertUpdateRuntime(): Promise<{ channel: string; source: "embedded" | "ota" }>` — reads the
  accessibility-id `settings-update-runtime` label and parses the `channel` + `source` it renders from
  `readUpdateRuntimeInfo()`. (Accessibility-id locators per ADR §8 — `appium_find_element` by
  accessibility id, never xpath.)

**Spec outline (the smoke flow):**

```typescript
// DevDashboard/mobile/e2e/specs/distribution-smoke.spec.ts
import { ConnectPage } from "../pages/connect.page";
import { PulsePage } from "../pages/pulse.page";
import { TerminalPage } from "../pages/terminal.page";
import { SettingsPage } from "../pages/settings.page";

describe("distribution smoke (dev-client build)", () => {
    it("boots the packaged dev-client, connects, and renders the core surfaces", async () => {
        // 1. App launched on the iOS simulator dev-client (development-simulator profile, Task 4 Step 1-2).
        await new ConnectPage().connectViaLan();
        await new ConnectPage().assertConnected();

        // 2. Pulse renders + updates — proves Skia chart native module linked.
        const pulse = new PulsePage();
        await pulse.assertVisible();
        await pulse.assertMetricUpdates();

        // 3. Terminal opens a LIVE shell — THE distribution-critical assertion:
        //    a blank WebView (the unpatched #3863 bug) fails assertLiveShell().
        const term = new TerminalPage();
        await term.open("smoke-session");
        await term.assertLiveShell();

        // 4. Settings shows the running channel + embedded/OTA source (proves expo-updates wired).
        const settings = new SettingsPage();
        const runtime = await settings.assertUpdateRuntime();
        expect(["embedded", "ota"]).toContain(runtime.source);
    });
});
```

**How to run the smoke (Task 4's artifact is the target):**

- [ ] **Step 1:** Boot the simulator dev-client from Task 4 Step 2 (`eas build:run --platform ios --latest`); start the bundler (`npx expo start --dev-client`); have an Agent reachable on the LAN (`tools dev-dashboard service status` shows running, or `tools dev-dashboard agent --port 3043`).
- [ ] **Step 2:** Establish the Appium session against the booted simulator: `select_device` (the iOS simulator) → `appium_session_management` (action=create) per the `appium` skill.
- [ ] **Step 3:** Run the smoke spec; drive taps/scrolls via `appium_gesture`, locate by accessibility id via `appium_find_element`. On a blank-terminal failure, the #3880 patch did NOT ship — re-check Task 1 Step 8 + the EAS build log.
- [ ] **Step 4:** The feature is "done" (distribution-wise) only when `distribution-smoke.spec.ts` passes on the dev-client build. Tick the final release-readiness box.

---

## Self-Review checklist (run after implementing)

1. **Patch durability:** the #3880 diff is keyed to the exact installed `react-native-webview` version, re-applied by `postinstall` on every `bun install` (local AND EAS Build), and the guard test fails the build if it's missing — so the terminal can never silently regress to blank.
2. **Profiles complete:** `development` (+`-simulator`), `preview`, `production` each have the right `distribution`/`channel`/`buildType`; submit profile carries the Apple + Play identifiers; credentials are gitignored, never committed.
3. **OTA safety:** `runtimeVersion.policy: "fingerprint"` guarantees an OTA never lands on a mismatched native ABI; channels map 1:1 to profiles; rollback + health-gate are in place; the "native change → new build, JS change → OTA" rule is documented and backed by `eas fingerprint:hash`.
4. **Agent install honesty:** the one-line installer + launchd service work on macOS, are idempotent, and the trust copy (installer + store metadata) matches ADR §4 per-tier exactly — no overclaim on the managed tier.
5. **Type/name consistency:** `UpdateRuntimeInfo`, `PlatformInsights`/`UpdateInsightsReport`, `LaunchdRenderInput`, `ServiceInstallOptions` are the names used in code + tests; the new Appium method `assertUpdateRuntime()` hangs off `SettingsPage` (the ADR §8 POM name, not an invented AboutPage); the Agent entry is `tools dev-dashboard agent` (plan 01) and the wizard is `tools dev-dashboard tunnel setup` (plan 02) — no divergent names invented. The insights DTO field names (`installs`/`failedInstalls`/`crashRatePercent`) match the verified `eas update:insights --json` schema exactly.
6. **No placeholders in logic:** every `REPLACE_WITH_*` is human-filled CONFIG (Apple IDs, project IDs, repo URL), not an unwritten code step; all code blocks are complete and runnable.
7. **Logger contract:** Agent install code uses `out.log.*`/`out.result` (stderr status / stdout result); the mobile build scripts are plain Node (no `@app/logger`) by design; the dynamic `import("expo-updates")` is the documented edge-only exception.
8. **Appium gate:** `distribution-smoke.spec.ts` is the definition of done; `assertLiveShell()` is the distribution-critical assertion that proves the #3880 patch shipped.

## Hand-off

This plan is the program's last phase (Overview §Phase 6). It **consumes** plan 01 (`tools
dev-dashboard agent`), plan 02 (`tools dev-dashboard tunnel setup` wizard + pairing QR), plan 04 (the
Expo project, `app.config.ts`, the e2e Page Objects), and plans 05-08 (the feature Page Objects the
smoke spec reuses). It **produces** nothing other plans depend on — it ships them. After this:
TestFlight/Play internal → human store promotion → OTA-driven iteration gated by the health insights.
