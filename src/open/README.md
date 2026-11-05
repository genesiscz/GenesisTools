# open

Opens files, folders and URLs the way macOS `open` does, and logs every open with the agent that asked for it: the
harness, the session id and title, the project, the branch and the commit. It is the same stamp the question and
answer log keeps (`whoIsCallingHere` with `STAMP_FACETS`).

```bash
tools open notes.md                      # open with the default app
tools open -a Cursor src/index.ts        # open -a
tools open -R ~/Downloads/report.pdf     # reveal in Finder
tools open -g https://example.org/ --why "the docs the user asked for"
tools open log                           # the newest opens, with agent and session
tools open log --session a7346bf7 --json
```

The log is `~/.genesis-tools/open/opens.jsonl`, one JSON record per open (targets with their kind and absolute path,
the `open` argv, the exit code, `why`, and `caller`). A file literally named `log` is opened as `./log`.
