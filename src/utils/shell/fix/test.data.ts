/**
 * Test data for shell command fixer implementations.
 *
 * Each entry has:
 *   - name: human description
 *   - input: broken command as copied from terminal / Claude output
 *   - expected: the correct, runnable command
 *   - tags: categories for filtering
 */

export interface TestCase {
    name: string;
    input: string;
    expected: string;
    expectedPretty: string;
    tags: string[];
}

export const testCases: TestCase[] = [
    // ═══════════════════════════════════════════════════════════════════
    // 1. BROKEN BACKSLASH CONTINUATIONS (trailing whitespace after \)
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "simple \\ continuation with trailing spaces",
        input: "echo hello \\   \n  world",
        expected: "echo hello world",
        expectedPretty: "echo hello world",
        tags: ["continuation", "basic"],
    },
    {
        name: "multiple \\ continuations with varying trailing spaces",
        input: 'tools claude history "test" \\\n        --sort-relevance \\\n        --since "2026-03-20" \\\n        -c 5 --all',
        expected: 'tools claude history "test" --sort-relevance --since "2026-03-20" -c 5 --all',
        expectedPretty:
            'tools claude history "test" \\\n  --sort-relevance \\\n  --since "2026-03-20" -c 5 \\\n  --all',
        tags: ["continuation", "flags"],
    },
    {
        name: "\\ continuation with tabs after backslash",
        input: 'curl -X POST \\\t\t\n  https://api.example.com/v1/data \\\t\n  -H "Content-Type: application/json"',
        expected: 'curl -X POST https://api.example.com/v1/data -H "Content-Type: application/json"',
        expectedPretty: 'curl -X POST https://api.example.com/v1/data -H "Content-Type: application/json"',
        tags: ["continuation", "tabs"],
    },
    {
        name: "\\ continuation with mixed tabs and spaces",
        input: "docker run \\ \t \n  --name mycontainer \\ \t\n  --network host \\\n  -v /data:/data \\\n  nginx:latest",
        expected: "docker run --name mycontainer --network host -v /data:/data nginx:latest",
        expectedPretty: "docker run \\\n  --name mycontainer \\\n  --network host -v /data:/data nginx:latest",
        tags: ["continuation", "docker"],
    },
    {
        name: "long command with many \\ continuations",
        input: [
            "kubectl get pods \\",
            "  --namespace production \\",
            "  --field-selector status.phase=Running \\",
            "  --sort-by .metadata.creationTimestamp \\",
            "  -o wide \\",
            "  --no-headers \\",
            "  --show-labels",
        ].join("\n"),
        expected:
            "kubectl get pods --namespace production --field-selector status.phase=Running --sort-by .metadata.creationTimestamp -o wide --no-headers --show-labels",
        expectedPretty:
            "kubectl get pods \\\n  --namespace production \\\n  --field-selector status.phase=Running \\\n  --sort-by .metadata.creationTimestamp -o wide \\\n  --no-headers \\\n  --show-labels",
        tags: ["continuation", "many-flags"],
    },
    {
        name: "\\ with CRLF line endings",
        input: "echo hello \\\r\n  world \\\r\n  foo",
        expected: "echo hello world foo",
        expectedPretty: "echo hello world foo",
        tags: ["continuation", "crlf"],
    },
    {
        name: "\\ continuation with excessive indentation",
        input: 'make \\\n                    -j8 \\\n                    CFLAGS="-O2" \\\n                    all',
        expected: 'make -j8 CFLAGS="-O2" all',
        expectedPretty: 'make -j8 CFLAGS="-O2" all',
        tags: ["continuation", "indentation"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 2. FLATTENED CONTINUATIONS (\ + spaces on same line)
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "flattened \\ continuation — terminal replaced newline with spaces",
        input: "cd col-mobile && \\                                              APP_ENV=test yarn expo run:ios",
        expected: "cd col-mobile && APP_ENV=test yarn expo run:ios",
        expectedPretty: "cd col-mobile && APP_ENV=test yarn expo run:ios",
        tags: ["flattened", "basic"],
    },
    {
        name: "multiple flattened continuations on one line",
        input: "rm -rf dist && \\            mkdir dist && \\            cp -r src/* dist/",
        expected: "rm -rf dist && mkdir dist && cp -r src/* dist/",
        expectedPretty: "rm -rf dist && mkdir dist && cp -r src/* dist/",
        tags: ["flattened", "chain"],
    },
    {
        name: "flattened continuation mixed with real newlines",
        input: "cd col-mobile && \\                                              APP_ENV=test ENVFILE=.env yarn expo run:ios \\\n    2>&1 | tee /tmp/new-ios.log && \\\n    cd ..",
        expected: "cd col-mobile && APP_ENV=test ENVFILE=.env yarn expo run:ios 2>&1 | tee /tmp/new-ios.log && cd ..",
        expectedPretty:
            "cd col-mobile && APP_ENV=test ENVFILE=.env yarn expo run:ios 2>&1 | tee /tmp/new-ios.log && cd ..",
        tags: ["flattened", "mixed"],
    },
    {
        name: "flattened with only 2 spaces (borderline — should still fix)",
        input: "echo hello \\  world",
        expected: "echo hello world",
        expectedPretty: "echo hello world",
        tags: ["flattened", "borderline"],
    },
    {
        name: "legitimate escaped space preserved (1 space only)",
        input: "cd my\\ folder",
        expected: "cd my\\ folder",
        expectedPretty: "cd my\\ folder",
        tags: ["flattened", "preserve-escape"],
    },
    {
        name: "flattened with duplicate content from terminal copy",
        input: "yarn expo run:ios \\                 yarn expo run:ios 2>&1 | tee /tmp/log",
        expected: "yarn expo run:ios yarn expo run:ios 2>&1 | tee /tmp/log",
        expectedPretty: "yarn expo run:ios yarn expo run:ios 2>&1 | tee /tmp/log",
        tags: ["flattened", "duplicate"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 3. TERMINAL-WRAPPED PATHS (long paths broken by terminal width)
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "path split at terminal width — word boundary",
        input: "rm -rf /Users/Martin/Tresors/Projects/ClaudeCode/npm-claude-code/vendor && cp -r ~/.bun/install/global/node_modules/@anthropic-ai/claude-code/vendor\n  /Users/Martin/Tresors/Projects/ClaudeCode/npm-claude-code/vendor",
        expected:
            "rm -rf /Users/Martin/Tresors/Projects/ClaudeCode/npm-claude-code/vendor && cp -r ~/.bun/install/global/node_modules/@anthropic-ai/claude-code/vendor /Users/Martin/Tresors/Projects/ClaudeCode/npm-claude-code/vendor",
        expectedPretty:
            "rm -rf /Users/Martin/Tresors/Projects/ClaudeCode/npm-claude-code/vendor && cp -r ~/.bun/install/global/node_modules/@anthropic-ai/claude-code/vendor /Users/Martin/Tresors/Projects/ClaudeCode/npm-claude-code/vendor",
        tags: ["terminal-wrap", "paths"],
    },
    {
        name: "path split mid-UUID",
        input: "tail -5\n  /private/tmp/claude-502/-Users-Martin-Projects/2\n  b54e169-f26a-4e53-8c7b-5b58c4089d30/tasks/a4660ef.output\n  2>/dev/null",
        expected:
            "tail -5 /private/tmp/claude-502/-Users-Martin-Projects/2b54e169-f26a-4e53-8c7b-5b58c4089d30/tasks/a4660ef.output 2>/dev/null",
        expectedPretty:
            "tail -5 /private/tmp/claude-502/-Users-Martin-Projects/2b54e169-f26a-4e53-8c7b-5b58c4089d30/tasks/a4660ef.output 2>/dev/null",
        tags: ["terminal-wrap", "uuid", "redirect"],
    },
    {
        name: "path split mid-hash",
        input: "git show abc123\n  def456789",
        expected: "git show abc123def456789",
        expectedPretty: "git show abc123def456789",
        tags: ["terminal-wrap", "mid-word"],
    },
    {
        name: "path split at slash boundary — new arg starts with /",
        input: "cp source.txt\n  /destination/path/file.txt",
        expected: "cp source.txt /destination/path/file.txt",
        expectedPretty: "cp source.txt /destination/path/file.txt",
        tags: ["terminal-wrap", "slash-boundary"],
    },
    {
        name: "path split at tilde — new arg starts with ~",
        input: "cp source.txt\n  ~/destination/path/file.txt",
        expected: "cp source.txt ~/destination/path/file.txt",
        expectedPretty: "cp source.txt ~/destination/path/file.txt",
        tags: ["terminal-wrap", "tilde"],
    },
    {
        name: "path with spaces and wrapping",
        input: "cat /very/long/path/to/some/deeply/nested/directory/structure/that/exceeds/terminal/width/fi\n  le.txt",
        expected: "cat /very/long/path/to/some/deeply/nested/directory/structure/that/exceeds/terminal/width/file.txt",
        expectedPretty:
            "cat /very/long/path/to/some/deeply/nested/directory/structure/that/exceeds/terminal/width/file.txt",
        tags: ["terminal-wrap", "mid-word"],
    },
    {
        name: "multiple args wrapped at terminal width",
        input: "diff\n  /Users/Martin/Tresors/Projects/GenesisTools/src/utils/format.ts\n  /Users/Martin/Tresors/Projects/GenesisTools/src/utils/string.ts",
        expected:
            "diff /Users/Martin/Tresors/Projects/GenesisTools/src/utils/format.ts /Users/Martin/Tresors/Projects/GenesisTools/src/utils/string.ts",
        expectedPretty:
            "diff /Users/Martin/Tresors/Projects/GenesisTools/src/utils/format.ts /Users/Martin/Tresors/Projects/GenesisTools/src/utils/string.ts",
        tags: ["terminal-wrap", "multiple-paths"],
    },
    {
        name: "command with trailing spaces then wrapped path",
        input: "cat                                                         \n  /private/tmp/file.txt",
        expected: "cat /private/tmp/file.txt",
        expectedPretty: "cat /private/tmp/file.txt",
        tags: ["terminal-wrap", "trailing-spaces"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 4. REDIRECTIONS (2>/dev/null, 2>&1, etc.)
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "2>/dev/null on next line — not mid-word",
        input: "some-command --flag value\n  2>/dev/null",
        expected: "some-command --flag value 2>/dev/null",
        expectedPretty: "some-command \\\n  --flag value 2>/dev/null",
        tags: ["redirect", "basic"],
    },
    {
        name: "2>&1 on next line",
        input: "make all\n  2>&1 | tee build.log",
        expected: "make all 2>&1 | tee build.log",
        expectedPretty: "make all 2>&1 | tee build.log",
        tags: ["redirect", "pipe"],
    },
    {
        name: "stdout redirect on next line",
        input: "echo data\n  > /tmp/output.txt",
        expected: "echo data > /tmp/output.txt",
        expectedPretty: "echo data > /tmp/output.txt",
        tags: ["redirect", "stdout"],
    },
    {
        name: "append redirect on next line",
        input: "echo data\n  >> /tmp/output.txt",
        expected: "echo data >> /tmp/output.txt",
        expectedPretty: "echo data >> /tmp/output.txt",
        tags: ["redirect", "append"],
    },
    {
        name: "stdin redirect on next line",
        input: "wc -l\n  < /tmp/input.txt",
        expected: "wc -l < /tmp/input.txt",
        expectedPretty: "wc -l < /tmp/input.txt",
        tags: ["redirect", "stdin"],
    },
    {
        name: "fd3 redirect on next line",
        input: "command\n  3>/tmp/fd3.log",
        expected: "command 3>/tmp/fd3.log",
        expectedPretty: "command 3>/tmp/fd3.log",
        tags: ["redirect", "fd3"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 5. BASH() WRAPPER (Claude Code output)
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "single-line Bash() wrapper",
        input: "Bash(echo hello world)",
        expected: "echo hello world",
        expectedPretty: "echo hello world",
        tags: ["bash-wrapper", "single-line"],
    },
    {
        name: "multi-line Bash() wrapper with indentation",
        input: "Bash(# Build project\n      npm run build\n      npm test)",
        expected: "# Build project\nnpm run build\nnpm test",
        expectedPretty: "# Build project\nnpm run build\nnpm test",
        tags: ["bash-wrapper", "multi-line"],
    },
    {
        name: "Bash() with command containing parens",
        input: "Bash(echo $(date) && ls)",
        expected: "echo $(date) && ls",
        expectedPretty: "echo $(date) && ls",
        tags: ["bash-wrapper", "nested-parens"],
    },
    {
        name: "Bash() wrapper with flags — should get re-split",
        input: 'Bash(tools claude history --sort-relevance --since "2026-03-20" -c 5)',
        expected: 'tools claude history --sort-relevance --since "2026-03-20" -c 5',
        expectedPretty: 'tools claude history \\\n  --sort-relevance \\\n  --since "2026-03-20" -c 5',
        tags: ["bash-wrapper", "flags"],
    },
    {
        name: "Bash() wrapper with indented script",
        input: "Bash(cd /tmp\n      mkdir -p test\n      cd test\n      echo done)",
        expected: "cd /tmp\nmkdir -p test\ncd test\necho done",
        expectedPretty: "cd /tmp\nmkdir -p test\ncd test\necho done",
        tags: ["bash-wrapper", "script"],
    },
    {
        name: "Bash() with nested parentheses in subshell",
        input: "Bash(VAR=$(echo $(hostname)))",
        expected: "VAR=$(echo $(hostname))",
        expectedPretty: "VAR=$(echo $(hostname))",
        tags: ["bash-wrapper", "nested-parens-deep"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 6. PIPES AND COMPOUND COMMANDS
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "pipe broken across lines",
        input: "cat /tmp/log.txt\n  | grep error\n  | head -20",
        expected: "cat /tmp/log.txt | grep error | head -20",
        expectedPretty: "cat /tmp/log.txt | grep error | head -20",
        tags: ["pipe", "basic"],
    },
    {
        name: "double-ampersand broken across lines",
        input: "cd project\n  && npm install\n  && npm test",
        expected: "cd project && npm install && npm test",
        expectedPretty: "cd project && npm install && npm test",
        tags: ["compound", "and"],
    },
    {
        name: "double-pipe broken across lines",
        input: "command1\n  || command2\n  || command3",
        expected: "command1 || command2 || command3",
        expectedPretty: "command1 || command2 || command3",
        tags: ["compound", "or"],
    },
    {
        name: "semicolons broken across lines",
        input: "cd /tmp\n  ; ls\n  ; pwd",
        expected: "cd /tmp ; ls ; pwd",
        expectedPretty: "cd /tmp ; ls ; pwd",
        tags: ["compound", "semicolons"],
    },
    {
        name: "complex pipeline with all operators",
        input: "find . -name '*.ts' \\\n  | xargs grep -l 'TODO' \\\n  | sort \\\n  | head -10 2>/dev/null",
        expected: "find . -name '*.ts' | xargs grep -l 'TODO' | sort | head -10 2>/dev/null",
        expectedPretty: "find . -name '*.ts' | xargs grep -l 'TODO' | sort | head -10 2>/dev/null",
        tags: ["pipe", "continuation", "complex"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 7. QUOTED STRINGS (should not be broken)
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "double-quoted string with escaped pipes",
        input: 'tools claude history "content loader\\|ContentLoader\\|viewBox" \\\n  --sort-relevance',
        expected: 'tools claude history "content loader\\|ContentLoader\\|viewBox" --sort-relevance',
        expectedPretty: 'tools claude history "content loader\\|ContentLoader\\|viewBox" \\\n  --sort-relevance',
        tags: ["quotes", "double", "continuation"],
    },
    {
        name: "single-quoted string preserved",
        input: "grep -r 'function\\s+\\w+' \\\n  --include='*.ts' \\\n  src/",
        expected: "grep -r 'function\\s+\\w+' --include='*.ts' src/",
        expectedPretty: "grep -r 'function\\s+\\w+' \\\n  --include='*.ts' src/",
        tags: ["quotes", "single", "continuation"],
    },
    {
        name: "mixed quotes",
        input: "echo \"hello 'world'\" \\\n  'and \"goodbye\"'",
        expected: "echo \"hello 'world'\" 'and \"goodbye\"'",
        expectedPretty: "echo \"hello 'world'\" 'and \"goodbye\"'",
        tags: ["quotes", "mixed"],
    },
    {
        name: "quoted string with spaces (should not collapse internal spaces)",
        input: 'echo "hello   world   with   spaces"',
        expected: 'echo "hello   world   with   spaces"',
        expectedPretty: 'echo "hello   world   with   spaces"',
        tags: ["quotes", "preserve-spaces"],
    },
    {
        name: "empty quotes preserved",
        input: "echo \"\" ''",
        expected: "echo \"\" ''",
        expectedPretty: "echo \"\" ''",
        tags: ["quotes", "empty"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 8. ENVIRONMENT VARIABLES AND ASSIGNMENTS
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "env vars before command with continuation",
        input: "APP_ENV=test \\\n  ENVFILE=.env \\\n  yarn expo run:ios",
        expected: "APP_ENV=test ENVFILE=.env yarn expo run:ios",
        expectedPretty: "APP_ENV=test ENVFILE=.env yarn expo run:ios",
        tags: ["env-vars", "continuation"],
    },
    {
        name: "env var with $ expansion",
        input: "PATH=$HOME/bin:$PATH \\\n  LD_LIBRARY_PATH=/usr/local/lib \\\n  ./my-program",
        expected: "PATH=$HOME/bin:$PATH LD_LIBRARY_PATH=/usr/local/lib ./my-program",
        expectedPretty: "PATH=$HOME/bin:$PATH LD_LIBRARY_PATH=/usr/local/lib ./my-program",
        tags: ["env-vars", "expansion"],
    },
    {
        name: "export with continuation",
        input: "export \\\n  FOO=bar \\\n  BAZ=qux",
        expected: "export FOO=bar BAZ=qux",
        expectedPretty: "export FOO=bar BAZ=qux",
        tags: ["env-vars", "export"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 9. SUBSHELLS AND COMMAND SUBSTITUTION
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "command substitution with continuation",
        input: 'echo "Today is $(date +%Y-%m-%d)" \\\n  >> /tmp/log.txt',
        expected: 'echo "Today is $(date +%Y-%m-%d)" >> /tmp/log.txt',
        expectedPretty: 'echo "Today is $(date +%Y-%m-%d)" >> /tmp/log.txt',
        tags: ["subshell", "continuation"],
    },
    {
        name: "backtick substitution with continuation",
        input: "echo `hostname` \\\n  >> /tmp/hosts.txt",
        expected: "echo `hostname` >> /tmp/hosts.txt",
        expectedPretty: "echo `hostname` >> /tmp/hosts.txt",
        tags: ["subshell", "backtick"],
    },
    {
        name: "process substitution",
        input: "diff <(sort file1.txt) \\\n  <(sort file2.txt)",
        expected: "diff <(sort file1.txt) <(sort file2.txt)",
        expectedPretty: "diff <(sort file1.txt) <(sort file2.txt)",
        tags: ["subshell", "process-sub"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 10. ALREADY VALID COMMANDS (should pass through unchanged)
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "single-line command — no change needed",
        input: "ls -la /tmp",
        expected: "ls -la /tmp",
        expectedPretty: "ls -la /tmp",
        tags: ["passthrough", "simple"],
    },
    {
        name: "empty string",
        input: "",
        expected: "",
        expectedPretty: "",
        tags: ["passthrough", "empty"],
    },
    {
        name: "just whitespace",
        input: "   ",
        expected: "",
        expectedPretty: "",
        tags: ["passthrough", "whitespace"],
    },
    {
        name: "single word",
        input: "ls",
        expected: "ls",
        expectedPretty: "ls",
        tags: ["passthrough", "single-word"],
    },
    {
        name: "valid pipeline — no change needed",
        input: "cat file.txt | grep error | wc -l",
        expected: "cat file.txt | grep error | wc -l",
        expectedPretty: "cat file.txt | grep error | wc -l",
        tags: ["passthrough", "pipe"],
    },
    {
        name: "valid command with quotes — no change needed",
        input: 'echo "hello world" | tee /tmp/out.txt',
        expected: 'echo "hello world" | tee /tmp/out.txt',
        expectedPretty: 'echo "hello world" | tee /tmp/out.txt',
        tags: ["passthrough", "quotes"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 11. COMPLEX REAL-WORLD COMMANDS
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "kubectl with many flags broken by terminal",
        input: "kubectl exec -it pod-name-abc123\n  def456 -n production\n  -- /bin/bash",
        expected: "kubectl exec -it pod-name-abc123def456 -n production -- /bin/bash",
        expectedPretty: "kubectl exec -it pod-name-abc123def456 -n production -- /bin/bash",
        tags: ["real-world", "terminal-wrap", "mid-word"],
    },
    {
        name: "git log with format and continuation",
        input: 'git log \\\n  --pretty=format:"%H %an %s" \\\n  --since="2026-01-01" \\\n  --until="2026-03-31" \\\n  --no-merges \\\n  -- src/',
        expected: 'git log --pretty=format:"%H %an %s" --since="2026-01-01" --until="2026-03-31" --no-merges -- src/',
        expectedPretty:
            'git log \\\n  --pretty=format:"%H %an %s" \\\n  --since="2026-01-01" \\\n  --until="2026-03-31" \\\n  --no-merges -- src/',
        tags: ["real-world", "git", "continuation"],
    },
    {
        name: "docker compose with env and continuation",
        input: "COMPOSE_PROJECT_NAME=myapp \\\n  DOCKER_BUILDKIT=1 \\\n  docker compose \\\n  -f docker-compose.yml \\\n  -f docker-compose.override.yml \\\n  up -d --build",
        expected:
            "COMPOSE_PROJECT_NAME=myapp DOCKER_BUILDKIT=1 docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --build",
        expectedPretty:
            "COMPOSE_PROJECT_NAME=myapp DOCKER_BUILDKIT=1 docker compose -f docker-compose.yml -f docker-compose.override.yml up -d \\\n  --build",
        tags: ["real-world", "docker", "env-vars"],
    },
    {
        name: "rsync with many flags and continuation",
        input: "rsync -avz \\\n  --exclude='.git' \\\n  --exclude='node_modules' \\\n  --exclude='*.log' \\\n  --progress \\\n  --delete \\\n  /source/path/ \\\n  user@host:/dest/path/",
        expected:
            "rsync -avz --exclude='.git' --exclude='node_modules' --exclude='*.log' --progress --delete /source/path/ user@host:/dest/path/",
        expectedPretty:
            "rsync -avz \\\n  --exclude='.git' \\\n  --exclude='node_modules' \\\n  --exclude='*.log' \\\n  --progress \\\n  --delete /source/path/ user@host:/dest/path/",
        tags: ["real-world", "rsync", "continuation"],
    },
    {
        name: "SSH tunnel with port forwarding",
        input: "ssh -L 8080:localhost:80 \\\n  -L 5432:db.internal:5432 \\\n  -N -f \\\n  user@bastion.example.com",
        expected: "ssh -L 8080:localhost:80 -L 5432:db.internal:5432 -N -f user@bastion.example.com",
        expectedPretty: "ssh -L 8080:localhost:80 -L 5432:db.internal:5432 -N -f user@bastion.example.com",
        tags: ["real-world", "ssh", "continuation"],
    },
    {
        name: "find + exec with complex quoting",
        input: "find /var/log \\\n  -name '*.log' \\\n  -mtime +30 \\\n  -exec gzip {} \\;",
        expected: "find /var/log -name '*.log' -mtime +30 -exec gzip {} \\;",
        expectedPretty: "find /var/log -name '*.log' -mtime +30 -exec gzip {} \\;",
        tags: ["real-world", "find", "continuation"],
    },
    {
        name: "aws CLI with JSON payload",
        input: 'aws lambda invoke \\\n  --function-name my-function \\\n  --payload \'{"key": "value"}\' \\\n  --log-type Tail \\\n  /tmp/output.json',
        expected:
            'aws lambda invoke --function-name my-function --payload \'{"key": "value"}\' --log-type Tail /tmp/output.json',
        expectedPretty:
            'aws lambda invoke \\\n  --function-name my-function \\\n  --payload \'{"key": "value"}\' \\\n  --log-type Tail /tmp/output.json',
        tags: ["real-world", "aws", "json"],
    },
    {
        name: "cd && command && cd back — compound",
        input: "cd col-mobile && \\\n    APP_ENV=test ENVFILE=.env yarn expo run:ios \\\n    2>&1 | tee /tmp/new-ios.log && \\\n    cd ..",
        expected: "cd col-mobile && APP_ENV=test ENVFILE=.env yarn expo run:ios 2>&1 | tee /tmp/new-ios.log && cd ..",
        expectedPretty:
            "cd col-mobile && APP_ENV=test ENVFILE=.env yarn expo run:ios 2>&1 | tee /tmp/new-ios.log && cd ..",
        tags: ["real-world", "compound", "redirect"],
    },
    {
        name: "tools claude history — the original broken command",
        input: 'tools claude history "content loader\\|ContentLoader\\|viewBox\\|twitching\\|shimmer" \\\n        --sort-relevance \\\n        --exclude-session "6db1ba4d-2089-4015-8962-d6acc838ac06" \\                                                              \n        --since "2026-03-20" \\                             \n        -c 5 --all',
        expected:
            'tools claude history "content loader\\|ContentLoader\\|viewBox\\|twitching\\|shimmer" --sort-relevance --exclude-session "6db1ba4d-2089-4015-8962-d6acc838ac06" --since "2026-03-20" -c 5 --all',
        expectedPretty:
            'tools claude history "content loader\\|ContentLoader\\|viewBox\\|twitching\\|shimmer" \\\n  --sort-relevance \\\n  --exclude-session "6db1ba4d-2089-4015-8962-d6acc838ac06" \\\n  --since "2026-03-20" -c 5 \\\n  --all',
        tags: ["real-world", "original-bug", "continuation"],
    },
    {
        name: "rm + cp with path on next line",
        input: "rm -rf /Users/Martin/Projects/ClaudeCode/npm-claude-code/vendor && cp -r ~/.bun/install/global/node_modules/@anthropic-ai/claude-code/vendor\n  /Users/Martin/Projects/ClaudeCode/npm-claude-code/vendor",
        expected:
            "rm -rf /Users/Martin/Projects/ClaudeCode/npm-claude-code/vendor && cp -r ~/.bun/install/global/node_modules/@anthropic-ai/claude-code/vendor /Users/Martin/Projects/ClaudeCode/npm-claude-code/vendor",
        expectedPretty:
            "rm -rf /Users/Martin/Projects/ClaudeCode/npm-claude-code/vendor && cp -r ~/.bun/install/global/node_modules/@anthropic-ai/claude-code/vendor /Users/Martin/Projects/ClaudeCode/npm-claude-code/vendor",
        tags: ["real-world", "terminal-wrap", "paths"],
    },
    {
        name: "tail + long UUID path split across 3 lines",
        input: "tail -5                                                       \n  /private/tmp/claude-502/-Users-Martin-Tresors-Projects-CEZ-col-fe/2\n  b54e169-f26a-4e53-8c7b-5b58c4089d30/tasks/a4660ef220406de2f.output \n  2>/dev/null",
        expected:
            "tail -5 /private/tmp/claude-502/-Users-Martin-Tresors-Projects-CEZ-col-fe/2b54e169-f26a-4e53-8c7b-5b58c4089d30/tasks/a4660ef220406de2f.output 2>/dev/null",
        expectedPretty:
            "tail -5 /private/tmp/claude-502/-Users-Martin-Tresors-Projects-CEZ-col-fe/2b54e169-f26a-4e53-8c7b-5b58c4089d30/tasks/a4660ef220406de2f.output 2>/dev/null",
        tags: ["real-world", "terminal-wrap", "uuid", "redirect"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 12. EDGE CASES
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "backslash at end of line with nothing after",
        input: "echo hello \\",
        expected: "echo hello",
        expectedPretty: "echo hello",
        tags: ["edge", "trailing-backslash"],
    },
    {
        name: "multiple blank lines between parts",
        input: "echo hello\n\n\n  world",
        expected: "echo hello world",
        expectedPretty: "echo hello world",
        tags: ["edge", "blank-lines"],
    },
    {
        name: "only backslashes and whitespace",
        input: "\\ \\ \\",
        expected: "",
        expectedPretty: "",
        tags: ["edge", "garbage"],
    },
    {
        name: "command with # comment",
        input: "echo hello # this is a comment \\\n  world",
        expected: "echo hello # this is a comment world",
        expectedPretty: "echo hello # this is a comment world",
        tags: ["edge", "comment"],
    },
    {
        name: "very long single-line command — passthrough",
        input: "find / -type f -name '*.ts' -not -path '*/node_modules/*' -not -path '*/.git/*' -exec grep -l 'import.*from' {} + 2>/dev/null | sort | head -100",
        expected:
            "find / -type f -name '*.ts' -not -path '*/node_modules/*' -not -path '*/.git/*' -exec grep -l 'import.*from' {} + 2>/dev/null | sort | head -100",
        expectedPretty:
            "find / -type f -name '*.ts' -not -path '*/node_modules/*' -not -path '*/.git/*' -exec grep -l 'import.*from' {} + 2>/dev/null | sort | head -100",
        tags: ["edge", "passthrough", "long"],
    },
    {
        name: "heredoc marker should not be joined",
        input: "cat <<'EOF'\nhello world\nEOF",
        expected: "cat <<'EOF'\nhello world\nEOF",
        expectedPretty: "cat <<'EOF'\nhello world\nEOF",
        tags: ["edge", "heredoc"],
    },
    {
        name: "command with glob patterns",
        input: "ls \\\n  src/**/*.{ts,tsx} \\\n  --color=auto",
        expected: "ls src/**/*.{ts,tsx} --color=auto",
        expectedPretty: "ls src/**/*.{ts,tsx} \\\n  --color=auto",
        tags: ["edge", "glob"],
    },
    {
        name: "command with array syntax",
        input: "bash -c 'arr=(one two three); echo ${arr[@]}'",
        expected: "bash -c 'arr=(one two three); echo ${arr[@]}'",
        expectedPretty: "bash -c 'arr=(one two three); echo ${arr[@]}'",
        tags: ["edge", "array", "passthrough"],
    },
    {
        name: "Unicode in arguments",
        input: 'echo "Héllo wörld 🌍" \\\n  >> /tmp/unicode.txt',
        expected: 'echo "Héllo wörld 🌍" >> /tmp/unicode.txt',
        expectedPretty: 'echo "Héllo wörld 🌍" >> /tmp/unicode.txt',
        tags: ["edge", "unicode"],
    },
    {
        name: "path with @ in it (npm scope)",
        input: "ls node_modules/@anthropic-ai/\n  claude-code/vendor",
        expected: "ls node_modules/@anthropic-ai/claude-code/vendor",
        expectedPretty: "ls node_modules/@anthropic-ai/claude-code/vendor",
        tags: ["edge", "npm-scope", "mid-word"],
    },
    {
        name: "equals in flag value (no space around =)",
        input: "docker run \\\n  --memory=512m \\\n  --cpus=2.0 \\\n  nginx",
        expected: "docker run --memory=512m --cpus=2.0 nginx",
        expectedPretty: "docker run \\\n  --memory=512m \\\n  --cpus=2.0 nginx",
        tags: ["edge", "equals-flag"],
    },
    {
        name: "flag with colon-separated value",
        input: "ssh -L 3000:localhost:3000 \\\n  user@host",
        expected: "ssh -L 3000:localhost:3000 user@host",
        expectedPretty: "ssh -L 3000:localhost:3000 user@host",
        tags: ["edge", "colon-value"],
    },
    {
        name: "command with line numbers from terminal ($ prompt prefix stripped)",
        input: "git diff \\\n  --stat \\\n  HEAD~3",
        expected: "git diff --stat HEAD~3",
        expectedPretty: "git diff \\\n  --stat HEAD~3",
        tags: ["edge", "continuation"],
    },
    {
        name: "Bash() with trailing whitespace inside",
        input: "Bash(  echo hello  )",
        expected: "echo hello",
        expectedPretty: "echo hello",
        tags: ["bash-wrapper", "whitespace"],
    },
    {
        name: "triple backslash edge case — literal backslash + continuation",
        input: "echo 'path\\\\' \\\n  next",
        expected: "echo 'path\\\\' next",
        expectedPretty: "echo 'path\\\\' next",
        tags: ["edge", "triple-backslash"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 13. STRESS TESTS — BIG COMMANDS
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "15-flag kubectl command with all continuations broken",
        input: [
            "kubectl apply \\                                    ",
            "  --filename=deployment.yaml \\                     ",
            "  --namespace=production \\                         ",
            "  --context=aws-eks-prod \\                         ",
            "  --server-side \\                                  ",
            "  --force-conflicts \\                              ",
            "  --field-manager=my-controller \\                  ",
            "  --dry-run=server \\                               ",
            "  --output=json \\                                  ",
            "  --show-managed-fields \\                          ",
            "  --selector='app=myapp,env=prod' \\               ",
            "  --prune \\                                        ",
            "  --all \\                                          ",
            "  --cascade=orphan \\                               ",
            "  --grace-period=30 \\                              ",
            "  --overwrite",
        ].join("\n"),
        expected:
            "kubectl apply --filename=deployment.yaml --namespace=production --context=aws-eks-prod --server-side --force-conflicts --field-manager=my-controller --dry-run=server --output=json --show-managed-fields --selector='app=myapp,env=prod' --prune --all --cascade=orphan --grace-period=30 --overwrite",
        expectedPretty:
            "kubectl apply \\\n  --filename=deployment.yaml \\\n  --namespace=production \\\n  --context=aws-eks-prod \\\n  --server-side \\\n  --force-conflicts \\\n  --field-manager=my-controller \\\n  --dry-run=server \\\n  --output=json \\\n  --show-managed-fields \\\n  --selector='app=myapp,env=prod' \\\n  --prune \\\n  --all \\\n  --cascade=orphan \\\n  --grace-period=30 \\\n  --overwrite",
        tags: ["stress", "many-flags", "trailing-spaces"],
    },
    {
        name: "nested command substitution with wrapping",
        input: "echo \"Uptime: $(uptime \\\n  | awk '{print $3}') Host: $(hostname\n  -f)\"",
        expected: "echo \"Uptime: $(uptime | awk '{print $3}') Host: $(hostname -f)\"",
        expectedPretty: "echo \"Uptime: $(uptime | awk '{print $3}') Host: $(hostname -f)\"",
        tags: ["stress", "nested-substitution"],
    },
    {
        name: "chained commands with pipes and redirects",
        input: "cat /var/log/syslog \\\n  | grep -i error \\\n  | awk '{print $1, $2, $NF}' \\\n  | sort \\\n  | uniq -c \\\n  | sort -rn \\\n  | head -20 \\\n  > /tmp/error-summary.txt \\\n  2>&1",
        expected:
            "cat /var/log/syslog | grep -i error | awk '{print $1, $2, $NF}' | sort | uniq -c | sort -rn | head -20 > /tmp/error-summary.txt 2>&1",
        expectedPretty:
            "cat /var/log/syslog | grep -i error | awk '{print $1, $2, $NF}' | sort | uniq -c | sort -rn | head -20 > /tmp/error-summary.txt 2>&1",
        tags: ["stress", "pipeline", "redirect"],
    },
    {
        name: "for loop broken across lines (Bash wrapper)",
        input: 'Bash(for f in *.log; do\n        gzip "$f"\n      done)',
        expected: 'for f in *.log; do\n  gzip "$f"\ndone',
        expectedPretty: 'for f in *.log; do\n  gzip "$f"\ndone',
        tags: ["stress", "bash-wrapper", "loop"],
    },
    {
        name: "multiple env vars + complex command",
        input: 'NODE_ENV=production \\\n  DATABASE_URL="postgres://user:pass@localhost:5432/mydb" \\\n  REDIS_URL="redis://localhost:6379" \\\n  API_KEY="sk-ant-abc123" \\\n  LOG_LEVEL=debug \\\n  npm run start:server',
        expected:
            'NODE_ENV=production DATABASE_URL="postgres://user:pass@localhost:5432/mydb" REDIS_URL="redis://localhost:6379" API_KEY="sk-ant-abc123" LOG_LEVEL=debug npm run start:server',
        expectedPretty:
            'NODE_ENV=production DATABASE_URL="postgres://user:pass@localhost:5432/mydb" REDIS_URL="redis://localhost:6379" API_KEY="sk-ant-abc123" LOG_LEVEL=debug npm run start:server',
        tags: ["stress", "env-vars", "continuation"],
    },
    {
        name: "tar with absolute paths wrapped across lines",
        input: "tar czf /Users/Martin/Tresors/Projects/GenesisTools/backu\n  p-2026-03-31.tar.gz \\\n  --exclude='node_modules' \\\n  --exclude='.git' \\\n  /Users/Martin/Tresors/Projects/GenesisTools/src/\n  /Users/Martin/Tresors/Projects/GenesisTools/package.json",
        expected:
            "tar czf /Users/Martin/Tresors/Projects/GenesisTools/backup-2026-03-31.tar.gz --exclude='node_modules' --exclude='.git' /Users/Martin/Tresors/Projects/GenesisTools/src/ /Users/Martin/Tresors/Projects/GenesisTools/package.json",
        expectedPretty:
            "tar czf /Users/Martin/Tresors/Projects/GenesisTools/backup-2026-03-31.tar.gz \\\n  --exclude='node_modules' \\\n  --exclude='.git' /Users/Martin/Tresors/Projects/GenesisTools/src/ /Users/Martin/Tresors/Projects/GenesisTools/package.json",
        tags: ["stress", "terminal-wrap", "continuation", "paths"],
    },
    {
        name: "jq pipeline with complex filter",
        input: "curl -s https://api.github.com/repos/anthropics/claude-code/releases \\\n  | jq '.[0] | {tag: .tag_name, date: .published_at, assets: [.assets[] | {name: .name, size: .size}]}' \\\n  | tee /tmp/release.json",
        expected:
            "curl -s https://api.github.com/repos/anthropics/claude-code/releases | jq '.[0] | {tag: .tag_name, date: .published_at, assets: [.assets[] | {name: .name, size: .size}]}' | tee /tmp/release.json",
        expectedPretty:
            "curl -s https://api.github.com/repos/anthropics/claude-code/releases | jq '.[0] | {tag: .tag_name, date: .published_at, assets: [.assets[] | {name: .name, size: .size}]}' | tee /tmp/release.json",
        tags: ["stress", "jq", "continuation"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 14. ADDITIONAL FLATTENED + TERMINAL WRAP COMBOS
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "flattened continuation inside compound command",
        input: "cd /project && \\                  make clean && \\                  make -j$(nproc) && \\                  make install",
        expected: "cd /project && make clean && make -j$(nproc) && make install",
        expectedPretty: "cd /project && make clean && make -j$(nproc) && make install",
        tags: ["flattened", "compound", "complex"],
    },
    {
        name: "terminal wrap + flattened on same command",
        input: "rsync -avz \\                  --progress /very/long/sourc\n  e/path/ user@remote:/equally/long/desti\n  nation/path/",
        expected: "rsync -avz --progress /very/long/source/path/ user@remote:/equally/long/destination/path/",
        expectedPretty:
            "rsync -avz \\\n  --progress /very/long/source/path/ user@remote:/equally/long/destination/path/",
        tags: ["flattened", "terminal-wrap", "mixed"],
    },
    {
        name: "flattened with pipe operators",
        input: "cat data.csv \\           | cut -d, -f2 \\           | sort \\           | uniq -c",
        expected: "cat data.csv | cut -d, -f2 | sort | uniq -c",
        expectedPretty: "cat data.csv | cut -d, -f2 | sort | uniq -c",
        tags: ["flattened", "pipe"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 15. PROMPT ARTIFACTS
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "dollar-sign prompt prefix",
        input: "$ git status",
        expected: "git status",
        expectedPretty: "git status",
        tags: ["prompt", "dollar"],
    },
    {
        name: "hash prefix NOT stripped (could be comment, not prompt)",
        input: "# apt-get update && apt-get install -y curl",
        expected: "# apt-get update && apt-get install -y curl",
        expectedPretty: "# apt-get update && apt-get install -y curl",
        tags: ["prompt", "hash", "safety"],
    },
    {
        name: "custom prompt prefix with username",
        input: "user@host:~$ ls -la",
        expected: "ls -la",
        expectedPretty: "ls -la",
        tags: ["prompt", "custom"],
    },
    {
        name: "prompt prefix with path",
        input: "martin@mbp ~/Projects $ npm test",
        expected: "npm test",
        expectedPretty: "npm test",
        tags: ["prompt", "path"],
    },
    {
        name: "zsh prompt with % sign",
        input: "% cd /tmp && ls",
        expected: "cd /tmp && ls",
        expectedPretty: "cd /tmp && ls",
        tags: ["prompt", "zsh"],
    },

    // ═══════════════════════════════════════════════════════════════════
    // 16. EXTRA REAL-WORLD BROKEN COMMANDS (varied breakage)
    // ═══════════════════════════════════════════════════════════════════
    {
        name: "npm install with long package names wrapped",
        input: "bun add @anthropic-ai/claude-code @anthropic-ai/\n  claude-agent-sdk typescript",
        expected: "bun add @anthropic-ai/claude-code @anthropic-ai/claude-agent-sdk typescript",
        expectedPretty: "bun add @anthropic-ai/claude-code @anthropic-ai/claude-agent-sdk typescript",
        tags: ["real-world", "npm", "mid-word"],
    },
    {
        name: "scp with long remote path",
        input: "scp user@remote.example.com:/var/log/applicati\n  on/server-2026-03-31.log.gz \\\n  /tmp/",
        expected: "scp user@remote.example.com:/var/log/application/server-2026-03-31.log.gz /tmp/",
        expectedPretty: "scp user@remote.example.com:/var/log/application/server-2026-03-31.log.gz /tmp/",
        tags: ["real-world", "scp", "terminal-wrap", "continuation"],
    },
    {
        name: "curl with headers wrapped",
        input: "curl -X POST \\\n  'https://api.example.com/v1/messages' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer sk-ant-api03-aaaa\n  aaaa-bbbbbbbb' \\\n  -d '{\"model\":\"claude-3\",\"max_tokens\":1024}'",
        expected:
            "curl -X POST 'https://api.example.com/v1/messages' -H 'Content-Type: application/json' -H 'Authorization: Bearer sk-ant-api03-aaaaaaaa-bbbbbbbb' -d '{\"model\":\"claude-3\",\"max_tokens\":1024}'",
        expectedPretty:
            "curl -X POST 'https://api.example.com/v1/messages' -H 'Content-Type: application/json' -H 'Authorization: Bearer sk-ant-api03-aaaaaaaa-bbbbbbbb' -d '{\"model\":\"claude-3\",\"max_tokens\":1024}'",
        tags: ["real-world", "curl", "mid-word", "continuation"],
    },
    {
        name: "ffmpeg complex filter",
        input: 'ffmpeg -i input.mp4 \\\n  -vf "scale=1920:1080,setpts=0.5*PTS" \\\n  -af "atempo=2.0" \\\n  -c:v libx264 \\\n  -preset fast \\\n  -crf 22 \\\n  output.mp4',
        expected:
            'ffmpeg -i input.mp4 -vf "scale=1920:1080,setpts=0.5*PTS" -af "atempo=2.0" -c:v libx264 -preset fast -crf 22 output.mp4',
        expectedPretty:
            'ffmpeg -i input.mp4 -vf "scale=1920:1080,setpts=0.5*PTS" -af "atempo=2.0" -c:v libx264 -preset fast -crf 22 output.mp4',
        tags: ["real-world", "ffmpeg", "continuation"],
    },
    {
        name: "terraform plan with var flags",
        input: 'terraform plan \\\n  -var="region=us-east-1" \\\n  -var="instance_type=t3.large" \\\n  -var-file=prod.tfvars \\\n  -out=plan.out \\\n  -detailed-exitcode',
        expected:
            'terraform plan -var="region=us-east-1" -var="instance_type=t3.large" -var-file=prod.tfvars -out=plan.out -detailed-exitcode',
        expectedPretty:
            'terraform plan -var="region=us-east-1" -var="instance_type=t3.large" -var-file=prod.tfvars -out=plan.out -detailed-exitcode',
        tags: ["real-world", "terraform", "continuation"],
    },
    {
        name: "psql with wrapped query",
        input: "psql -h db.example.com \\\n  -U admin \\\n  -d production \\\n  -c \"SELECT count(*) FROM users WHERE created_at > '2026-01-01'\"",
        expected:
            "psql -h db.example.com -U admin -d production -c \"SELECT count(*) FROM users WHERE created_at > '2026-01-01'\"",
        expectedPretty:
            "psql -h db.example.com -U admin -d production -c \"SELECT count(*) FROM users WHERE created_at > '2026-01-01'\"",
        tags: ["real-world", "psql", "continuation"],
    },
    {
        name: "wget with long URL wrapped",
        input: "wget -q 'https://github.com/anthropics/claude-code/rele\n  ases/download/v1.0.0/claude-code-linux-x86_64.tar.gz' \\\n  -O /tmp/claude-code.tar.gz",
        expected:
            "wget -q 'https://github.com/anthropics/claude-code/releases/download/v1.0.0/claude-code-linux-x86_64.tar.gz' -O /tmp/claude-code.tar.gz",
        expectedPretty:
            "wget -q 'https://github.com/anthropics/claude-code/releases/download/v1.0.0/claude-code-linux-x86_64.tar.gz' -O /tmp/claude-code.tar.gz",
        tags: ["real-world", "wget", "terminal-wrap", "continuation"],
    },
    {
        name: "xargs with complex pipeline and wrap",
        input: "find . -name '*.test.ts' -print0 \\\n  | xargs -0 -P4 -I{} bun test {} \\\n  2>&1 | tee /tmp/test-results.log",
        expected: "find . -name '*.test.ts' -print0 | xargs -0 -P4 -I{} bun test {} 2>&1 | tee /tmp/test-results.log",
        expectedPretty:
            "find . -name '*.test.ts' -print0 | xargs -0 -P4 -I{} bun test {} 2>&1 | tee /tmp/test-results.log",
        tags: ["real-world", "xargs", "pipe", "continuation"],
    },
    {
        name: "sed with continuation",
        input: "sed -i \\\n  's/old-pattern/new-pattern/g' \\\n  src/**/*.ts",
        expected: "sed -i 's/old-pattern/new-pattern/g' src/**/*.ts",
        expectedPretty: "sed -i 's/old-pattern/new-pattern/g' src/**/*.ts",
        tags: ["real-world", "sed", "continuation"],
    },
    {
        name: "az cli with many params",
        input: 'az rest \\\n  --method PATCH \\\n  --uri "https://dev.azure.com/org/project/_apis/wit/workitems/123?api-version=7.0" \\\n  --body \'[{"op":"replace","path":"/fields/System.State","value":"Active"}]\' \\\n  --headers Content-Type=application/json-patch+json',
        expected:
            'az rest --method PATCH --uri "https://dev.azure.com/org/project/_apis/wit/workitems/123?api-version=7.0" --body \'[{"op":"replace","path":"/fields/System.State","value":"Active"}]\' --headers Content-Type=application/json-patch+json',
        expectedPretty:
            'az rest \\\n  --method PATCH \\\n  --uri "https://dev.azure.com/org/project/_apis/wit/workitems/123?api-version=7.0" \\\n  --body \'[{"op":"replace","path":"/fields/System.State","value":"Active"}]\' \\\n  --headers Content-Type=application/json-patch+json',
        tags: ["real-world", "az-cli", "json", "continuation"],
    },
    // ═══════════════════════════════════════════════════════════════════
    // 17. SAFETY — commands that could cause harm if auto-fixed wrong
    // ═══════════════════════════════════════════════════════════════════

    // --- # comment must NEVER be stripped (could turn comment into executable) ---
    {
        name: "# comment with destructive command — must NOT strip #",
        input: "# rm -rf /",
        expected: "# rm -rf /",
        expectedPretty: "# rm -rf /",
        tags: ["safety", "comment", "destructive"],
    },
    {
        name: "# comment with SQL injection — must NOT strip #",
        input: "# DROP TABLE users;",
        expected: "# DROP TABLE users;",
        expectedPretty: "# DROP TABLE users;",
        tags: ["safety", "comment", "sql"],
    },
    {
        name: "# TODO comment — must NOT strip #",
        input: "# TODO: fix this later",
        expected: "# TODO: fix this later",
        expectedPretty: "# TODO: fix this later",
        tags: ["safety", "comment"],
    },
    {
        name: "# separator line — must NOT strip #",
        input: "# --------------------",
        expected: "# --------------------",
        expectedPretty: "# --------------------",
        tags: ["safety", "comment"],
    },

    // --- Quotes must be preserved (word-splitting on paths with spaces) ---
    {
        name: "quoted path with spaces — quotes must survive",
        input: 'rm -rf "/path/with spaces/important"',
        expected: 'rm -rf "/path/with spaces/important"',
        expectedPretty: 'rm -rf "/path/with spaces/important"',
        tags: ["safety", "quotes", "destructive"],
    },
    {
        name: "single-quoted path with spaces — quotes must survive",
        input: "rm -rf '/path/with spaces/important'",
        expected: "rm -rf '/path/with spaces/important'",
        expectedPretty: "rm -rf '/path/with spaces/important'",
        tags: ["safety", "quotes", "destructive"],
    },
    {
        name: "variable in quotes must not be mangled",
        input: 'rm -rf "$DIR/subfolder"',
        expected: 'rm -rf "$DIR/subfolder"',
        expectedPretty: 'rm -rf "$DIR/subfolder"',
        tags: ["safety", "quotes", "variable"],
    },

    // --- Mid-word join vs separate args (destructive command context) ---
    {
        name: "rm -rf with two separate paths — must NOT merge into one",
        input: "rm -rf /tmp/safe\n  /home/user/also-delete",
        expected: "rm -rf /tmp/safe /home/user/also-delete",
        expectedPretty: "rm -rf /tmp/safe /home/user/also-delete",
        tags: ["safety", "paths", "destructive"],
    },
    {
        name: "rm -rf with path starting with ~ — must keep as separate arg",
        input: "rm -rf /tmp/junk\n  ~/important-backup",
        expected: "rm -rf /tmp/junk ~/important-backup",
        expectedPretty: "rm -rf /tmp/junk ~/important-backup",
        tags: ["safety", "paths", "tilde", "destructive"],
    },
    {
        name: "rm -rf with mid-word UUID wrap — should merge (same path)",
        input: "rm -rf /tmp/session-abc123\n  def456/cache",
        expected: "rm -rf /tmp/session-abc123def456/cache",
        expectedPretty: "rm -rf /tmp/session-abc123def456/cache",
        tags: ["safety", "mid-word", "uuid"],
    },

    // --- Heredoc body must NEVER be executed as commands ---
    {
        name: "heredoc with destructive SQL — body must not flatten",
        input: "mysql -u root <<EOF\nDROP TABLE users;\nDELETE FROM sessions;\nEOF",
        expected: "mysql -u root <<EOF\nDROP TABLE users;\nDELETE FROM sessions;\nEOF",
        expectedPretty: "mysql -u root <<EOF\nDROP TABLE users;\nDELETE FROM sessions;\nEOF",
        tags: ["safety", "heredoc", "sql"],
    },
    {
        name: "heredoc with shell commands — body must stay as data",
        input: "cat <<SCRIPT\nrm -rf /\nformat c:\nSCRIPT",
        expected: "cat <<SCRIPT\nrm -rf /\nformat c:\nSCRIPT",
        expectedPretty: "cat <<SCRIPT\nrm -rf /\nformat c:\nSCRIPT",
        tags: ["safety", "heredoc", "destructive"],
    },
    {
        name: "heredoc with dash (<<-) for indented bodies",
        input: "cat <<-EOF\n\trm -rf /\n\tEOF",
        expected: "cat <<-EOF\n\trm -rf /\n\tEOF",
        expectedPretty: "cat <<-EOF\n\trm -rf /\n\tEOF",
        tags: ["safety", "heredoc", "indented"],
    },

    // --- Prompt stripping safety ---
    {
        name: "$ prompt stripped — safe (unambiguous)",
        input: "$ rm -rf /tmp/junk",
        expected: "rm -rf /tmp/junk",
        expectedPretty: "rm -rf /tmp/junk",
        tags: ["safety", "prompt", "dollar"],
    },
    {
        name: "$HOME must NOT be stripped (no space after $)",
        input: "$HOME/bin/my-script",
        expected: "$HOME/bin/my-script",
        expectedPretty: "$HOME/bin/my-script",
        tags: ["safety", "variable", "dollar"],
    },
    {
        name: "% prompt stripped — safe (zsh, always in quotes in awk)",
        input: "% rm -rf /tmp/junk",
        expected: "rm -rf /tmp/junk",
        expectedPretty: "rm -rf /tmp/junk",
        tags: ["safety", "prompt", "zsh"],
    },
    {
        name: "awk with % inside quotes — must NOT strip %",
        input: "awk '{printf \"%s\\n\", $1}'",
        expected: "awk '{printf \"%s\\n\", $1}'",
        expectedPretty: "awk '{printf \"%s\\n\", $1}'",
        tags: ["safety", "awk", "percent"],
    },
    {
        name: "user@host prompt stripped — safe (specific pattern)",
        input: "root@server:~# rm -rf /tmp/junk",
        expected: "rm -rf /tmp/junk",
        expectedPretty: "rm -rf /tmp/junk",
        tags: ["safety", "prompt", "root"],
    },

    // --- Bash() wrapper edge cases ---
    {
        name: "Bash() with nested parens in command substitution",
        input: "Bash(echo $(( 1 + 2 )) && echo $(date))",
        expected: "echo $(( 1 + 2 )) && echo $(date)",
        expectedPretty: "echo $(( 1 + 2 )) && echo $(date)",
        tags: ["safety", "bash-wrapper", "nested-parens"],
    },
    {
        name: "Bash() with array parens — must not lose closing paren",
        input: "Bash(declare -a arr=(one two three))",
        expected: "declare -a arr=(one two three)",
        expectedPretty: "declare -a arr=(one two three)",
        tags: ["safety", "bash-wrapper", "array"],
    },
    {
        name: "Not a Bash() wrapper — just starts with word Bash",
        input: "Bash is a shell",
        expected: "Bash is a shell",
        expectedPretty: "Bash is a shell",
        tags: ["safety", "bash-wrapper", "false-positive"],
    },
    {
        name: "Read() wrapper from Claude output",
        input: "Read(/Users/Martin/file.txt)",
        expected: "Read(/Users/Martin/file.txt)",
        expectedPretty: "Read(/Users/Martin/file.txt)",
        tags: ["safety", "bash-wrapper", "other-tool"],
    },

    // --- Redirect safety ---
    {
        name: "redirect > must not be swallowed into previous arg",
        input: "echo secret\n  > /tmp/leaked.txt",
        expected: "echo secret > /tmp/leaked.txt",
        expectedPretty: "echo secret > /tmp/leaked.txt",
        tags: ["safety", "redirect"],
    },
    {
        name: "append >> must not merge with filename",
        input: "echo data\n  >> /tmp/append.txt",
        expected: "echo data >> /tmp/append.txt",
        expectedPretty: "echo data >> /tmp/append.txt",
        tags: ["safety", "redirect", "append"],
    },

    // --- Escaped space preservation ---
    {
        name: "escaped space in path — single backslash-space preserved",
        input: "cd my\\ folder && ls",
        expected: "cd my\\ folder && ls",
        expectedPretty: "cd my\\ folder && ls",
        tags: ["safety", "escaped-space"],
    },
    {
        name: "multiple escaped spaces in path",
        input: "ls my\\ important\\ file.txt",
        expected: "ls my\\ important\\ file.txt",
        expectedPretty: "ls my\\ important\\ file.txt",
        tags: ["safety", "escaped-space"],
    },

    // --- Empty/whitespace edge cases ---
    {
        name: "Bash() with empty content — must not crash",
        input: "Bash()",
        expected: "",
        expectedPretty: "",
        tags: ["safety", "bash-wrapper", "empty"],
    },
    {
        name: "only newlines — must return empty",
        input: "\n\n\n",
        expected: "",
        expectedPretty: "",
        tags: ["safety", "empty"],
    },
    {
        name: "Bash() with only whitespace inside",
        input: "Bash(   \n   \n   )",
        expected: "",
        expectedPretty: "",
        tags: ["safety", "bash-wrapper", "whitespace"],
    },
];

// ── Stats ──────────────────────────────────────────────────────────────
export const stats = {
    total: testCases.length,
    byTag: testCases.reduce(
        (acc, tc) => {
            for (const tag of tc.tags) {
                acc[tag] = (acc[tag] ?? 0) + 1;
            }
            return acc;
        },
        {} as Record<string, number>
    ),
};
