# Optional evidence publishing

Keep screenshots and recordings local unless the user asks to share or annotate them. Native Computer Use, Peekaboo and `tools control` all work without a Vitrinka connection.

When publishing is requested, use the installed Vitrinka publish/screenshot skill and its current CLI help or MCP schemas. Pass an already inspected image or recording artifact; verify that it contains the intended app/window and no unrelated personal UI. Preserve any redaction requested by the user.

The recording runner's optional publishing fields are documented by `tools control capture --help`. Its action and motion warnings still apply: uploading a picture does not validate the action that was meant to produce it.

Relay the URL returned by the server or publishing tool. Do not construct a board URL from a guessed slug, and do not silently switch from local review to uploading screenshots.