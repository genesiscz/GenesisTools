# DevDashboard Mobile — Appium E2E

Appium + WebdriverIO end-to-end tests for the Expo SDK 55 dev-client app (D21). Page Objects
(POM) + one spec per feature, so an agent can iterate autonomously. Units stay in `bun:test`
(`src/**/*.test.ts`); this folder is the device-level suite.

> **Device-only.** These specs drive a real iOS Simulator / Android Emulator through an Appium
> server. They are NOT run by an agent in a headless sandbox — you author them here, then run
> them on a machine with Xcode / Android SDK + a booted device. CI wiring is out of scope.

## Layout

```
e2e/
  wdio.conf.ts            # runner config: capabilities, timeouts, spec glob
  tsconfig.json           # e2e-only TS config (paths: @e2e/* → e2e/*)
  pages/
    base.page.ts          # BasePage — find-by-a11y-id, waitForVisible, tap, type, getText,
                          #   scrollIntoView, retry, waitUntil. Every page object extends this.
    app.page.ts           # AppPage (appPage) — native tab bar + tab screen roots
    ConnectPage.page.ts   # ConnectPage (connectPage) — the connect / pair gate
    PulsePage.page.ts     # PulsePage (pulsePage) — the Pulse home tab (D32 reference)
  specs/
    smoke.spec.ts         # app boots → native tabs render
    connect.spec.ts       # tier picker, reachability probe, deep-linked pairing
    pulse.spec.ts         # KPIs/charts/cards render + live CPU reading updates
```

Locators are **accessibility ids** (`~id` via `BasePage.byId`). In RN a component's `testID`
becomes the iOS `accessibilityIdentifier` / Android `resource-id`, which Appium's `~` selector
resolves — so `<View testID="screen-pulse">` is found by `~screen-pulse`. Native tab-bar buttons
are OS-rendered with no testID, so `AppPage` locates them by their visible label (`~Pulse`).

## Prerequisites (one-time, on the device machine)

- **iOS:** macOS + Xcode + the iOS Simulator runtime. Appium's `XCUITest` driver is already a
  devDependency (`appium-xcuitest-driver`).
- **Android (opt-in):** Android SDK + an AVD. **The `UiAutomator2` Appium driver is NOT installed**
  (Expo-first / D20 — ask before adding the dep). To enable Android:
  `appium driver install uiautomator2`. iOS is the default lane so this never blocks an iOS run.

## 1. Build the dev-client

The app uses the New Architecture + a custom dev-client (D3) — **not Expo Go**. Build a native app
once, then point the runner at the binary:

```bash
# iOS Simulator (.app)
bun expo run:ios            # → ios/build/Build/Products/Debug-iphonesimulator/mobile.app

# Android Emulator (.apk)
bun expo run:android        # → android/app/build/outputs/apk/debug/app-debug.apk
```

(`bun run e2e:build` builds the iOS Release config if you want a release-mode binary.)

## 2. Point the runner at the binary

The app path is never hardcoded — supply it via `DD_APP_PATH`:

```bash
export DD_APP_PATH="$(pwd)/ios/build/Build/Products/Debug-iphonesimulator/mobile.app"
```

## 3. Start the Appium server (separate shell)

```bash
bun run e2e:appium          # starts Appium on :4723
```

## 4. Run the specs

```bash
bun run e2e                 # wdio run e2e/wdio.conf.ts (all specs, iOS default)
```

To run on Android instead:

```bash
DD_PLATFORM=android \
DD_APP_PATH="$(pwd)/android/app/build/outputs/apk/debug/app-debug.apk" \
  bun run e2e
```

## Environment variables

| Var             | Default                            | Meaning                                            |
| --------------- | ---------------------------------- | -------------------------------------------------- |
| `DD_APP_PATH`   | _(empty)_                          | Path to the built `.app` / `.apk` under test.      |
| `DD_PLATFORM`   | `ios`                              | `android` to switch to the Android emulator cap.   |
| `DD_SIM_DEVICE` | `iPhone 16`                        | iOS simulator device name.                         |
| `DD_SIM_OS`     | `18.2`                             | iOS platform version.                              |
| `DD_AVD`        | `Pixel_7_API_34`                   | Android AVD / device name.                         |
| `DD_EMU_OS`     | `14`                               | Android platform version.                          |
| `DD_BUNDLE_ID`  | `dev.genesistools.devdashboard`    | Bundle id used by the deep-link pairing helper.    |

## The connect gate (every feature spec needs this)

The app boots into `/connect` whenever no `baseUrl` is stored (root `Stack.Protected guard`), so a
spec that drives any tab must clear the gate first. The simulator has no camera, so pairing is done
by **deep-linking a pairing URI** rather than scanning a QR. Use the canonical helper:

```ts
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { appPage } from "@e2e/pages/app.page";

before(async () => {
    if (await connectPage.isShown()) {
        await connectPage.pairWithTestAgent();   // selects a tier, deep-links, waits reachable, taps Continue
    }

    await appPage.openTab("Terminals");          // then land on your feature's tab (Pulse|Terminals|QA|Obsidian|More)
});
```

`pairWithTestAgent()` targets `http://127.0.0.1:3042` by default — a **test Agent must be running**
there with auth satisfied (an empty password 401s the probe). See the plan-04 note in
`DevDashboard/research/13-impl-04-notes.md`.

## Adding a feature's Page Object + spec

1. Make the screen testable: every interactive element and screen root gets a stable `testID`
   (and/or `accessibilityLabel`). Prefer `screen-<feature>` for the root and `<feature>-<thing>`
   for controls. Connect/Pulse already do this — copy the style.
2. `e2e/pages/<Feature>Page.page.ts`:

   ```ts
   import { BasePage } from "@e2e/pages/base.page";

   class TerminalsPage extends BasePage {
       async isShown(): Promise<boolean> {
           await this.waitForVisible("screen-terminals");
           return this.isVisible("screen-terminals");
       }
       // lean on inherited helpers: this.tap(id), this.type(id, text), this.getText(id),
       // this.scrollIntoView(id), this.retry(fn), this.waitUntil(cond)
   }

   export const terminalsPage = new TerminalsPage();
   ```
3. `e2e/specs/<feature>.spec.ts`: clear the connect gate in `before()` (snippet above), open the
   tab, then assert via your page object. Mocha BDD (`describe`/`it`), `expect-webdriverio`.
4. Import via the `@e2e/*` alias only (e2e tsconfig has no `@/` or `@dd/` paths). No `as any`.
5. Type-gate: `bunx tsc -p e2e/tsconfig.json --noEmit` must be 0 errors.

> The `BasePage` public API (`byId`, `waitForVisible`, `isVisible`, `tap`, `type`, `getText`,
> `scrollIntoView`, `retry`, `waitUntil`, …) is **append-only** — feature page objects depend on
> these signatures. Add helpers; do not rename or re-signature the existing ones.
