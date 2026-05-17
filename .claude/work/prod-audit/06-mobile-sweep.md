# C8 — Mobile / Responsive Sweep Report

**Date:** 2026-05-17
**frontend-design skill:** invoked (dark/neon/mono aesthetic preserved — only layout/responsive props changed, no restyle).

## Viewport matrix (target)

| Label | W×H | Represents |
|---|---|---|
| phone-se | 375×667 | iPhone SE (shortest common) |
| phone-sm | 360×800 | small Android |
| phone-ios | 390×844 | iPhone 14/15 |
| tablet | 768×1024 | iPad mini portrait |
| desktop | 1280×800 | laptop regression |

## Code fixes applied (audit P2 mobile findings)

1. **PlannerTimeline** `touchAction: "none"` → `"pan-y"` (`-planner/PlannerTimeline.tsx`). The 1440px-tall timeline was completely unscrollable on touch. dnd-kit's `TouchSensor` already has a 200ms press-delay activation constraint (`usePlannerDnd.ts`), so an intentional drag still wins while a tap-scroll now passes through.
2. **Planner panels** `flex gap-3` + fixed `minHeight` → `flex flex-col gap-3 md:min-h-[calc(100vh-220px)] md:flex-row` (`planner.tsx`). Stacks vertically on mobile (was horizontal overflow < 640px); the fixed min-height only applies at `md:`.
3. **PlannerInbox** `w-72 shrink-0` → `w-full shrink-0 md:w-72` — full-width inbox when stacked on mobile, fixed 18rem column at `md:`+.
4. **AI page** `h-[calc(100vh-8rem)]` → `h-[calc(100dvh-8rem)]` + added `min-h-0` to the flex chat column (`dashboard/ai.tsx`). `dvh` shrinks with the mobile keyboard/chrome so the composer is no longer clipped; `min-h-0` lets the message list scroll instead of pushing the composer off-screen.
5. **Timer popout** `window.open(...)` now captures the return; on `null` (popup blocked — the default on mobile) it `toast.info`s and `navigate`s to `/timer/$timerId` in-tab instead of failing silently (`timer/index.tsx`).

## Live playwright-mcp verification (this run)

Dev server booted (Vite 7.3.1, :3000). Verified at **375×667** and **768×1024**:

- `/` → auth redirect → `/auth/signin`: **no horizontal overflow** (375: scrollW==clientW==367; 768: 768==768), no console errors/warnings (only benign React-DevTools info).

**Limitation (transparent):** `/dashboard/planner`, `/dashboard/ai`, `/timer` and all `/dashboard/*` + `/assistant/*` routes are auth-gated (`requireAuthBeforeLoad` → WorkOS). A full authenticated visual matrix sweep requires interactive WorkOS login, which automated tooling cannot perform in this run (no test credentials; signing in via the bot is out of scope and unsafe). The 5 fixes are **deterministic CSS/layout prop changes**, verified statically: scoped `tsc` (exit 0) + biome clean + the production `build:prod` gate green. Each maps 1:1 to a concrete audit finding with a known-correct Tailwind/`dvh`/`touch-action` remedy.

**Recommended follow-up (one-time, by a human with a session):** run the full route×matrix sweep logged-in — `browser_resize` per matrix row, `browser_navigate` each protected route, assert `documentElement.scrollWidth <= clientWidth+1` + no console errors. The harness for this is trivial now that the fixes are in; it is a verification step, not new work.
