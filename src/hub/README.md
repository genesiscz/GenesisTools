# tools hub

The GenesisTools.app agent hub. `tools hub` opens the hub window (it builds the app when it is missing or older than its Swift sources); the subcommands are its data doors (`tools hub --help` lists them).

## Open the hub at a place

    tools hub                                        # the hub window; a running hub comes forward instead
    tools hub open --mode prs                        # sessions|worktrees|prs|inbox|timeline|agents
    tools hub open --session <id or prefix> --tab changes
    tools hub open --pr owner/repo#42                # a PR or MR: 42, owner/repo#42, group/app!12, or its page URL
    tools hub open --pr owner/repo#42 --reveal src/x.ts      # that file in the PR's review
    tools hub open --pr owner/repo#42 --commit 4e7a3bc       # that commit selected in the PR's review
    tools hub open --repo owner/repo --commit 4e7a3bc        # a commit with no PR, in its project's diff
    tools hub open --repo /path/to/checkout --commit 4e7a3bc
    tools hub open --worktree /path/to/checkout      # the Worktrees mode on that checkout
    tools hub open --no-activate                     # open behind the window in front, without focus

`--commit` takes 7 to 40 hex characters; a prefix is enough, because the hub matches it against the PR's full shas. The PR and repository forms have these separate outcomes:

| Link inputs | Outcome |
| --- | --- |
| `pr` + `commit`, commit belongs to the PR | Select that commit in the PR diff. |
| `pr` + `commit`, commit absent from the PR | Show the whole PR and a missing-commit notice. |
| `repo` + `commit` | Open the commit in the project's Worktrees diff. |

A missing PR commit does not trigger a project-diff lookup. To open that commit in its project instead, use `--repo` with `--commit` and omit `--pr`.

`--repo` names an absolute checkout path, an explicit relative checkout path (`.`, `./app`, `../app`), or a forge path (`owner/repo`, `group/sub/app`). Relative checkout paths are resolved by the CLI; forge paths are mapped to checkouts under the repo roots (`tools hub pr projects`).

Other `open` flags: `--agent`, `--filter`, `--palette [text]`, `--find [text]`, `--session-search [text]`, `--digest`, `--rules`, `--prompts`, `--handoff`, `--no-build` (`tools hub open --help`).

## History: Back, Forward and who went where

The hub keeps a log of every place it showed, with who took it there: `user` (a click, a key or a menu in the hub), `agent`, or `link` (a link or `tools hub open` that named nobody). An agent adds why. The top-left arrows (⌘[ and ⌘]) walk it, and the clock button beside them (⌘Y) lists it, newest first; a click hops to any entry. A new place never replaces the old one: Back always returns.

**Agents open things with `nav open`, not `open`**, so the person sees why and can go back:

    tools hub nav open '#563' --note "the PR whose Swift suite fails"
    tools hub nav open --repo /path/to/checkout --commit 4e7a3bc --note "the commit that moved the focus"
    tools hub nav open 'genesis-tools://hub?pr=owner%2Frepo%2342&commit=4e7a3bc' --note "why"
    tools hub nav list [--json] [--limit 20]

`nav open` takes a hub link, a PR ref or page, a commit sha (with `--pr` or `--repo`), a checkout folder, or the `open` flags. It records the entry in the hub's own database (`~/.genesis-tools/hub/data.db`, one file for every hub feature: a new one adds its migrations to `src/hub/lib/data-db.ts`), then opens the hub on it. `--actor` defaults to `agent` inside an agent session (its id goes in as `--from`), else `link`. Settings → Hub → History sets how many places are kept (200) and whether an agent's place is shown at once (the default) or only added to History. Every entry writes one `hub nav:` line to the day log.

## Links

`--print-url` prints the link for the same flags instead of opening:

    tools hub open --print-url --pr 'owner/repo#42' --commit 4e7a3bc
    # genesis-tools://hub?pr=owner%2Frepo%2342&commit=4e7a3bc

A `genesis-tools://hub?…` link opens the hub where it points, with or without the browser router. Its keys are the `open` flags without dashes: `mode`, `session`, `agent`, `pr`, `reveal`, `commit`, `repo`, `tab`, `filter`, `worktree`, `decision`, `question`, and for the history `actor` (user, agent, link), `note`, `from` (the agent's session) and `nav` (an entry `nav open` stored) (`HubRequest.linkKeys` in `src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubWindow.swift`). Every other key is dropped: a link shows a place, it never runs a command. The `#` of a PR ref must be written `%23`.

Through the browser router, the same query on the link host opens the hub as well, so a terminal or a chat that only makes `https://` clickable works too:

    tools browser-router presets enable genesis-hub
    # https://<link host>/hub?pr=owner%2Frepo%2342&commit=4e7a3bc  ->  genesis-tools://hub?pr=owner%2Frepo%2342&commit=4e7a3bc
