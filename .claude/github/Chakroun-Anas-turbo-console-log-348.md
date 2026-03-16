# Issue #348: Abnormal RAM/CPU usage with typescript-go preview

**URL:** [https://github.com/Chakroun-Anas/turbo-console-log/issues/348](https://github.com/Chakroun-Anas/turbo-console-log/issues/348)
**Repository:** Chakroun-Anas/turbo-console-log
**State:** open | **Author:** @GGomez99
**Created:** 2026-03-02 10:10 | **Updated:** 2026-03-10 20:03
**Reactions:** 👍 1 · 👀 1
**Labels:** bug, discussion, high-priority, missing-infos
**Assignees:** @Chakroun-Anas

## Index

| Section | Lines | Date Range |
|---------|-------|------------|
| Description | 15-38 | 02.03.2026 11:10 |
| Comments | 40-56 | 10.03.2026 00:13 → 10.03.2026 21:03 |

---

## Description

**Describe the bug**
When having the `typescriptteam.native-preview` extension alongside turbo console log, the typescript-go process starts consuming lots of resources (RAM/CPU) for no reasons on large repos.

**Steps to reproduce**
- Install `typescriptteam.native-preview`
- Install `chakrounanas.turbo-console-log`
- Open any large typescript repo, like these ones: https://github.com/microsoft/TypeScript or https://github.com/microsoft/typescript-go/
- The `tsgo` process usually takes about 150MB, but in this case, it takes more than 20GB
- If you check the output for `typescript-native-preview`, you can see a bunch of `didOpen`requests sent to the typescript LSP even when I only have 1 file opened in the IDE:

<img width="1512" height="888" alt="Image" src="https://github.com/user-attachments/assets/71988df4-3d0d-497a-b786-59ea01c3098c" />

**Expected behavior**
Having 1 file opened should only send 1 `didOpen` request to the ts-go LSP, and the latter shouldn't consume lots of resources

**Context:**
 - OS name and version: macOS 26.3 (25D125)
 - VSCode version: 1.109.5
 - Extension version: 3.17.0


---

## Comments (2 total, showing 2)

**Date Range:** 2026-03-09 23:13 → 2026-03-10 20:03

### Comment 1 — @Chakroun-Anas · [2026-03-09 23:13](https://github.com/Chakroun-Anas/turbo-console-log/issues/348#issuecomment-4027526223)

Hi @GGomez99

Thank you for the report!

After investigating, I tried to reproduce the `textDocument/didOpen` flood with Turbo Console Log disabled and the events still appear. This suggests those requests are not originating from Turbo.

Could you double-check on your end by disabling Turbo and confirming whether the flood persists? If it does, the issue likely lies elsewhere.

### Comment 2 — @Spookywy · [2026-03-10 20:03](https://github.com/Chakroun-Anas/turbo-console-log/issues/348#issuecomment-4034105107)

I encountered the same issue and can confirm that uninstalling the extension resolved it.
After reinstalling the extension, the abnormal RAM and CPU usage returned.

---
_Fetched: 2026-03-11T22:56:50.434Z_