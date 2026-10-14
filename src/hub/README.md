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

`--commit` takes 7 to 40 hex characters; a prefix is enough, because the hub matches it against the PR's full shas. With `--pr`, the hub opens the PR, selects that commit in the commit list and shows it in the diff; a commit the PR does not hold is reported, and the whole PR shows. Without a PR, `--repo` names the commit's project: an absolute checkout path, or its forge path (`owner/repo`, `group/sub/app`), which the hub maps to the checkout under the repo roots (`tools hub pr projects`).

Other `open` flags: `--agent`, `--filter`, `--palette [text]`, `--find [text]`, `--session-search [text]`, `--digest`, `--rules`, `--prompts`, `--handoff`, `--no-build` (`tools hub open --help`).

## Links

`--print-url` prints the link for the same flags instead of opening:

    tools hub open --print-url --pr 'owner/repo#42' --commit 4e7a3bc
    # genesis-tools://hub?pr=owner%2Frepo%2342&commit=4e7a3bc

A `genesis-tools://hub?…` link opens the hub where it points, with or without the browser router. Its keys are the `open` flags without dashes: `mode`, `session`, `agent`, `pr`, `reveal`, `commit`, `repo`, `tab`, `filter`, `worktree`, `decision`, `question` (`HubRequest.linkKeys` in `src/macos/GenesisTools/Sources/Hub/HubWindow.swift`). Every other key is dropped: a link shows a place, it never runs a command. The `#` of a PR ref must be written `%23`.

Through the browser router, the same query on the link host opens the hub as well, so a terminal or a chat that only makes `https://` clickable works too:

    tools browser-router presets enable genesis-hub
    # https://<link host>/hub?pr=owner%2Frepo%2342&commit=4e7a3bc  ->  genesis-tools://hub?pr=owner%2Frepo%2342&commit=4e7a3bc
