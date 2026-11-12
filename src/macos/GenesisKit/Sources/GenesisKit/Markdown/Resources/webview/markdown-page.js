// biome-ignore-all lint/correctness/noInnerDeclarations: The page factory keeps helper declarations and mutable state private per renderer.
// biome-ignore-all lint/style/noRestrictedGlobals: This unbundled WebKit resource uses the browser's native JSON implementation.
((root, factory) => {
    if (typeof module === "object" && module.exports) {
        module.exports = {
            createMarkdownText: (markdownit) => factory({ markdownit: markdownit }, null),
        };
    } else {
        factory(root, root.document);
    }
})(typeof window === "undefined" ? null : window, (window, document) => {
    function gnEsc(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function gnSlug(s) {
        return String(s)
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .trim()
            .replace(/\s+/g, "-");
    }
    // Heading ids are unique per render: the second "Examples" is examples-1, the third examples-2, and a suffix
    // already taken moves on. MarkdownBlocks.uniqueSlugs does the same for the outline, so a row names one heading.
    var gnSlugSeen = {};
    function gnUniqueSlug(s) {
        var c = s,
            n = 0;
        while (Object.hasOwn(gnSlugSeen, c)) {
            n++;
            c = s + "-" + n;
        }
        gnSlugSeen[c] = 1;
        return c;
    }
    function gnPost(m) {
        try {
            window.webkit.messageHandlers.bridge.postMessage(m);
        } catch {}
    }
    var HLJS_ALIAS = {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        sh: "bash",
        shell: "bash",
        zsh: "bash",
        yml: "yaml",
        rb: "ruby",
        py: "python",
        rs: "rust",
        toml: "ini",
        conf: "ini",
        text: "plaintext",
        log: "plaintext",
    };
    var GN_ALIAS = {
        note: "note",
        abstract: "abstract",
        summary: "abstract",
        tldr: "abstract",
        info: "info",
        todo: "todo",
        tip: "tip",
        hint: "tip",
        important: "tip",
        idea: "tip",
        success: "success",
        check: "success",
        done: "success",
        question: "question",
        help: "question",
        faq: "question",
        warning: "warning",
        caution: "warning",
        attention: "warning",
        failure: "failure",
        fail: "failure",
        missing: "failure",
        danger: "danger",
        error: "danger",
        bug: "bug",
        example: "example",
        quote: "quote",
        cite: "quote",
    };
    var GN_ICON = {
        note: '<path d="M3 5a2 2 0 0 1 2-2h10l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
        abstract: '<path d="M5 3h11l3 3v15H5z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
        todo: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
        tip: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12c1 1 1 2 1 3h6c0-1 0-2 1-3a7 7 0 0 0-4-12z"/>',
        success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
        question: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
        warning:
            '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
        failure: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
        danger: '<path d="M12 2 2 20h20z"/><path d="M12 9v4M12 17h.01"/>',
        bug: '<path d="M8 6h8M6 10h12M6 14h12M9 4l1 2M15 4l-1 2"/><rect x="7" y="6" width="10" height="12" rx="5"/>',
        example: '<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
        quote: '<path d="M7 7h4v4c0 3-2 5-4 5M15 7h4v4c0 3-2 5-4 5"/>',
    };

    var md = window.markdownit({ html: true, linkify: true, breaks: false });
    // markdown-it drops file: links by default, so `[x.ts:147](file:///…#L147)` rendered as text. Swift opens them (openrel).
    var gnValidateLink = md.validateLink;
    md.validateLink = (url) => /^file:/i.test(String(url).trim()) || gnValidateLink(url);

    md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
        var inline = tokens[idx + 1];
        var text = inline && inline.content ? inline.content : "";
        tokens[idx].attrSet("id", gnUniqueSlug(gnSlug(text)));
        return self.renderToken(tokens, idx, options);
    };
    // A file shown as one code block (json, yaml, a source file, a log) numbers
    // its lines. Each line becomes its own element, so a highlight.js span that
    // runs over a line break (a block comment, a multi-line string) is closed at
    // the end of the line and opened again on the next one.
    var gnCodeLines = false;
    function gnNumberLines(html) {
        var lines = html.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") {
            lines.pop();
        }
        var open = [],
            out = [],
            width = String(lines.length).length;
        for (var i = 0; i < lines.length; i++) {
            var prefix = open.join(""),
                re = /<(\/?)span([^>]*)>/g,
                m;
            for (m = re.exec(lines[i]); m; m = re.exec(lines[i])) {
                if (m[1]) {
                    open.pop();
                } else {
                    open.push("<span" + m[2] + ">");
                }
            }
            var suffix = "";
            for (var k = 0; k < open.length; k++) {
                suffix += "</span>";
            }
            out.push(
                '<span class="gn-ln" data-ln="' +
                    (i + 1) +
                    '" style="--gn-ln-w:' +
                    width +
                    'ch">' +
                    prefix +
                    lines[i] +
                    suffix +
                    "</span>"
            );
        }
        return out.join("");
    }
    md.renderer.rules.fence = (tokens, idx) => {
        var t = tokens[idx];
        var info = (t.info || "").trim().split(/\s+/)[0];
        if (info === "mermaid") {
            return '<div class="mermaid">' + gnEsc(t.content) + "</div>";
        }
        var lang = HLJS_ALIAS[info] || info;
        var body;
        if (window.hljs && lang && window.hljs.getLanguage(lang)) {
            body = window.hljs.highlight(t.content, { language: lang }).value;
        } else {
            body = gnEsc(t.content);
        }
        if (gnCodeLines) {
            return (
                '<pre><code class="hljs gn-numbered language-' +
                gnEsc(info) +
                '">' +
                gnNumberLines(body) +
                "</code></pre>"
            );
        }
        var pre = '<pre><code class="hljs language-' + gnEsc(info) + '">' + body + "</code></pre>";
        // The bar (language, Copy) sits above the block, outside its scroller. See "Page extras".
        return gnOpt.codeBar ? gnCodeBlock(info, pre, t.content) : pre;
    };
    // Split view scroll sync: every top-level block carries the source line it
    // started on, so Swift can say "the editor is at line N" and the page can put
    // the matching block at the top. Same idea as VS Code's markdown preview.
    (() => {
        var LINED = [
            "paragraph_open",
            "heading_open",
            "blockquote_open",
            "bullet_list_open",
            "ordered_list_open",
            "list_item_open",
            "table_open",
            "tr_open",
            "hr",
            "html_block",
        ];
        for (var i = 0; i < LINED.length; i++) {
            ((name) => {
                var base = md.renderer.rules[name];
                md.renderer.rules[name] = (tokens, idx, options, env, self) => {
                    var t = tokens[idx];
                    if (t.map) {
                        t.attrSet("data-line", String(gnSourceLine(t.map[0])));
                        t.attrSet("data-line-end", String(gnSourceLine(t.map[1])));
                    }
                    return base
                        ? base(tokens, idx, options, env, self)
                        : self.renderToken(tokens, idx, options, env, self);
                };
            })(LINED[i]);
        }
        var fence = md.renderer.rules.fence;
        md.renderer.rules.fence = (tokens, idx, options, env, self) => {
            var html = fence(tokens, idx, options, env, self);
            var t = tokens[idx];
            // A block with a code bar is marked on its wrapper, so the scroll sync and the line band take the bar along.
            if (t.map) {
                var at = ' data-line="' + gnSourceLine(t.map[0]) + '" data-line-end="' + gnSourceLine(t.map[1]) + '"';
                if (html.indexOf('<div class="gn-code">') === 0) {
                    html = html.replace('<div class="gn-code">', '<div class="gn-code"' + at + ">");
                } else {
                    html = html
                        .replace("<pre>", "<pre" + at + ">")
                        .replace('<div class="mermaid">', '<div class="mermaid"' + at + ">");
                }
            }
            return html;
        };
    })();

    md.inline.ruler.before("link", "wikilink", (state, silent) => {
        var src = state.src,
            pos = state.pos;
        if (src.charCodeAt(pos) !== 0x5b && !(src.charCodeAt(pos) === 0x21 && src.charCodeAt(pos + 1) === 0x5b)) {
            return false;
        }
        // The note may be empty: [[#Heading]] points into this note.
        var m = /^!?\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/.exec(src.slice(pos));
        if (!m || (!m[1].trim() && !m[2])) {
            return false;
        }
        if (!silent) {
            var tok = state.push("wikilink", "", 0);
            tok.meta = { embed: src[pos] === "!", target: m[1].trim(), heading: m[2] || "", alias: m[3] || "" };
        }
        state.pos += m[0].length;
        return true;
    });
    md.renderer.rules.wikilink = (tokens, idx) => {
        var meta = tokens[idx].meta;
        var label =
            meta.alias ||
            (meta.heading ? (meta.target ? meta.target + " › " + meta.heading : meta.heading) : meta.target);
        var hit = gnMedia[gnMediaKey(meta.target)];
        if (meta.embed && hit && hit.kind === "image") {
            // `![[x.png|600]]` / `|600x400` is a size in Obsidian, not a caption.
            var size = /^\s*(\d+)(?:x(\d+))?\s*$/.exec(meta.alias || "");
            return (
                '<img data-gn-ref="' +
                gnEsc(meta.target) +
                '" alt="' +
                gnEsc(size ? meta.target : label) +
                '"' +
                (size ? ' width="' + size[1] + '"' + (size[2] ? ' height="' + size[2] + '"' : "") : "") +
                ">"
            );
        }
        if (hit && hit.kind === "json") {
            return gnJSONChip(hit, meta.alias || meta.target);
        }
        if (meta.embed && hit && hit.kind === "pending") {
            return gnPendingHTML(meta.target);
        }
        if (meta.embed && hit && hit.kind === "refused") {
            return gnRefusedImage(hit, meta.target).outerHTML;
        }
        if (meta.embed && GN_IMG_EXT.test(meta.target)) {
            return gnMissingImageHTML(meta.target);
        }
        if (meta.embed) {
            // `![[Other note]]`: drawn as a stub, and a click opens the note like its wikilink.
            var eref = meta.target + (meta.heading ? "#" + meta.heading : "");
            return (
                '<a href="#" class="dd-wikilink dd-md-embed-stub" data-wikilink="' +
                gnEsc(eref) +
                '" title="Open ' +
                gnEsc(meta.target) +
                '"><span class="dd-md-embed-icon" aria-hidden="true">⧉</span> ' +
                gnEsc(label) +
                "</a>"
            );
        }
        var ref = meta.target + (meta.heading ? "#" + meta.heading : "");
        return '<a href="#" class="dd-wikilink" data-wikilink="' + gnEsc(ref) + '">' + gnEsc(label) + "</a>";
    };

    // GFM task items: `- [ ]`, `* [x]`, `1. [X]`, nested and quoted ones. A list item whose first paragraph starts with
    // a box and a space (or ends after it) gets a real checkbox where the bullet was; a box in code or in the middle of
    // a line stays text. The box carries its body line and the item's first source line after the box, and a change
    // posts both (`task`); Swift finds the item in the text it sent and writes the note
    // (MarkdownWebView.Coordinator.setTask). gnTaskBase is the first body line of the callout being drawn.
    var gnTaskEdit = false,
        gnTaskLock = "",
        gnTaskBase = 0;
    md.core.ruler.after("inline", "gn_tasks", (state) => {
        var t = state.tokens;
        for (var i = 2; i < t.length; i++) {
            if (t[i].type !== "inline" || t[i - 1].type !== "paragraph_open" || t[i - 2].type !== "list_item_open") {
                continue;
            }
            var m = /^\[([ xX])\](?=\s|$)/.exec(t[i].content || "");
            if (!m) {
                continue;
            }
            var kids = t[i].children || [],
                first = kids[0],
                map = t[i - 1].map || t[i - 2].map;
            if (!map || !first || first.type !== "text" || first.content.slice(0, 3) !== m[0]) {
                continue;
            }
            first.content = first.content.slice(3).replace(/^[ \t]+/, "");
            var box = new state.Token("gn_task", "input", 0);
            box.meta = {
                checked: m[1] !== " ",
                line: gnSourceLine(map[0]) + gnTaskBase,
                text: t[i].content
                    .slice(3)
                    .split("\n")[0]
                    .replace(/^[ \t]+|[ \t]+$/g, ""),
            };
            kids.unshift(box);
            t[i - 2].attrJoin("class", "gn-task-item" + (box.meta.checked ? " gn-task-done" : ""));
        }
    });
    // The label is the hit area (1.5em around a 1em box) and holds the reason a disabled box cannot change the note.
    md.renderer.rules.gn_task = (tokens, idx) => {
        var m = tokens[idx].meta,
            locked = !gnTaskEdit;
        return (
            '<label class="gn-task-hit"' +
            (locked && gnTaskLock ? ' title="' + gnEsc(gnTaskLock) + '"' : "") +
            ">" +
            '<input type="checkbox" class="gn-task" data-task-line="' +
            m.line +
            '" data-task-text="' +
            gnEsc(m.text) +
            '"' +
            (m.checked ? " checked" : "") +
            (locked ? " disabled" : "") +
            "></label>"
        );
    };
    // A bare file name is no web address: linkify reads `Plan.md`, `deploy.sh` and `main.py` as domains (`.md` is
    // Moldova) and linked them to http://plan.md. Such a fuzzy link (no scheme, no `www.`, no slash, no `@`) stays a link
    // only when Swift found the file for this note (`gnMedia`, kind `file`, MarkdownMediaRegistry.update), and then it is
    // a relative link that opens the file like `[x](./x.md)`; otherwise it is plain text. A link with a scheme or `www.`
    // is a web link as before.
    var GN_FILE_NAME = /\.(md|sh|py|rs|pl|pm|cc|mm|ml|ps|so|tf|zip|mov)$/i;
    md.core.ruler.after("linkify", "gn_file_names", (state) => {
        var t = state.tokens;
        for (var i = 0; i < t.length; i++) {
            var kids = t[i].type === "inline" ? t[i].children : null;
            if (!kids) {
                continue;
            }
            for (var j = kids.length - 3; j >= 0; j--) {
                var open = kids[j],
                    label = kids[j + 1];
                if (
                    open.type !== "link_open" ||
                    open.markup !== "linkify" ||
                    label.type !== "text" ||
                    kids[j + 2].type !== "link_close"
                ) {
                    continue;
                }
                var text = label.content;
                if (!GN_FILE_NAME.test(text) || /^(https?:|www\.)/i.test(text) || /[/@]/.test(text)) {
                    continue;
                }
                var hit = gnMedia[gnMediaKey(text)];
                if (hit && hit.kind === "file") {
                    open.attrSet("href", text);
                    open.attrJoin("class", "gn-file-link");
                } else {
                    kids.splice(j + 2, 1);
                    kids.splice(j, 1);
                }
            }
        }
    });

    // Source line of a line in the text markdown-it saw: the same number, unless
    // gnExtractCallouts had to add a line (then gnLineMap says where each came from).
    var gnLineMap = null;
    function gnSourceLine(n) {
        if (!gnLineMap) {
            return n;
        }
        return n < gnLineMap.length ? gnLineMap[n] : gnLineMap[gnLineMap.length - 1] + (n - gnLineMap.length + 1);
    }
    function gnExtractCallouts(text) {
        var lines = text.split("\n"),
            out = [],
            map = [],
            callouts = [],
            added = false,
            i = 0;
        while (i < lines.length) {
            var head = /^ {0,3}> ?\[!([A-Za-z][\w-]*)\]([-+])?[ \t]*(.*)$/.exec(lines[i]);
            if (head) {
                var start = i,
                    type = head[1],
                    title = head[3] || "",
                    body = [];
                i++;
                while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
                    body.push(lines[i].replace(/^ {0,3}> ?/, ""));
                    i++;
                }
                callouts.push({ type: type, title: title, body: body.join("\n"), start: start });
                out.push("@@GNCALLOUT" + (callouts.length - 1) + "@@");
                map.push(start);
                // One placeholder line per callout line, so every data-line after the
                // callout still names the source line it came from.
                for (var pad = 1; pad < body.length + 1; pad++) {
                    out.push("");
                    map.push(start + pad);
                }
                // A callout ends at its last `>` line, but a line right under it (no
                // blank line, often a numbered list) would continue the placeholder's
                // paragraph, and the placeholder would show as text. A blank line keeps
                // it a paragraph of its own; gnLineMap keeps the source lines right.
                if (i < lines.length && lines[i].trim() !== "" && out[out.length - 1] !== "") {
                    out.push("");
                    map.push(i);
                    added = true;
                }
            } else {
                out.push(lines[i]);
                map.push(i);
                i++;
            }
        }
        return { text: out.join("\n"), callouts: callouts, lineMap: added ? map : null };
    }
    function gnRenderCallout(c, attrs) {
        var group = GN_ALIAS[c.type.toLowerCase()] || "note";
        var icon = GN_ICON[group] || GN_ICON.note;
        var title = (c.title || "").trim() || c.type.charAt(0).toUpperCase() + c.type.slice(1);
        // The body's first line is the line under the callout's head, so a task box in it names its line in the note.
        var base = gnTaskBase;
        gnTaskBase = (c.start || 0) + 1;
        var bodyHtml;
        try {
            bodyHtml = c.body.trim() ? '<div class="markdown-alert-body">' + md.render(c.body) + "</div>" : "";
        } finally {
            gnTaskBase = base;
        }
        return (
            '<div class="markdown-alert markdown-alert-' +
            group +
            '" data-callout="' +
            gnEsc(c.type) +
            '"' +
            (attrs || "") +
            ">" +
            '<p class="markdown-alert-title"><svg class="markdown-alert-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            icon +
            "</svg><span>" +
            gnEsc(title) +
            "</span></p>" +
            bodyHtml +
            "</div>"
        );
    }

    // The same text pass serves the page and Bun. Sanitizing and DOM wiring stay below.
    function gnRenderText(markdown) {
        var ex = gnExtractCallouts(markdown);
        gnLineMap = ex.lineMap;
        gnSlugSeen = {};
        var html = md.render(ex.text);
        gnLineMap = null;
        for (var i = 0; i < ex.callouts.length; i++) {
            // The paragraph carries data-line (source sync), so match its attributes
            // and hand the line on to the callout: a literal <p> never matches.
            html = html.replace(new RegExp("<p( [^>]*)?>@@GNCALLOUT" + i + "@@</p>"), (_, attrs) =>
                gnRenderCallout(ex.callouts[i], attrs || "")
            );
        }
        return html;
    }
    var gnMedia = {},
        gnOpt = { anchors: false, codeBar: false, sticky: false };
    var GN_IMG_EXT = /\.(webp|png|jpe?g|gif|avif|svg)$/i;
    var textPasses = {
        extractCallouts: gnExtractCallouts,
        escapeHTML: gnEsc,
        slug: gnSlug,
        numberLines: gnNumberLines,
        render: (markdown) => gnRenderText(markdown),
    };
    if (!document) {
        return textPasses;
    }

    // After a render: each box's own text goes into one span (a done item dims or strikes that, not the items nested
    // under it), and the box is named after it for VoiceOver ("Mark done: Buy milk"). No text node is added: the find
    // walks the article's text.
    var GN_TASK_STOP = {
        ul: 1,
        ol: 1,
        p: 1,
        div: 1,
        pre: 1,
        table: 1,
        blockquote: 1,
        details: 1,
        h1: 1,
        h2: 1,
        h3: 1,
        h4: 1,
        h5: 1,
        h6: 1,
        hr: 1,
    };
    function gnWireTasks() {
        var boxes = document.querySelectorAll("#gn-article input.gn-task");
        for (var i = 0; i < boxes.length; i++) {
            var hit = boxes[i].parentNode,
                host = hit && hit.parentNode;
            if (!host) {
                continue;
            }
            var span = document.createElement("span");
            span.className = "gn-task-text";
            var n = hit.nextSibling;
            while (n && !(n.nodeType === 1 && GN_TASK_STOP[n.localName])) {
                var next = n.nextSibling;
                span.appendChild(n);
                n = next;
            }
            host.insertBefore(span, hit.nextSibling);
            var label = (span.textContent || "").replace(/\s+/g, " ").trim();
            if (label.length > 140) {
                label = label.slice(0, 139) + "…";
            }
            boxes[i].setAttribute("aria-label", "Mark done: " + (label || "empty task"));
        }
    }
    function gnTaskShow(box, on) {
        box.checked = on;
        var li = box.closest("li");
        if (li) {
            li.classList.toggle("gn-task-done", on);
        }
    }
    // Click or Space on a box. A box that may not change the note never fires (it is disabled); a box whose page was
    // locked after the render is put back.
    document.addEventListener("change", (e) => {
        var b = e.target;
        if (!b || !b.classList || !b.classList.contains("gn-task")) {
            return;
        }
        if (!gnTaskEdit) {
            b.checked = !b.checked;
            return;
        }
        gnTaskShow(b, b.checked);
        gnPost({
            type: "task",
            line: +b.getAttribute("data-task-line"),
            text: b.getAttribute("data-task-text") || "",
            checked: b.checked,
        });
    });
    // Swift refused the change (the item moved away, the write failed): the box shows the note's state again.
    window.gnTaskRevert = (line, on) => {
        var bs = document.querySelectorAll('#gn-article input.gn-task[data-task-line="' + +line + '"]');
        for (var i = 0; i < bs.length; i++) {
            gnTaskShow(bs[i], !!on);
        }
    };
    // Whether a box may change the note, in place: no render, so the reading position and the focus stay.
    window.gnTaskMode = (edit, lock) => {
        gnTaskEdit = !!edit;
        gnTaskLock = String(lock || "");
        var bs = document.querySelectorAll("#gn-article input.gn-task");
        for (var i = 0; i < bs.length; i++) {
            bs[i].disabled = !gnTaskEdit;
            if (gnTaskEdit || !gnTaskLock) {
                bs[i].parentNode.removeAttribute("title");
            } else {
                bs[i].parentNode.setAttribute("title", gnTaskLock);
            }
        }
    };

    // A document is untrusted (a downloaded note), and this page holds the native
    // bridge. markdown-it keeps raw HTML for Obsidian parity (<details>, <kbd>,
    // <br>, inline styles), so the rendered HTML is parsed inert in a <template>
    // and scrubbed before it reaches the page: no script, frames, plugins, forms
    // or <meta>/<base>, no on* handlers, no javascript:/vbscript: URLs, and no
    // data: URL other than an image. The CSP in <head> is the second wall.
    var GN_DROP = {
        script: 1,
        iframe: 1,
        frame: 1,
        frameset: 1,
        object: 1,
        embed: 1,
        applet: 1,
        base: 1,
        meta: 1,
        link: 1,
        form: 1,
        portal: 1,
        template: 1,
        set: 1,
        animate: 1,
        animatemotion: 1,
        animatetransform: 1,
        foreignobject: 1,
    };
    var GN_URL_ATTR = {
        href: 1,
        "xlink:href": 1,
        src: 1,
        action: 1,
        formaction: 1,
        poster: 1,
        background: 1,
        cite: 1,
        data: 1,
        codebase: 1,
    };
    // A <summary> sits inside a raw HTML block, which markdown-it never parses, so `code` and **bold**
    // in a title stayed literal. Run each text node of a summary through the inline renderer, then the
    // same sanitizer, so the title reads like the rest of the note.
    function gnSummaryMarkdown(frag) {
        var sums = frag.querySelectorAll("details > summary");
        for (var i = 0; i < sums.length; i++) {
            var kids = Array.prototype.slice.call(sums[i].childNodes);
            for (var j = 0; j < kids.length; j++) {
                var n = kids[j];
                if (n.nodeType !== 3 || !/[`*_[~]/.test(n.nodeValue)) {
                    continue;
                }
                n.parentNode.replaceChild(gnSanitize(md.renderInline(n.nodeValue)), n);
            }
        }
        return frag;
    }
    function gnSanitize(html) {
        var tpl = document.createElement("template");
        tpl.innerHTML = html;
        var all = tpl.content.querySelectorAll("*");
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (GN_DROP[el.localName.toLowerCase()]) {
                if (el.parentNode) {
                    el.parentNode.removeChild(el);
                }
                continue;
            }
            for (var j = el.attributes.length - 1; j >= 0; j--) {
                var name = el.attributes[j].name.toLowerCase();
                // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip control bytes that can disguise a script URL before checking its scheme.
                var v = el.attributes[j].value.replace(/[\x00-\x20\x7f-\xa0]+/g, "").toLowerCase();
                if (
                    name.indexOf("on") === 0 ||
                    name === "srcdoc" ||
                    /^(javascript|vbscript|livescript):/.test(v) ||
                    (GN_URL_ATTR[name] && v.indexOf("data:") === 0 && v.indexOf("data:image/") !== 0)
                ) {
                    el.removeAttribute(el.attributes[j].name);
                }
            }
        }
        return tpl.content;
    }

    // Local media. Swift reads the document's own image and JSON references,
    // resolves them, and hands over key -> {kind, name, token, src}. A local
    // reference it did not resolve is shown as missing; the page never builds a
    // file URL itself, and gnmedia: serves only the tokens in this map.

    function gnMediaKey(s) {
        s = String(s || "").trim();
        if (s.charAt(0) === "<" && s.charAt(s.length - 1) === ">") {
            s = s.slice(1, -1);
        }
        if (!/^file:/i.test(s)) {
            var h = s.indexOf("#");
            if (h >= 0) {
                s = s.slice(0, h);
            }
        }
        try {
            s = decodeURIComponent(s);
        } catch {}
        return s.trim();
    }
    function gnJSONChip(hit, label) {
        return (
            '<button type="button" class="gn-json-chip" aria-expanded="false" data-gn-json="' +
            gnEsc(hit.token) +
            '" title="' +
            gnEsc(hit.name) +
            '">' +
            '<span class="gn-json-icon">{ }</span> ' +
            gnEsc(label || hit.name) +
            "</button>"
        );
    }
    // A picture that is not there says so in its own words, not only in a tooltip, so VoiceOver reads it too.
    // The reason the host gave for a picture it did not load (`MarkdownMedia.Refusal`), in a sentence that names the
    // file: missing, outside the folders a picture may come from (with a button to the setting that allows one),
    // unreadable, a type the viewer does not show, or too big.
    var GN_REFUSALS = {
        missing: () => "Picture not found",
        outsideRoots: () => "Picture outside the vault and this note's folder",
        notReadable: () => "Picture cannot be read (no permission, or not a file)",
        notAPicture: () => "Not a picture type the viewer shows (png, jpg, gif, webp, avif, svg)",
        tooLarge: (h) => "Picture is too large (" + (h.size || "?") + ", the limit is " + (h.limit || "64 MB") + ")",
    };
    function gnRefusedImage(hit, ref) {
        var why = (GN_REFUSALS[hit.reason] || GN_REFUSALS.missing)(hit);
        return gnMissingImage(
            hit.path || ref,
            "",
            why,
            hit.reason === "outsideRoots" ? "Allow its folder in Settings" : ""
        );
    }
    function gnMissingImageHTML(ref, alt, why, action) {
        var text = (why || "Picture not found") + ": " + (alt || ref);
        return (
            '<span class="dd-md-embed-stub gn-img-missing" title="' +
            gnEsc(ref) +
            '" role="' +
            (action ? "group" : "img") +
            '" aria-label="' +
            gnEsc(text) +
            '"><span class="dd-md-embed-icon" aria-hidden="true">⧉</span> ' +
            gnEsc(text) +
            (action ? '<button type="button" class="gn-img-allow">' + gnEsc(action) + "</button>" : "") +
            "</span>"
        );
    }
    function gnMissingImage(ref, alt, why, action) {
        var template = document.createElement("template");
        template.innerHTML = gnMissingImageHTML(ref, alt, why, action);
        return template.content.firstElementChild;
    }
    // The vault scan has not answered yet: a quiet box, no "not found", until Swift renders again.
    function gnPendingHTML(ref) {
        return '<span class="gn-img-pending" role="img" aria-label="Loading picture ' + gnEsc(ref) + '"></span>';
    }
    function gnApplyMedia(frag) {
        var imgs = frag.querySelectorAll("img");
        var viewable = 0;
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            var ref = img.getAttribute("data-gn-ref") || img.getAttribute("src") || "";
            img.removeAttribute("data-gn-ref");
            img.removeAttribute("srcset");
            img.removeAttribute("data-gn-img");
            // `![caption|300](x.png)`: Obsidian's size suffix on the alt text, read first so a missing picture's pill
            // shows the caption without it.
            var alt = img.getAttribute("alt") || "";
            var size = /\|\s*(\d+)(?:x(\d+))?\s*$/.exec(alt);
            if (size) {
                img.setAttribute("alt", alt.slice(0, size.index).trim());
                img.setAttribute("width", size[1]);
                if (size[2]) {
                    img.setAttribute("height", size[2]);
                }
            }
            var hit = gnMedia[gnMediaKey(ref)];
            if (hit && hit.kind === "image") {
                img.setAttribute("src", hit.src);
            } else if (hit && hit.kind === "pending") {
                var tp = document.createElement("template");
                tp.innerHTML = gnPendingHTML(ref);
                img.parentNode.replaceChild(tp.content.firstChild, img);
                continue;
            } else if (hit && hit.kind === "refused") {
                img.parentNode.replaceChild(gnRefusedImage(hit, ref), img);
                continue;
            } else if (!/^(https?:|data:image\/)/i.test(ref.trim())) {
                img.parentNode.replaceChild(gnMissingImage(ref, img.getAttribute("alt")), img);
                continue;
            }
            // A file over the size limit, one deleted since the render, a web picture that does not load: the pill
            // with the cause, never the browser's broken-picture glyph.
            // The element stays (hidden), so the page keeps what the note wrote.
            ((im, r) => {
                im.addEventListener("error", () => {
                    if (!im.parentNode || im.gnFailed) {
                        return;
                    }
                    im.gnFailed = true;
                    im.style.display = "none";
                    im.parentNode.insertBefore(
                        gnMissingImage(r, im.getAttribute("alt"), "Picture could not be loaded"),
                        im.nextSibling
                    );
                });
            })(img, ref);
            // The image viewer opens only what the page loads itself: a registered vault picture or an embedded one.
            // Return or Space opens it too, so the keyboard and VoiceOver reach it.
            if (/^(gnmedia:|data:image\/)/i.test(img.getAttribute("src") || "")) {
                img.setAttribute("data-gn-img", String(viewable++));
                img.setAttribute("tabindex", "0");
                img.setAttribute("role", "button");
                img.setAttribute(
                    "aria-label",
                    "Open picture" +
                        ((img.getAttribute("alt") || "").trim() ? " " + img.getAttribute("alt").trim() : "")
                );
            }
        }
        var links = frag.querySelectorAll("a[href]:not(.dd-wikilink)");
        for (var j = 0; j < links.length; j++) {
            var a = links[j];
            var jh = gnMedia[gnMediaKey(a.getAttribute("href"))];
            if (!jh || jh.kind !== "json") {
                continue;
            }
            var t = document.createElement("template");
            t.innerHTML = gnJSONChip(jh, a.textContent);
            a.parentNode.replaceChild(t.content.firstChild, a);
        }
        return frag;
    }
    function gnWireJSON() {
        var chips = document.querySelectorAll("#gn-article .gn-json-chip[data-gn-json]");
        for (var i = 0; i < chips.length; i++) {
            ((c) => {
                c.addEventListener("click", (e) => {
                    e.preventDefault();
                    if (c.gnPanel && c.gnPanel.parentNode) {
                        c.gnPanel.parentNode.removeChild(c.gnPanel);
                        c.gnPanel = null;
                        c.setAttribute("aria-expanded", "false");
                        return;
                    }
                    gnJSONPending = c;
                    gnPost({ type: "json", token: c.getAttribute("data-gn-json") });
                });
            })(chips[i]);
        }
    }
    var gnJSONPending = null;
    // Swift's answer to a chip click: the file's text, or null when it could not be read.
    window.gnShowJSON = (token, text) => {
        var chip =
            gnJSONPending && gnJSONPending.getAttribute("data-gn-json") === token
                ? gnJSONPending
                : document.querySelector(
                      '#gn-article .gn-json-chip[data-gn-json="' + token.replace(/[^a-z0-9-]/gi, "") + '"]'
                  );
        gnJSONPending = null;
        if (!chip) {
            return;
        }
        if (chip.gnPanel && chip.gnPanel.parentNode) {
            chip.gnPanel.parentNode.removeChild(chip.gnPanel);
        }
        var body;
        if (text == null) {
            body = '<p class="gn-json-error">This file could not be read.</p>';
        } else {
            var pretty = text;
            try {
                pretty = JSON.stringify(JSON.parse(text), null, 2);
            } catch {}
            var code = window.hljs ? window.hljs.highlight(pretty, { language: "json" }).value : gnEsc(pretty);
            body = '<pre><code class="hljs language-json">' + code + "</code></pre>";
        }
        var panel = document.createElement("div");
        panel.className = "gn-json-panel";
        // A disclosure: the chip says whether its panel is open and which element it is.
        panel.id = "gn-json-panel-" + token.replace(/[^a-z0-9-]/gi, "");
        chip.setAttribute("aria-controls", panel.id);
        chip.setAttribute("aria-expanded", "true");
        panel.innerHTML =
            '<div class="gn-json-head"><span></span><button type="button" class="gn-json-close" aria-label="Close">×</button></div>' +
            body;
        panel.querySelector(".gn-json-head span").textContent = chip.getAttribute("title") || "";
        // Closing removes the focused button with the panel, so focus goes back to the chip that opened it.
        panel.querySelector(".gn-json-close").addEventListener("click", () => {
            panel.parentNode && panel.parentNode.removeChild(panel);
            chip.gnPanel = null;
            chip.setAttribute("aria-expanded", "false");
            chip.focus();
        });
        var host = chip.closest("p,li,td,th,h1,h2,h3,h4,h5,h6") || chip;
        if (host.localName === "li") {
            host.appendChild(panel);
        } else {
            host.parentNode.insertBefore(panel, host.nextSibling);
        }
        chip.gnPanel = panel;
    };
    // A link with a scheme (https:, mailto:, obsidian:) goes to Swift's allow-list
    // as an external URL; a path (./x.pdf, ../Notes/A.md, file:) is a local file.
    var GN_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
    function gnWireLinks() {
        var wl = document.querySelectorAll("a.dd-wikilink[data-wikilink]");
        for (var i = 0; i < wl.length; i++) {
            ((a) => {
                a.addEventListener("click", (e) => {
                    e.preventDefault();
                    var t = a.getAttribute("data-wikilink");
                    if (t.charAt(0) === "#") {
                        window.gnScrollToSlug(gnSlug(t.slice(1)), t.slice(1));
                        return;
                    }
                    gnPost({ type: "wikilink", target: t });
                });
            })(wl[i]);
        }
        // `[Setup](#setup)`: the page's own heading, answered like a wikilink's when it is not there.
        var hl = document.querySelectorAll('#gn-article a[href^="#"]:not(.dd-wikilink)');
        for (var h = 0; h < hl.length; h++) {
            ((a) => {
                var frag = a.getAttribute("href").slice(1);
                if (!frag) {
                    return;
                }
                a.addEventListener("click", (e) => {
                    e.preventDefault();
                    var t = frag;
                    try {
                        t = decodeURIComponent(frag);
                    } catch {}
                    window.gnScrollToSlug(gnSlug(t), t);
                });
            })(hl[h]);
        }
        var xl = document.querySelectorAll('a[href]:not([href^="#"]):not(.dd-wikilink)');
        for (var j = 0; j < xl.length; j++) {
            ((a) => {
                a.addEventListener("click", (e) => {
                    e.preventDefault();
                    var href = a.getAttribute("href").trim();
                    var scheme = GN_SCHEME.exec(href);
                    if (scheme && scheme[0].toLowerCase() !== "file:") {
                        gnPost({ type: "openurl", url: a.href });
                    } else {
                        gnPost({ type: "openrel", href: href });
                    }
                });
            })(xl[j]);
        }
    }
    window.gnRunMermaid = () => {
        if (window.gnMermaid) {
            try {
                window.gnMermaid.run({ nodes: document.querySelectorAll(".mermaid") });
            } catch {}
        }
    };

    var gnLastSlug = "";
    var gnLastPosted = -1;
    function gnPostScroll() {
        var sc = document.scrollingElement || document.documentElement;
        if (Math.abs(sc.scrollTop - gnLastPosted) < 8) {
            return;
        }
        gnLastPosted = sc.scrollTop;
        gnPost({ type: "scroll", top: sc.scrollTop });
    }
    function gnOnScroll() {
        var heads = document.querySelectorAll("#gn-article h1,#gn-article h2,#gn-article h3,#gn-article h4");
        var current = "";
        for (var i = 0; i < heads.length; i++) {
            var r = heads[i].getBoundingClientRect();
            if (r.top <= 90) {
                current = heads[i].id;
            } else {
                break;
            }
        }
        if (!current && heads.length) {
            current = heads[0].id;
        }
        if (current && current !== gnLastSlug) {
            gnLastSlug = current;
            gnPost({ type: "section", slug: current });
        }
        gnStickyUpdate();
    }
    // The position is posted straight away (it is one cheap number and the reader
    // may close the tab in the same breath); the heavier scroll-spy waits a frame.
    window.addEventListener(
        "scroll",
        () => {
            gnPostScroll();
            window.requestAnimationFrame(gnOnScroll);
        },
        { passive: true }
    );
    // Split view, preview to editor: a scroll the reader made here (wheel, keys, the scroll bar) reports the body line
    // at the top, so the editor follows. A scroll the editor caused (`gnSyncLine`) clears the input time and stays quiet,
    // so the two panes never drive each other in a loop.
    var gnInputAt = 0,
        gnTopFrame = 0,
        gnLastTopLine = -1,
        gnReverseEnabled = false,
        gnDragging = false;
    window.gnReverseSync = (on) => {
        gnReverseEnabled = !!on;
        gnInputAt = 0;
        gnDragging = false;
        gnLastTopLine = -1;
        if (!on && gnTopFrame) {
            clearTimeout(gnTopFrame);
            gnTopFrame = 0;
        }
    };
    ["wheel", "keydown", "mousedown", "touchstart"].forEach((t) => {
        window.addEventListener(
            t,
            () => {
                if (gnReverseEnabled) {
                    gnInputAt = Date.now();
                }
            },
            { passive: true, capture: true }
        );
    });
    window.addEventListener(
        "mousedown",
        () => {
            if (gnReverseEnabled) {
                gnDragging = true;
            }
        },
        { capture: true }
    );
    window.addEventListener(
        "mouseup",
        () => {
            gnDragging = false;
        },
        { capture: true }
    );
    window.addEventListener("blur", () => {
        gnDragging = false;
    });
    // The inverse of `gnSyncLine`: the line of the block at the sync edge, interpolated to the next block.
    function gnTopLine() {
        var art = document.getElementById("gn-article");
        if (!art) {
            return -1;
        }
        var sc = document.scrollingElement || document.documentElement;
        if (sc.scrollTop <= 0) {
            return 0;
        }
        var edge = 12 + gnStickyRoom(),
            nodes = art.querySelectorAll("[data-line]"),
            prev = null,
            next = null;
        for (var i = 0; i < nodes.length; i++) {
            var line = parseInt(nodes[i].getAttribute("data-line"), 10);
            if (isNaN(line)) {
                continue;
            }
            var top = nodes[i].getBoundingClientRect().top;
            if (top <= edge + 1) {
                if (!prev || line >= prev.line) {
                    prev = { line: line, top: top };
                }
            } else {
                next = { line: line, top: top };
                break;
            }
        }
        if (!prev) {
            return 0;
        }
        if (next && next.line > prev.line && next.top > prev.top) {
            return Math.round(
                prev.line + (next.line - prev.line) * Math.min(1, (edge - prev.top) / (next.top - prev.top))
            );
        }
        return prev.line;
    }
    window.addEventListener(
        "scroll",
        () => {
            if (!gnReverseEnabled || (!gnDragging && Date.now() - gnInputAt > 600) || gnTopFrame) {
                return;
            }
            // A timer, not a frame: a page in a window that is not on screen gets no frames.
            gnTopFrame = setTimeout(() => {
                gnTopFrame = 0;
                var n = gnTopLine();
                if (n >= 0 && n !== gnLastTopLine) {
                    gnLastTopLine = n;
                    gnPost({ type: "topLine", line: n });
                }
            }, 50);
        },
        { passive: true }
    );

    // ---- Page extras: heading anchors, code block bar, sticky section, link hover ----
    // Swift sends the reader's choices (GenesisKitMarkdownConfiguration) through gnPage before the
    // first render. Nothing here puts a text node inside #gn-article: the find walks those, and a copy
    // of the page must not pick up "#" or "Copy". The labels are drawn by CSS from attributes; the
    // toast and the sticky bar live outside the article.
    // The source of every fenced block this render drew a bar for; a Copy button names its index.
    var gnCodeSrc = [];
    var gnMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    function gnScrollBehavior() {
        return gnMotion && gnMotion.matches ? "auto" : "smooth";
    }
    var GN_COPY_ICON =
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
    window.gnPage = (o) => {
        o = o || {};
        gnOpt = { anchors: !!o.anchors, codeBar: !!o.codeBar, sticky: !!o.sticky };
        document.body.classList.toggle("gn-anchors", gnOpt.anchors);
        document.body.classList.toggle("gn-sticky-on", gnOpt.sticky);
        // A done task's text: dimmed (the default), dimmed and struck through, or unchanged.
        var done = o.taskDone || "dim";
        document.body.classList.toggle("gn-tasks-dim", done === "dim" || done === "dimStrike");
        document.body.classList.toggle("gn-tasks-strike", done === "dimStrike");
        gnStickyKey = null;
        gnStickyUpdate();
    };
    function gnCodeBlock(info, pre, source) {
        var i = gnCodeSrc.length;
        gnCodeSrc.push(String(source || "").replace(/\n$/, ""));
        return (
            '<div class="gn-code"><div class="gn-code-bar"><span class="gn-code-lang" data-lang="' +
            gnEsc(info) +
            '"></span>' +
            '<button type="button" class="gn-code-copy" data-gn-code="' +
            i +
            '" data-label="Copy" aria-label="Copy code">' +
            GN_COPY_ICON +
            "</button></div>" +
            pre +
            "</div>"
        );
    }
    // After every render: a "#" button in every heading (CSS hides it while anchors are off), and the
    // sticky bar and the link hover start over with the new elements.
    function gnPageAfterRender() {
        var hs = document.querySelectorAll(
            "#gn-article h1,#gn-article h2,#gn-article h3,#gn-article h4,#gn-article h5,#gn-article h6"
        );
        for (var i = 0; i < hs.length; i++) {
            var b = document.createElement("button");
            b.type = "button";
            b.className = "gn-anchor";
            b.setAttribute("aria-label", "Copy link to this heading");
            hs[i].appendChild(b);
        }
        gnStickyHeads = null;
        gnStickyKey = null;
        gnHoverEnd();
    }
    function gnHeadingText(h) {
        return (h.textContent || "").replace(/\s+/g, " ").trim();
    }
    function gnCopied(btn) {
        var live = document.getElementById("gn-live");
        if (live) {
            live.textContent = "";
            live.textContent = "Copied";
        }
        btn.setAttribute("data-label", "Copied");
        btn.setAttribute("aria-label", "Copied");
        btn.classList.add("gn-done");
        clearTimeout(btn.gnT);
        btn.gnT = setTimeout(() => {
            btn.setAttribute("data-label", "Copy");
            btn.setAttribute("aria-label", "Copy code");
            btn.classList.remove("gn-done");
        }, 1400);
    }
    // "Copied" beside a heading's "#", placed in the document so it scrolls with the heading it names.
    var gnToastT = 0;
    function gnToast(near, text) {
        var t = document.getElementById("gn-toast");
        if (!t) {
            return;
        }
        var r = near.getBoundingClientRect(),
            sc = document.scrollingElement || document.documentElement;
        t.textContent = text;
        t.style.left = Math.round(r.right + 6 + sc.scrollLeft) + "px";
        t.style.top = Math.round(r.top + r.height / 2 + sc.scrollTop) + "px";
        t.classList.add("gn-on");
        clearTimeout(gnToastT);
        gnToastT = setTimeout(() => {
            t.classList.remove("gn-on");
        }, 1200);
    }
    function gnScrollToHeading(el) {
        gnNav++;
        el.scrollIntoView({ behavior: gnScrollBehavior(), block: "start" });
    }
    document.addEventListener("click", (e) => {
        var t = e.target;
        if (!t || !t.closest) {
            return;
        }
        if (t.closest("#gn-article .gn-img-allow")) {
            e.preventDefault();
            gnPost({ type: "pictureSettings" });
            return;
        }
        var copy = t.closest("#gn-article .gn-code-copy[data-gn-code]");
        if (copy) {
            e.preventDefault();
            var src = gnCodeSrc[+copy.getAttribute("data-gn-code")];
            if (src != null) {
                gnPost({ type: "copy", text: src });
                gnCopied(copy);
            }
            return;
        }
        var anchor = t.closest("#gn-article .gn-anchor");
        if (anchor) {
            e.preventDefault();
            var h = anchor.parentNode;
            gnScrollToHeading(h);
            gnPost({ type: "anchor", heading: gnHeadingText(h) });
            gnToast(anchor, "Copied");
            return;
        }
        var part = t.closest("#gn-sticky .gn-sticky-part");
        if (part) {
            e.preventDefault();
            var el = gnStickyPath[+part.getAttribute("data-i")];
            if (el) {
                gnScrollToHeading(el);
            }
        }
    });
    // Sticky section: the path (H1 › H2 › H3) of the section at the top of the page, made of the
    // headings already scrolled under the bar. gnOnScroll, which reports the active section, runs it.
    var gnStickyHeads = null,
        gnStickyPath = [],
        gnStickyKey = null;
    function gnStickyRoom() {
        if (!gnOpt.sticky) {
            return 0;
        }
        var bar = document.getElementById("gn-sticky");
        return bar ? bar.offsetHeight : 0;
    }
    function gnStickyUpdate() {
        var bar = document.getElementById("gn-sticky");
        if (!bar) {
            return;
        }
        var path = [],
            key = "";
        if (gnOpt.sticky) {
            if (!gnStickyHeads) {
                gnStickyHeads = [];
                var hs = document.querySelectorAll(
                    "#gn-article > h1,#gn-article > h2,#gn-article > h3,#gn-article > h4,#gn-article > h5,#gn-article > h6"
                );
                for (var i = 0; i < hs.length; i++) {
                    gnStickyHeads.push({ el: hs[i], level: +hs[i].localName.charAt(1) });
                }
            }
            var limit = bar.offsetHeight,
                cur = -1;
            for (var j = 0; j < gnStickyHeads.length; j++) {
                if (gnStickyHeads[j].el.getBoundingClientRect().top <= limit + 1) {
                    cur = j;
                } else {
                    break;
                }
            }
            if (cur >= 0) {
                var chain = [cur],
                    level = gnStickyHeads[cur].level;
                for (var k = cur - 1; k >= 0 && level > 1; k--) {
                    if (gnStickyHeads[k].level < level) {
                        chain.unshift(k);
                        level = gnStickyHeads[k].level;
                    }
                }
                for (var m = 0; m < chain.length; m++) {
                    var h = gnStickyHeads[chain[m]].el;
                    if (h.getBoundingClientRect().bottom <= limit) {
                        path.push(h);
                        key += chain[m] + ",";
                    }
                }
            }
        }
        if (key === gnStickyKey) {
            return;
        }
        gnStickyKey = key;
        gnStickyPath = path;
        var row = bar.firstElementChild;
        row.textContent = "";
        for (var n = 0; n < path.length; n++) {
            if (n) {
                var sep = document.createElement("span");
                sep.className = "gn-sticky-sep";
                sep.setAttribute("aria-hidden", "true");
                sep.textContent = "›";
                row.appendChild(sep);
            }
            var part = document.createElement("button");
            part.type = "button";
            part.className = "gn-sticky-part";
            part.setAttribute("data-i", String(n));
            part.textContent = gnHeadingText(path[n]);
            part.title = part.textContent;
            row.appendChild(part);
        }
        bar.classList.toggle("gn-on", path.length > 0);
    }
    // Tests call it directly: requestAnimationFrame never runs in an off-screen web view.
    window.gnStickyRefresh = gnStickyUpdate;
    // A PDF export draws the screen, not print media: MarkdownWebProxy turns the screen-only chrome off for it.
    window.gnExportMode = (on) => {
        document.body.classList.toggle("gn-export", !!on);
    };
    // Link hover, for the chrome's floating preview: the link under the pointer, then null when it
    // leaves. Quiet while a button is down (a drag, a selection) and while the page scrolls.
    var gnHoverEl = null,
        gnScrollQuiet = false,
        gnScrollQuietT = 0;
    function gnHoverTarget(t) {
        return t && t.closest ? t.closest("#gn-article a[href],#gn-article .dd-wikilink") : null;
    }
    function gnHoverHref(a) {
        if (a.hasAttribute("data-wikilink")) {
            return a.getAttribute("data-wikilink");
        }
        var h = (a.getAttribute("href") || "").trim();
        if (!h) {
            return null;
        }
        var s = GN_SCHEME.exec(h);
        return s && s[0].toLowerCase() !== "file:" ? a.href : h;
    }
    function gnHoverEnd() {
        if (!gnHoverEl) {
            return;
        }
        gnHoverEl = null;
        gnPost({ type: "linkHover", href: null });
    }
    document.addEventListener("mouseover", (e) => {
        if (e.buttons || gnScrollQuiet) {
            return;
        }
        var a = gnHoverTarget(e.target);
        if (a === gnHoverEl) {
            return;
        }
        gnHoverEnd();
        if (!a) {
            return;
        }
        var href = gnHoverHref(a);
        if (!href) {
            return;
        }
        gnHoverEl = a;
        var r = a.getBoundingClientRect();
        gnPost({ type: "linkHover", href: href, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
    });
    document.addEventListener("mouseout", (e) => {
        if (gnHoverEl && !(e.relatedTarget && gnHoverEl.contains(e.relatedTarget))) {
            gnHoverEnd();
        }
    });
    document.addEventListener("mousedown", gnHoverEnd, true);
    window.addEventListener(
        "scroll",
        () => {
            gnScrollQuiet = true;
            gnHoverEnd();
            clearTimeout(gnScrollQuietT);
            gnScrollQuietT = setTimeout(() => {
                gnScrollQuiet = false;
            }, 160);
        },
        { passive: true }
    );

    // ---- Properties (frontmatter) -------------------------------------------
    // Swift parses the YAML and hands over typed rows; the page renders them like
    // Obsidian's Properties and posts the whole row list back after every commit
    // (blur, Enter, checkbox, chip add/remove, type change, rename, remove, add).
    var PROP_ICON = {
        text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
        number: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
        checkbox: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
        date: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        datetime: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 13v3l2 1"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
        tags: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/>',
    };
    var PROP_LABEL = {
        text: "Text",
        number: "Number",
        checkbox: "Checkbox",
        date: "Date",
        datetime: "Date & time",
        list: "List",
        tags: "Tags",
    };
    var gnProps = [],
        gnPropsEditable = false,
        gnPropsFocus = null;
    function gnIcon(kind) {
        return (
            '<svg class="gn-prop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            (PROP_ICON[kind] || PROP_ICON.text) +
            "</svg>"
        );
    }
    function gnPropText(v) {
        // [[Note]] inside a text value is a link, like in Obsidian.
        return gnEsc(v).replace(
            /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
            (m, t, a) =>
                '<a href="#" class="dd-wikilink" data-wikilink="' +
                gnEsc(t.trim()) +
                '">' +
                gnEsc(a || t.trim()) +
                "</a>"
        );
    }
    // Undo is valid only while the rows still match the state just after removal.
    // Normalize like the host's render, so a round trip does not invalidate Undo.
    var gnPropsUndos = new Map(),
        gnPropsUndoSequence = 0,
        gnPropsPendingUndo = null;
    function gnPropsItems() {
        return gnProps.map((p) => ({
            key: p.key,
            kind: p.kind,
            value: p.value || "",
            items: p.items || [],
            inline: !!p.inline,
        }));
    }
    function gnPropsKeep() {
        var token = ++gnPropsUndoSequence;
        gnPropsUndos.set(token, { before: JSON.parse(JSON.stringify(gnPropsItems())), after: null });
        // Bound snapshots when a page stays open for a long editing session.
        if (gnPropsUndos.size > 100) {
            gnPropsUndos.delete(gnPropsUndos.keys().next().value);
        }
        gnPropsPendingUndo = token;
        return token;
    }
    window.gnPropsUndo = (token) => {
        if (token == null) {
            token = Array.from(gnPropsUndos.keys()).pop();
        }
        var entry = gnPropsUndos.get(token);
        if (!entry || JSON.stringify(gnPropsItems()) !== entry.after) {
            return false;
        }
        gnPropsUndos.delete(token);
        gnProps = entry.before;
        gnPropsPost();
        return true;
    };
    function gnPropsPost() {
        var items = gnPropsItems();
        if (gnPropsPendingUndo !== null) {
            gnPropsUndos.get(gnPropsPendingUndo).after = JSON.stringify(items);
            gnPropsPendingUndo = null;
        }
        gnPost({ type: "properties", items: items });
    }
    function gnConvert(p, kind) {
        var v = p.kind === "list" || p.kind === "tags" ? (p.items || []).join(", ") : p.value || "";
        var q = { key: p.key, kind: kind, value: "", items: [], inline: false };
        if (kind === "list" || kind === "tags") {
            q.items = p.kind === "list" || p.kind === "tags" ? (p.items || []).slice() : v ? [v] : [];
        } else if (kind === "checkbox") {
            q.value = v === "true" ? "true" : "false";
        } else if (kind === "number") {
            q.value = /^-?\d+(\.\d+)?$/.test(v) ? v : "";
        } else if (kind === "date") {
            q.value = /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "";
        } else if (kind === "datetime") {
            q.value = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)
                ? v.slice(0, 16)
                : /^\d{4}-\d{2}-\d{2}$/.test(v)
                  ? v + "T00:00"
                  : "";
        } else {
            q.value = v;
        }
        return q;
    }
    function gnRenderProps(props, editable) {
        gnProps = props || [];
        gnPropsEditable = !!editable;
        var art = document.getElementById("gn-article");
        var old = document.getElementById("gn-props");
        if (old) {
            old.parentNode.removeChild(old);
        }
        if (!gnProps.length && !gnPropsEditable) {
            return;
        }
        var box = document.createElement("div");
        box.id = "gn-props";
        box.className = "gn-props" + (gnPropsEditable ? "" : " gn-ro");
        gnProps.forEach((p, i) => {
            box.appendChild(gnPropRow(p, i));
        });
        if (gnPropsEditable) {
            var add = document.createElement("button");
            add.className = "gn-props-add";
            add.textContent = "+ Add property";
            add.addEventListener("click", () => {
                gnProps.push({ key: "", kind: "text", value: "", items: [], inline: false });
                var row = gnPropRow(gnProps[gnProps.length - 1], gnProps.length - 1);
                box.insertBefore(row, add);
                row.querySelector(".gn-prop-name").focus();
            });
            box.appendChild(add);
        }
        art.insertBefore(box, art.firstChild);
        if (gnPropsFocus) {
            var f = gnPropsFocus;
            gnPropsFocus = null;
            var sel = '.gn-prop[data-key="' + CSS.escape(f.key) + '"] ' + f.what;
            var el = box.querySelector(sel);
            if (el) {
                el.focus();
            }
        }
    }
    function gnPropRow(p, i) {
        var row = document.createElement("div");
        row.className = "gn-prop";
        row.setAttribute("data-key", p.key);
        var keyBox = document.createElement("div");
        keyBox.className = "gn-prop-key";
        // Editable: the type icon is a real button, so the keyboard and VoiceOver
        // reach the type menu too.
        var iconHtml = gnPropsEditable
            ? '<button type="button" class="gn-prop-type" aria-haspopup="menu" aria-label="Property type: ' +
              PROP_LABEL[p.kind] +
              '">' +
              gnIcon(p.kind) +
              "</button>"
            : gnIcon(p.kind);
        keyBox.innerHTML =
            iconHtml +
            '<span class="gn-prop-name" spellcheck="false"' +
            (gnPropsEditable ? ' contenteditable="plaintext-only" role="textbox" aria-label="Property name"' : "") +
            ">" +
            gnEsc(p.key) +
            "</span>";
        var name = keyBox.querySelector(".gn-prop-name");
        var icon = keyBox.querySelector(".gn-prop-type");
        if (gnPropsEditable) {
            name.addEventListener("keydown", (e) => {
                if (gnSugKey(e)) {
                    return;
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    name.blur();
                }
                if (e.key === "Escape") {
                    name.textContent = p.key;
                    name.blur();
                }
            });
            function suggestKey() {
                gnSugOpen(name, gnSugFilter(gnSugKeys(p), (name.textContent || "").trim()), (v) => {
                    name.textContent = v;
                    name.blur();
                });
            }
            name.addEventListener("input", suggestKey);
            name.addEventListener("focus", suggestKey);
            name.addEventListener("blur", () => {
                gnSugClose();
            });
            name.addEventListener("blur", () => {
                var k = (name.textContent || "").trim();
                if (!k) {
                    if (!p.key) {
                        gnProps.splice(gnProps.indexOf(p), 1);
                        row.parentNode && row.parentNode.removeChild(row);
                    } else {
                        name.textContent = p.key;
                    }
                    return;
                }
                if (k !== p.key) {
                    p.key = k;
                    row.setAttribute("data-key", k);
                    gnPropsFocus = { key: k, what: ".gn-prop-value input" };
                    gnPropsPost();
                }
            });
            icon.addEventListener("click", (e) => {
                e.stopPropagation();
                gnPropMenu(keyBox, p, icon);
            });
        }
        var val = document.createElement("div");
        val.className = "gn-prop-value" + (p.kind === "tags" ? " gn-prop-tags" : "");
        gnPropValue(val, p);
        row.appendChild(keyBox);
        row.appendChild(val);
        if (gnPropsEditable) {
            var rm = document.createElement("button");
            rm.type = "button";
            rm.className = "gn-prop-remove";
            rm.title = "Remove property";
            rm.textContent = "×";
            rm.setAttribute("aria-label", "Remove property " + (p.key || "(unnamed)"));
            rm.addEventListener("click", () => {
                var undoToken = gnPropsKeep();
                gnProps.splice(gnProps.indexOf(p), 1);
                gnPropsPost();
                gnPost({ type: "propsRemoved", key: p.key || "", undoToken: undoToken });
            });
            row.appendChild(rm);
        }
        return row;
    }
    function gnPropMenu(anchor, p, trigger) {
        var oldm = document.querySelector(".gn-prop-menu");
        if (oldm) {
            oldm.parentNode.removeChild(oldm);
        }
        var m = document.createElement("div");
        m.className = "gn-prop-menu";
        m.setAttribute("role", "menu");
        function dismiss() {
            if (m.parentNode) {
                m.parentNode.removeChild(m);
            }
            if (trigger) {
                trigger.focus();
            }
        }
        Object.keys(PROP_LABEL).forEach((k) => {
            var d = document.createElement("div");
            if (k === p.kind) {
                d.className = "gn-cur";
            }
            d.setAttribute("role", "menuitemradio");
            d.setAttribute("aria-checked", k === p.kind ? "true" : "false");
            d.tabIndex = -1;
            d.innerHTML = gnIcon(k) + "<span>" + PROP_LABEL[k] + "</span>";
            d.addEventListener("click", (e) => {
                e.stopPropagation();
                if (k === p.kind) {
                    dismiss();
                    return;
                }
                m.parentNode.removeChild(m);
                // The row is rebuilt by the next render; focus comes back to its type button.
                var q = gnConvert(p, k);
                var idx = gnProps.indexOf(p);
                gnProps[idx] = q;
                gnPropsFocus = { key: q.key, what: ".gn-prop-type" };
                gnPropsPost();
            });
            m.appendChild(d);
        });
        m.addEventListener("keydown", (e) => {
            var items = Array.prototype.slice.call(m.children);
            var at = items.indexOf(document.activeElement);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
            } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (at >= 0) {
                    items[at].click();
                }
            } else if (e.key === "Escape" || e.key === "Tab") {
                e.preventDefault();
                dismiss();
            }
        });
        anchor.appendChild(m);
        (m.querySelector(".gn-cur") || m.firstChild).focus();
        setTimeout(() => {
            document.addEventListener("click", function close() {
                if (m.parentNode) {
                    m.parentNode.removeChild(m);
                }
                document.removeEventListener("click", close);
            });
        }, 0);
    }
    function gnPropValue(val, p) {
        val.innerHTML = "";
        var ro = !gnPropsEditable;
        function commit() {
            gnPropsPost();
        }
        if (p.kind === "list" || p.kind === "tags") {
            (p.items || []).forEach((it, j) => {
                var c = document.createElement("span");
                c.className = "gn-chip";
                c.innerHTML =
                    "<span>" +
                    (p.kind === "tags" ? "#" : "") +
                    gnPropText(it) +
                    '</span><button type="button" class="gn-chip-x" title="Remove">×</button>';
                var x = c.querySelector(".gn-chip-x");
                x.setAttribute("aria-label", "Remove " + (p.kind === "tags" ? "tag " : "") + it);
                x.addEventListener("click", () => {
                    var undoToken = gnPropsKeep();
                    p.items.splice(j, 1);
                    gnPropsFocus = { key: p.key, what: ".gn-chip-in" };
                    commit();
                    gnPost({ type: "propsRemoved", key: p.key || "", item: String(it), undoToken: undoToken });
                });
                val.appendChild(c);
            });
            if (!ro) {
                var inp = document.createElement("input");
                inp.type = "text";
                inp.className = "gn-chip-in";
                inp.placeholder = p.items && p.items.length ? "" : p.kind === "tags" ? "Add tag…" : "Add item…";
                inp.setAttribute("spellcheck", "false");
                inp.setAttribute(
                    "aria-label",
                    (p.kind === "tags" ? "Add tag to " : "Add item to ") + (p.key || "new property")
                );
                // Only a tag drops its leading '#'; a list item keeps what was typed.
                var typed = () => {
                    var v = inp.value.trim();
                    return p.kind === "tags" ? v.replace(/^#/, "") : v;
                };
                // One path for Enter, comma, blur and a picked suggestion. The field is
                // emptied before the commit, so a blur that follows (the render waits
                // 220 ms in split view) cannot add the same item a second time.
                var addItem = (v, refocus) => {
                    inp.value = "";
                    if (!v) {
                        return;
                    }
                    p.items = (p.items || []).concat([v]);
                    if (refocus) {
                        gnPropsFocus = { key: p.key, what: ".gn-chip-in" };
                    }
                    commit();
                };
                var suggestItem = () => {
                    var pool = p.kind === "tags" ? gnVocab["tags"] || [] : gnVocab[p.key] || [];
                    gnSugOpen(
                        inp,
                        gnSugFilter(
                            pool.filter((v) => (p.items || []).indexOf(v) < 0),
                            typed()
                        ),
                        (v) => {
                            addItem(v, true);
                        }
                    );
                };
                inp.addEventListener("input", suggestItem);
                inp.addEventListener("focus", suggestItem);
                inp.addEventListener("blur", () => {
                    gnSugClose();
                });
                inp.addEventListener("keydown", (e) => {
                    if (gnSugKey(e)) {
                        return;
                    }
                    if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addItem(typed(), true);
                    } else if (e.key === "Backspace" && !inp.value && p.items && p.items.length) {
                        var undoToken = gnPropsKeep();
                        var gone = p.items.pop();
                        gnPropsFocus = { key: p.key, what: ".gn-chip-in" };
                        commit();
                        gnPost({ type: "propsRemoved", key: p.key || "", item: String(gone), undoToken: undoToken });
                    }
                });
                inp.addEventListener("blur", () => {
                    addItem(typed(), false);
                });
                val.appendChild(inp);
            }
            return;
        }
        // The key sits in another element, so every field names its property itself.
        var label = p.key || "New property";
        if (p.kind === "checkbox") {
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = p.value === "true";
            cb.disabled = ro;
            cb.setAttribute("aria-label", label);
            cb.addEventListener("change", () => {
                p.value = cb.checked ? "true" : "false";
                commit();
            });
            val.appendChild(cb);
            return;
        }
        if (ro && p.kind === "text") {
            var span = document.createElement("span");
            span.innerHTML = gnPropText(p.value || "");
            span.style.padding = "2px 6px";
            val.appendChild(span);
            return;
        }
        var input = document.createElement("input");
        input.type =
            p.kind === "number"
                ? "number"
                : p.kind === "date"
                  ? "date"
                  : p.kind === "datetime"
                    ? "datetime-local"
                    : "text";
        if (p.kind === "number") {
            input.step = "any";
        }
        input.value = p.value || "";
        input.disabled = ro;
        input.setAttribute("spellcheck", "false");
        input.setAttribute("aria-label", label);
        if (p.kind === "text") {
            input.placeholder = "Empty";
        }
        var start = input.value;
        input.addEventListener("keydown", (e) => {
            if (gnSugKey(e)) {
                return;
            }
            if (e.key === "Enter") {
                e.preventDefault();
                input.blur();
            }
            if (e.key === "Escape") {
                input.value = start;
                input.blur();
            }
        });
        if (p.kind === "text" && !ro) {
            var suggestValue = () => {
                gnSugOpen(input, gnSugFilter(gnVocab[p.key], input.value), (v) => {
                    input.value = v;
                    p.value = v;
                    commit();
                });
            };
            input.addEventListener("input", suggestValue);
            input.addEventListener("focus", suggestValue);
        }
        input.addEventListener("blur", () => {
            gnSugClose();
            if (input.value !== p.value) {
                p.value = input.value;
                commit();
            }
        });
        if (p.kind === "date" || p.kind === "datetime" || p.kind === "checkbox") {
            input.addEventListener("change", () => {
                if (input.value !== p.value) {
                    p.value = input.value;
                    commit();
                }
            });
        }
        val.appendChild(input);
    }
    // ---- Property suggestions -------------------------------------------------
    // The vault's own vocabulary: which keys notes use, and which values each key
    // is given. Swift hands it over with every render.
    var gnVocab = {};
    var gnSug = null,
        gnSugIndex = -1,
        gnSugPick = null;

    function gnSugClose() {
        if (gnSug && gnSug.parentNode) {
            gnSug.parentNode.removeChild(gnSug);
        }
        gnSug = null;
        gnSugIndex = -1;
        gnSugPick = null;
    }

    function gnSugOpen(anchor, values, pick) {
        gnSugClose();
        if (!values || !values.length) {
            return;
        }
        var box = document.createElement("div");
        box.id = "gn-suggest";
        values.slice(0, 12).forEach((v, i) => {
            var item = document.createElement("div");
            item.textContent = v;
            if (i === 0) {
                item.className = "gn-on";
            }
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                pick(v);
                gnSugClose();
            });
            box.appendChild(item);
        });
        document.body.appendChild(box);
        var r = anchor.getBoundingClientRect();
        var sc = document.scrollingElement || document.documentElement;
        box.style.left = Math.round(r.left + sc.scrollLeft) + "px";
        box.style.top = Math.round(r.bottom + sc.scrollTop + 4) + "px";
        gnSug = box;
        gnSugIndex = 0;
        gnSugPick = pick;
    }

    /// Returns true when the key was the list's, so the field ignores it.
    function gnSugKey(e) {
        if (!gnSug) {
            return false;
        }
        var items = gnSug.children;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            items[gnSugIndex].className = "";
            gnSugIndex = (gnSugIndex + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
            items[gnSugIndex].className = "gn-on";
            items[gnSugIndex].scrollIntoView({ block: "nearest" });
            return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            var v = items[gnSugIndex].textContent;
            var p = gnSugPick;
            gnSugClose();
            p(v);
            return true;
        }
        if (e.key === "Escape") {
            gnSugClose();
            return true;
        }
        return false;
    }

    function gnSugFilter(list, typed) {
        var q = (typed || "").toLowerCase();
        return (list || [])
            .filter((v) => q === "" || v.toLowerCase().indexOf(q) >= 0)
            .sort((a, b) => {
                var A = a.toLowerCase().indexOf(q) === 0,
                    B = b.toLowerCase().indexOf(q) === 0;
                return A === B ? 0 : A ? -1 : 1;
            });
    }

    /// Keys the note does not already carry.
    function gnSugKeys(current) {
        var used = {};
        gnProps.forEach((p) => {
            if (p !== current) {
                used[p.key] = 1;
            }
        });
        return Object.keys(gnVocab).filter((k) => !used[k]);
    }

    window.gnProperties = () => gnProps;

    // Bumped by every deliberate scroll (a heading, a find match). A render's own
    // scroll restore checks it and stands down when one happened meanwhile.
    // Not covered by a test: requestAnimationFrame never runs in the off-screen
    // WKWebView the tests use (measured 2026-09-08), so the restore this guards
    // only exists on screen.
    var gnNav = 0;
    // ---- The reading position across a render of the same note ----
    // A render replaces the article. Before it, the block at the top of the window is remembered: its tag, its text, its
    // source line and where its top sits. After it, the same block goes back to the same place, so lines an agent added
    // or removed above it never move the words under the reader. A block that is gone gives its place to the block
    // nearest its line, then to the same share of the page. A reader at the very bottom stays at the bottom, so a growing
    // log follows. A render that had to fall back (a half-written file read on the way, or one too short to scroll, which
    // has no bottom to stay at) keeps the anchor for the next render, as long as the page has not moved since. The
    // selection and a focused task box come back the same way.
    var gnAnchorHeld = null,
        gnAnchorTop = -1;
    function gnBlockText(el) {
        return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400);
    }
    function gnBlockKey(el) {
        return { tag: el.localName, line: parseInt(el.getAttribute("data-line"), 10) || 0, text: gnBlockText(el) };
    }
    // The block with the key's tag and text, the one nearest its old line when several have them.
    function gnBlockFor(key) {
        var art = document.getElementById("gn-article");
        if (!art || !key) {
            return null;
        }
        var nodes = art.querySelectorAll(key.tag + "[data-line]"),
            best = null,
            bestD = Infinity;
        for (var i = 0; i < nodes.length; i++) {
            if (gnBlockText(nodes[i]) !== key.text) {
                continue;
            }
            var d = Math.abs((parseInt(nodes[i].getAttribute("data-line"), 10) || 0) - key.line);
            if (d < bestD) {
                best = nodes[i];
                bestD = d;
            }
        }
        return best;
    }
    function gnBlockNear(line) {
        var art = document.getElementById("gn-article");
        if (!art) {
            return null;
        }
        var nodes = art.querySelectorAll("[data-line]"),
            best = null,
            bestD = Infinity;
        for (var i = 0; i < nodes.length; i++) {
            var d = Math.abs((parseInt(nodes[i].getAttribute("data-line"), 10) || 0) - line);
            if (d < bestD) {
                best = nodes[i];
                bestD = d;
            }
        }
        return best;
    }
    function gnCaptureAnchor() {
        var sc = document.scrollingElement || document.documentElement,
            art = document.getElementById("gn-article");
        if (gnAnchorHeld && Math.abs(sc.scrollTop - gnAnchorTop) <= 1) {
            return gnAnchorHeld;
        }
        gnAnchorHeld = null;
        if (!art || !art.firstElementChild || sc.scrollTop <= 0) {
            return null;
        }
        var view = sc.clientHeight,
            height = sc.scrollHeight,
            edge = gnStickyRoom();
        var a = {
            frac: height > view ? sc.scrollTop / (height - view) : 0,
            bottom: height > view + 1 && sc.scrollTop + view >= height - 2,
            key: null,
            offset: 0,
        };
        var nodes = art.querySelectorAll("[data-line]"),
            hit = null,
            below = null;
        for (var i = 0; i < nodes.length; i++) {
            var r = nodes[i].getBoundingClientRect();
            if (r.height <= 0) {
                continue;
            }
            if (r.top <= edge && r.bottom > edge) {
                hit = nodes[i];
            } else if (r.top > edge) {
                below = nodes[i];
                break;
            }
        }
        var el = hit || below;
        if (el) {
            a.key = gnBlockKey(el);
            a.offset = el.getBoundingClientRect().top;
        }
        return a;
    }
    function gnRestoreAnchor(a) {
        if (!a) {
            return;
        }
        var sc = document.scrollingElement || document.documentElement,
            view = sc.clientHeight,
            height = sc.scrollHeight,
            exact = true,
            top;
        // A page too short to scroll (a writer that empties the file first) has no bottom: the wish waits for the next one.
        if (a.bottom) {
            top = height - view;
            exact = top > 0;
        } else {
            var el = gnBlockFor(a.key);
            exact = !!el;
            if (!el && a.key) {
                el = gnBlockNear(a.key.line);
                // The same kind of block on the same line is that block with new words (typing in split view edits the block
                // at the top): it keeps its offset, or every keystroke would pull it to the edge.
                if (
                    el &&
                    el.localName === a.key.tag &&
                    (parseInt(el.getAttribute("data-line"), 10) || 0) === a.key.line
                ) {
                    exact = true;
                }
            }
            if (el) {
                top =
                    el.getBoundingClientRect().top +
                    sc.scrollTop -
                    (exact ? a.offset : Math.max(a.offset, gnStickyRoom()));
            } else {
                top = a.frac * Math.max(0, height - view);
            }
        }
        sc.scrollTop = Math.max(0, top);
        gnAnchorTop = sc.scrollTop;
        gnAnchorHeld = exact ? null : a;
    }
    // A selection end as (its block, characters into the block's text), and back.
    function gnPointKey(node, offset) {
        var el = node && (node.nodeType === 1 ? node : node.parentNode),
            block = el && el.closest ? el.closest("#gn-article [data-line]") : null;
        if (!block) {
            return null;
        }
        var r = document.createRange();
        r.selectNodeContents(block);
        try {
            r.setEnd(node, offset);
        } catch {
            return null;
        }
        return { key: gnBlockKey(block), chars: r.toString().length };
    }
    // Not gnPointAt: the find's own helper of that name (text offsets in the whole article) is declared further down,
    // and a second declaration in this scope would replace one of them.
    function gnBlockPoint(p) {
        var block = gnBlockFor(p.key);
        if (!block) {
            return null;
        }
        var w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT),
            n,
            left = p.chars,
            last = null;
        for (n = w.nextNode(); n; n = w.nextNode()) {
            if (left <= n.data.length) {
                return { node: n, offset: left };
            }
            left -= n.data.length;
            last = n;
        }
        return last ? { node: last, offset: last.data.length } : null;
    }
    function gnCaptureSelection() {
        var s = window.getSelection();
        if (!s || !s.rangeCount || s.isCollapsed) {
            return null;
        }
        var r = s.getRangeAt(0),
            a = gnPointKey(r.startContainer, r.startOffset),
            b = gnPointKey(r.endContainer, r.endOffset);
        return a && b ? { a: a, b: b } : null;
    }
    function gnRestoreSelection(sel) {
        if (!sel) {
            return;
        }
        var a = gnBlockPoint(sel.a),
            b = gnBlockPoint(sel.b);
        if (!a || !b) {
            return;
        }
        try {
            var r = document.createRange();
            r.setStart(a.node, a.offset);
            r.setEnd(b.node, b.offset);
            var s = window.getSelection();
            s.removeAllRanges();
            s.addRange(r);
        } catch {}
    }
    function gnCaptureFocus() {
        var f = document.activeElement;
        if (!f || !f.classList || !f.classList.contains("gn-task")) {
            return null;
        }
        var block = f.closest("#gn-article [data-line]");
        return block ? gnBlockKey(block) : null;
    }
    function gnRestoreFocus(key) {
        if (!key) {
            return;
        }
        var block = gnBlockFor(key),
            box = block && block.querySelector("input.gn-task");
        if (box) {
            box.focus({ preventScroll: true });
        }
    }
    // `tag` is Swift's render tag; `same` is false when this render shows another document than the last one (a page
    // taken over by another tab), which has no place of its own to keep yet.
    function gnRenderNow(markdown, props, editable, vocabulary, media, lines, tag, same) {
        if (same === false) {
            gnPropsUndos.clear();
            gnPropsPendingUndo = null;
        }
        window.gnLastRender = [markdown, props, editable, vocabulary, media, lines];
        if (vocabulary) {
            gnVocab = vocabulary;
        }
        gnCodeLines = !!lines;
        gnCodeSrc = [];
        gnMedia = media || {};
        var html = gnRenderText(markdown);
        // Replacing the article collapses the page height for an instant, which
        // clamps the scroll to the top. Split view re-renders while you type, and an
        // agent writes to an open note, so the reading position has to survive every
        // render: the same block at the same place (gnCaptureAnchor), in the same
        // JavaScript task as the new content, so no frame shows the page elsewhere.
        var sc = document.scrollingElement || document.documentElement;
        var keep = sc.scrollTop;
        var nav = gnNav;
        var kept = same !== false;
        if (!kept) {
            gnAnchorHeld = null;
        }
        var anchor = kept ? gnCaptureAnchor() : null,
            selection = kept ? gnCaptureSelection() : null,
            focus = kept ? gnCaptureFocus() : null;
        var art = document.getElementById("gn-article");
        art.textContent = "";
        art.appendChild(gnApplyMedia(gnSummaryMarkdown(gnSanitize(html))));
        // An empty note says so, so it never looks like a page that failed to draw. Drawn by CSS: the find and a copy
        // of the page never see it.
        art.classList.toggle("gn-is-empty", !String(markdown || "").trim());
        gnRenderProps(props, editable);
        gnSugClose();
        gnWireTasks();
        gnWireLinks();
        gnWireJSON();
        window.gnRunMermaid();
        gnLastSlug = "";
        gnPageAfterRender();
        gnApplyGit();
        gnApplyDiff();
        if (gnHL) {
            gnApplyHL(false);
        }
        if (anchor) {
            gnRestoreAnchor(anchor);
            // Mermaid and image layout land a frame later and can move the block: put it back once more, unless the
            // reader or a deliberate jump moved the page meanwhile.
            window.requestAnimationFrame(() => {
                if (gnNav !== nav || Math.abs(sc.scrollTop - gnAnchorTop) > 1) {
                    return;
                }
                gnRestoreAnchor(anchor);
                gnOnScroll();
            });
        } else if (keep > 0) {
            sc.scrollTop = keep;
            // Mermaid and image layout land a frame later and can shift the height.
            // A jump to a heading or to a find match counts as a deliberate move and
            // wins: Swift issues those right after the render, so without this guard
            // the correction would snap the reader back and cancel the jump.
            window.requestAnimationFrame(() => {
                if (gnNav !== nav) {
                    return;
                }
                if (Math.abs(sc.scrollTop - keep) > 1) {
                    sc.scrollTop = keep;
                }
                gnOnScroll();
            });
        }
        gnRestoreSelection(selection);
        gnRestoreFocus(focus);
        gnOnScroll();
    }
    // A render that throws left an empty article and no word about it (Genesis Markdown, 2026-10-13: a note stuck at
    // "+ Add property" in split view). Now the article says so, and Swift logs the error.
    // The 7th argument is Swift's tag for this render. The page keeps the last tag it got, also when the render
    // threw, so Swift can tell a render that never arrived from one that arrived and failed.
    window.gnRenderedTag = "";
    // A render that throws keeps whatever the article shows (the last good text, when the throw came before it was
    // replaced) and Swift puts "This page could not be drawn." with Retry over the page; the raw error sits behind
    // its Details. The return value tells Swift the render drew ("ok"), which takes such a notice away.
    window.gnRender = function () {
        window.gnRenderedTag = String(arguments[6] || "");
        try {
            gnRenderNow.apply(null, arguments);
            return "ok";
        } catch (e) {
            gnPost({
                type: "renderError",
                message: String((e && e.message) || e),
                stack: String((e && e.stack) || "").slice(0, 2000),
            });
            return "failed";
        }
    };
    window.addEventListener("error", (e) => {
        gnPost({ type: "pageError", message: String(e.message || ""), line: e.lineno || 0 });
    });
    window.gnTheme = (vars) => {
        var s = document.documentElement.style;
        for (var k in vars) {
            s.setProperty(k, vars[k]);
        }
    };
    // Column width. Swift owns the remembered value; the grips only preview the
    // drag live and report the final width on mouse-up (0 = back to the default).
    var gnCancelGripDrag = null;
    window.gnGrips = (on) => {
        // Hiding the grips mid-drag would leave the window listeners running: the
        // mouse-up would still report a width from an interaction that is no longer
        // on screen, overwriting the remembered reading width.
        if (!on && gnCancelGripDrag) {
            gnCancelGripDrag();
        }
        document.body.classList.toggle("gn-nogrips", !on);
    };
    window.gnWidth = (px) => {
        var s = document.documentElement.style;
        if (px && px > 0) {
            s.setProperty("--gn-article-width", Math.round(px) + "px");
        } else {
            s.removeProperty("--gn-article-width");
        }
    };
    (() => {
        var col = document.getElementById("gn-column");
        var grips = col.querySelectorAll(".gn-grip");
        for (var i = 0; i < grips.length; i++) {
            ((grip) => {
                var sign = grip.classList.contains("gn-grip-r") ? 1 : -1;
                grip.addEventListener("mousedown", (e) => {
                    if (e.button !== 0) {
                        return;
                    }
                    e.preventDefault();
                    var startX = e.clientX,
                        startW = col.getBoundingClientRect().width,
                        w = startW;
                    // The exact inline value before the drag, so an abandoned drag restores
                    // it verbatim (an empty string means the stylesheet default was in use).
                    var prev = document.documentElement.style.getPropertyValue("--gn-article-width");
                    var minW = 420,
                        maxW = Math.max(minW, document.body.clientWidth - 60);
                    grip.classList.add("gn-active");
                    document.body.classList.add("gn-resizing");
                    // The column is centred, so one edge moving by dx widens it by 2*dx.
                    function move(ev) {
                        w = Math.max(minW, Math.min(maxW, startW + sign * (ev.clientX - startX) * 2));
                        document.documentElement.style.setProperty("--gn-article-width", Math.round(w) + "px");
                    }
                    function stop() {
                        window.removeEventListener("mousemove", move);
                        window.removeEventListener("mouseup", up);
                        grip.classList.remove("gn-active");
                        document.body.classList.remove("gn-resizing");
                        gnCancelGripDrag = null;
                    }
                    function up() {
                        stop();
                        gnPost({ type: "width", value: Math.round(w) });
                    }
                    // Abandoned (split view took the grips away): put the width back and say nothing.
                    gnCancelGripDrag = () => {
                        stop();
                        if (prev) {
                            document.documentElement.style.setProperty("--gn-article-width", prev);
                        } else {
                            document.documentElement.style.removeProperty("--gn-article-width");
                        }
                    };
                    window.addEventListener("mousemove", move);
                    window.addEventListener("mouseup", up);
                });
                grip.addEventListener("dblclick", (e) => {
                    e.preventDefault();
                    window.gnWidth(null);
                    gnPost({ type: "width", value: 0 });
                });
                // Keyboard: the arrows move this edge like a drag would (Shift = bigger
                // steps), Enter resets like a double-click.
                grip.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        window.gnWidth(null);
                        gnPost({ type: "width", value: 0 });
                        return;
                    }
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
                        return;
                    }
                    e.preventDefault();
                    var dx = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 60 : 20);
                    var minW = 420,
                        maxW = Math.max(minW, document.body.clientWidth - 60);
                    var w = Math.round(
                        Math.max(minW, Math.min(maxW, col.getBoundingClientRect().width + sign * dx * 2))
                    );
                    window.gnWidth(w);
                    gnPost({ type: "width", value: w });
                });
            })(grips[i]);
        }
    })();
    // Put the block that owns source line `n` at the top of the page. Blocks in
    // between interpolate, so a slow scroll in the editor is a slow scroll here.
    // `gnSyncGuard` keeps the scroll-spy from reporting a section during the jump.
    window.gnSyncLine = (n) => {
        gnInputAt = 0;
        gnDragging = false;
        gnLastTopLine = n;
        if (gnTopFrame) {
            clearTimeout(gnTopFrame);
            gnTopFrame = 0;
        }
        var art = document.getElementById("gn-article");
        if (!art) {
            return;
        }
        var nodes = art.querySelectorAll("[data-line]");
        if (!nodes.length) {
            return;
        }
        var sc = document.scrollingElement || document.documentElement;
        var prev = null,
            next = null;
        for (var i = 0; i < nodes.length; i++) {
            var line = parseInt(nodes[i].getAttribute("data-line"), 10);
            if (isNaN(line)) {
                continue;
            }
            if (line <= n) {
                prev = { line: line, el: nodes[i] };
            } else {
                next = { line: line, el: nodes[i] };
                break;
            }
        }
        var first = parseInt(nodes[0].getAttribute("data-line"), 10);
        var top;
        // At (or above) the first block, show the top of the page: the properties
        // block and the title live above it and belong on screen.
        if (!prev || n <= first) {
            top = 0;
        } else {
            var a = prev.el.getBoundingClientRect().top + sc.scrollTop;
            if (next && next.line > prev.line) {
                var b = next.el.getBoundingClientRect().top + sc.scrollTop;
                top = a + (b - a) * Math.min(1, (n - prev.line) / (next.line - prev.line));
            } else {
                top = a;
            }
        }
        sc.scrollTop = top <= 0 ? 0 : Math.max(0, top - 12 - gnStickyRoom());
    };
    // Lines a link or an open URL asked for. `blocks`: 0-based body lines, and
    // every block whose source lines overlap is marked, the innermost one only (a
    // list item, not the whole list). `lines`: the numbered lines of a code block.
    // `rows`: table rows, the header row being file line 1. The marked elements
    // get `gn-hl` (a code line's number is emphasised), and ONE band is drawn over
    // all of them, so a range of paragraphs reads as one block, not a bar per
    // paragraph. The marks survive a re-render; only a new range scrolls. A click
    // anywhere fades the band out, and Swift forgets the range (`hlcleared`).
    var gnHL = null,
        gnBand = null;
    function gnDropBand() {
        if (gnBand && gnBand.parentNode) {
            gnBand.parentNode.removeChild(gnBand);
        }
        gnBand = null;
    }
    function gnPlaceBand(hit, mode) {
        var top = Infinity,
            bottom = -Infinity,
            left = Infinity,
            right = -Infinity;
        for (var i = 0; i < hit.length; i++) {
            var r = hit[i].getBoundingClientRect();
            top = Math.min(top, r.top);
            bottom = Math.max(bottom, r.bottom);
            left = Math.min(left, r.left);
            right = Math.max(right, r.right);
        }
        var box = mode === "lines" ? hit[0].closest("pre") : mode === "rows" ? hit[0].closest("table") : null;
        if (box) {
            var b = box.getBoundingClientRect();
            left = b.left + 1;
            right = b.right - 1;
            top -= 2;
            bottom += 2;
        } else {
            left -= 16;
            right += 10;
            top -= 8;
            bottom += 8;
        }
        if (!gnBand) {
            gnBand = document.createElement("div");
            gnBand.id = "gn-hl-band";
            document.body.appendChild(gnBand);
        }
        var sc = document.scrollingElement || document.documentElement;
        gnBand.style.top = top + sc.scrollTop + "px";
        gnBand.style.left = left + sc.scrollLeft + "px";
        gnBand.style.width = Math.max(0, right - left) + "px";
        gnBand.style.height = Math.max(0, bottom - top) + "px";
    }
    function gnApplyHL(scroll) {
        var old = document.querySelectorAll(".gn-hl");
        for (var i = 0; i < old.length; i++) {
            old[i].classList.remove("gn-hl");
        }
        var art = document.getElementById("gn-article");
        if (!gnHL || !art) {
            if (gnBand && !gnBand.classList.contains("gn-fading")) {
                gnDropBand();
            }
            return;
        }
        if (gnBand && gnBand.classList.contains("gn-fading")) {
            gnDropBand();
        }
        var a = gnHL.a,
            b = gnHL.b,
            hit = [],
            n,
            j;
        if (gnHL.mode === "lines") {
            var ls = art.querySelectorAll(".gn-ln");
            for (j = 0; j < ls.length; j++) {
                n = parseInt(ls[j].getAttribute("data-ln"), 10);
                if (n >= a && n <= b) {
                    hit.push(ls[j]);
                }
            }
        } else if (gnHL.mode === "rows") {
            var rows = art.querySelectorAll("table tr");
            for (j = 0; j < rows.length; j++) {
                n = j + 1;
                if (n >= a && n <= b) {
                    hit.push(rows[j]);
                }
            }
        } else {
            var nodes = art.querySelectorAll("[data-line]"),
                cand = [];
            for (j = 0; j < nodes.length; j++) {
                var s = parseInt(nodes[j].getAttribute("data-line"), 10),
                    e = parseInt(nodes[j].getAttribute("data-line-end"), 10);
                if (isNaN(s)) {
                    continue;
                }
                if (isNaN(e) || e <= s) {
                    e = s + 1;
                }
                if (s <= b && e > a) {
                    cand.push(nodes[j]);
                }
            }
            for (j = 0; j < cand.length; j++) {
                var inner = false;
                for (var k = 0; k < cand.length; k++) {
                    if (k !== j && cand[j].contains(cand[k])) {
                        inner = true;
                        break;
                    }
                }
                if (!inner) {
                    hit.push(cand[j]);
                }
            }
        }
        for (j = 0; j < hit.length; j++) {
            hit[j].classList.add("gn-hl");
        }
        if (hit.length) {
            gnPlaceBand(hit, gnHL.mode);
        } else {
            gnDropBand();
        }
        if (scroll && hit.length) {
            gnNav++;
            var sc = document.scrollingElement || document.documentElement;
            sc.scrollTop = Math.max(0, hit[0].getBoundingClientRect().top + sc.scrollTop - 80);
        }
    }
    window.addEventListener("resize", () => {
        if (gnHL) {
            gnApplyHL(false);
        }
    });
    // Capture phase, nothing prevented: the click still selects text and follows links.
    document.addEventListener(
        "mousedown",
        () => {
            if (!gnHL || !gnBand || gnBand.classList.contains("gn-fading")) {
                return;
            }
            var band = gnBand;
            band.classList.add("gn-fading");
            var old = document.querySelectorAll(".gn-hl");
            for (var i = 0; i < old.length; i++) {
                old[i].classList.remove("gn-hl");
            }
            gnHL = null;
            setTimeout(() => {
                if (band.parentNode) {
                    band.parentNode.removeChild(band);
                }
                if (gnBand === band) {
                    gnBand = null;
                }
            }, 600);
            gnPost({ type: "hlcleared" });
        },
        true
    );
    // The image viewer (GenesisKit). The first click lets Swift decode the picture, so the double-click opens
    // with it; the double-click sends every viewable picture in document order with its table row, and the
    // clicked one's rect in CSS pixels. gnImageRect answers where a picture is now, for the zoom back.
    function gnViewerImage(t) {
        return t && t.closest ? t.closest("#gn-article img[data-gn-img]") : null;
    }
    function gnViewerRect(im) {
        var r = im.getBoundingClientRect();
        return {
            x: r.left,
            y: r.top,
            w: r.width,
            h: r.height,
            radius: parseFloat(getComputedStyle(im).borderTopLeftRadius) || 0,
        };
    }
    document.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.detail !== 1) {
            return;
        }
        var im = gnViewerImage(e.target);
        if (im) {
            gnPost({ type: "image.press", src: im.getAttribute("src") || "" });
        }
    });
    document.addEventListener("dblclick", (e) => {
        var im = gnViewerImage(e.target);
        if (!im) {
            // A picture the viewer does not open (a web picture): the double-click still gets an answer.
            var other = e.target && e.target.closest ? e.target.closest("#gn-article img") : null;
            if (other) {
                e.preventDefault();
                gnPost({ type: "image.refused", src: other.getAttribute("src") || "" });
            }
            return;
        }
        e.preventDefault();
        gnOpenViewer(im);
    });
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") {
            return;
        }
        var im = gnViewerImage(e.target);
        if (!im) {
            return;
        }
        e.preventDefault();
        gnOpenViewer(im);
    });
    function gnOpenViewer(im) {
        var rows = Array.prototype.slice.call(document.querySelectorAll("#gn-article tr"));
        var all = document.querySelectorAll("#gn-article img[data-gn-img]");
        var images = [];
        for (var i = 0; i < all.length; i++) {
            var tr = all[i].closest("tr");
            images.push({
                n: +all[i].getAttribute("data-gn-img"),
                src: all[i].getAttribute("src") || "",
                alt: all[i].getAttribute("alt") || "",
                row: tr ? "r" + rows.indexOf(tr) : null,
            });
        }
        gnPost({ type: "image.open", n: +im.getAttribute("data-gn-img"), images: images, rect: gnViewerRect(im) });
    }
    window.gnImageRect = (n) => {
        var im = document.querySelector('#gn-article img[data-gn-img="' + +n + '"]');
        return JSON.stringify(im ? gnViewerRect(im) : null);
    };
    // The page as a rendered diff (Swift's DiffMark list, new body lines plus the old text): added blocks tinted green,
    // changed ones blue with their old version above them struck through in red, removed text struck through where it
    // stood. One paragraph changed into one paragraph gets word marks instead of a struck-through block.
    var gnDiffList = [];
    window.gnDiff = (list) => {
        gnDiffList = list || [];
        var a = document.getElementById("gn-article");
        if (a && window.gnLastRender) {
            gnRenderNow.apply(null, window.gnLastRender);
        } else {
            gnApplyDiff();
        }
    };
    function gnBlocks(art) {
        var nodes = art.querySelectorAll("[data-line]"),
            spans = [];
        for (var j = 0; j < nodes.length; j++) {
            if (nodes[j].closest(".gn-diff-old")) {
                continue;
            }
            var s = parseInt(nodes[j].getAttribute("data-line"), 10),
                e = parseInt(nodes[j].getAttribute("data-line-end"), 10);
            if (isNaN(s)) {
                continue;
            }
            if (isNaN(e) || e <= s) {
                e = s + 1;
            }
            spans.push({ n: nodes[j], s: s, e: e });
        }
        return spans;
    }
    function gnInnermost(cand) {
        var out = [];
        for (var j = 0; j < cand.length; j++) {
            var inner = true;
            for (var k = 0; k < cand.length; k++) {
                if (k !== j && cand[j].contains(cand[k])) {
                    inner = false;
                    break;
                }
            }
            if (inner) {
                out.push(cand[j]);
            }
        }
        return out;
    }
    function gnWordDiff(a, b) {
        var ta = a.split(/(\s+)/),
            tb = b.split(/(\s+)/),
            n = ta.length,
            m = tb.length;
        if (n * m > 250000) {
            return null;
        }
        var dp = [];
        for (var i = 0; i <= n; i++) {
            dp.push(new Int32Array(m + 1));
        }
        for (i = n - 1; i >= 0; i--) {
            for (var j = m - 1; j >= 0; j--) {
                dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        var del = [],
            ins = [],
            pa = 0,
            pb = 0;
        i = 0;
        j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && ta[i] === tb[j]) {
                pa += ta[i].length;
                pb += tb[j].length;
                i++;
                j++;
            } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
                if (/\S/.test(tb[j])) {
                    ins.push([pb, pb + tb[j].length]);
                }
                pb += tb[j].length;
                j++;
            } else {
                if (/\S/.test(ta[i])) {
                    del.push([pa, pa + ta[i].length]);
                }
                pa += ta[i].length;
                i++;
            }
        }
        return { del: del, ins: ins };
    }
    function gnWrapRanges(root, ranges, cls) {
        if (!ranges.length) {
            return;
        }
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null),
            nodes = [],
            t;
        for (t = walker.nextNode(); t; t = walker.nextNode()) {
            nodes.push(t);
        }
        var pos = 0;
        for (var i = 0; i < nodes.length; i++) {
            t = nodes[i];
            var len = t.nodeValue.length,
                start = pos,
                end = pos + len;
            pos = end;
            var cuts = [];
            for (var k = 0; k < ranges.length; k++) {
                var r = ranges[k];
                if (r[1] <= start || r[0] >= end) {
                    continue;
                }
                cuts.push([Math.max(r[0], start) - start, Math.min(r[1], end) - start]);
            }
            for (var c = cuts.length - 1; c >= 0; c--) {
                var mid = t.splitText(cuts[c][0]);
                mid.splitText(cuts[c][1] - cuts[c][0]);
                var mark = document.createElement("mark");
                mark.className = cls;
                mid.parentNode.replaceChild(mark, mid);
                mark.appendChild(mid);
            }
        }
    }
    function gnApplyDiff() {
        var art = document.getElementById("gn-article");
        if (!art) {
            return;
        }
        if (!gnDiffList.length) {
            gnLayoutGit();
            return;
        }
        var spans = gnBlocks(art);
        for (var h = 0; h < gnDiffList.length; h++) {
            var d = gnDiffList[h],
                hit = [],
                anchor = null,
                j;
            if (d.k !== "deleted") {
                var cand = [];
                for (j = 0; j < spans.length; j++) {
                    if (spans[j].s <= d.b && spans[j].e > d.a) {
                        cand.push(spans[j].n);
                    }
                }
                hit = gnInnermost(cand);
                // A strip in the bar column, no background: a whole changed block reads by its strip, a changed word by its
                // mark, and a table's changed rows got a background each, which read as odd and even rows (Martin, 2026-10-13).
                for (j = 0; j < hit.length; j++) {
                    hit[j].classList.add(d.k === "added" ? "gn-diff-add" : "gn-diff-mod");
                    hit[j].setAttribute("data-gn-diff", d.k === "added" ? "added" : "modified");
                    hit[j].setAttribute("data-gn-diff-i", String(h));
                }
                anchor = hit[0] || null;
            } else {
                var after = null;
                for (j = 0; j < spans.length; j++) {
                    if (spans[j].s >= d.a && (!after || spans[j].s < after.s)) {
                        after = spans[j];
                    }
                }
                anchor = after ? after.n : null;
            }
            if (!d.old) {
                continue;
            }
            var box = document.createElement("div");
            box.className = "gn-diff-old";
            box.setAttribute("data-gn-diff", "removed");
            box.setAttribute("data-gn-diff-i", h + "o");
            box.appendChild(gnSanitize(md.render(d.old)));
            if (anchor && anchor.parentNode) {
                anchor.parentNode.insertBefore(box, anchor);
            } else {
                art.appendChild(box);
            }
            // One paragraph for one paragraph: word marks on both, no struck-through block.
            if (d.k === "modified" && hit.length === 1 && box.children.length === 1 && !/\n\s*\n/.test(d.old)) {
                var wd = gnWordDiff(box.textContent, hit[0].textContent);
                if (wd) {
                    box.classList.add("gn-diff-pair");
                    gnWrapRanges(box, wd.del, "gn-del");
                    gnWrapRanges(hit[0], wd.ins, "gn-ins");
                }
            }
        }
        gnLayoutGit();
    }
    // Bars beside the blocks that differ from HEAD (Swift's GitMark list): a block whose source lines overlap a change
    // gets the change's kind, the innermost such block as gnApplyHL picks them. A removal marks the first block at or
    // after it. Re-applied after every render; a click left of a marked block posts the mark's index.
    var gnGit = [];
    window.gnGitMarks = (list) => {
        gnGit = list || [];
        gnApplyGit();
    };
    function gnApplyGit() {
        var art = document.getElementById("gn-article");
        if (!art) {
            return;
        }
        var old = art.querySelectorAll("[data-gn-git]");
        for (var i = 0; i < old.length; i++) {
            old[i].removeAttribute("data-gn-git");
            old[i].removeAttribute("data-gn-git-i");
        }
        if (!gnGit.length) {
            gnLayoutGit();
            return;
        }
        var nodes = art.querySelectorAll("[data-line]"),
            spans = [];
        for (var j = 0; j < nodes.length; j++) {
            var s = parseInt(nodes[j].getAttribute("data-line"), 10),
                e = parseInt(nodes[j].getAttribute("data-line-end"), 10);
            if (isNaN(s)) {
                continue;
            }
            if (isNaN(e) || e <= s) {
                e = s + 1;
            }
            spans.push({ n: nodes[j], s: s, e: e });
        }
        for (var h = 0; h < gnGit.length; h++) {
            var m = gnGit[h],
                cand = [];
            if (m.k === "deleted") {
                var after = null;
                for (j = 0; j < spans.length; j++) {
                    if (spans[j].s >= m.a && (!after || spans[j].s < after.s)) {
                        after = spans[j];
                    }
                }
                if (after) {
                    cand.push(after.n);
                }
            } else {
                for (j = 0; j < spans.length; j++) {
                    if (spans[j].s <= m.b && spans[j].e > m.a) {
                        cand.push(spans[j].n);
                    }
                }
            }
            for (j = 0; j < cand.length; j++) {
                var inner = true;
                for (var k = 0; k < cand.length; k++) {
                    if (k !== j && cand[j].contains(cand[k])) {
                        inner = false;
                        break;
                    }
                }
                if (inner && !cand[j].hasAttribute("data-gn-git")) {
                    cand[j].setAttribute("data-gn-git", m.k);
                    cand[j].setAttribute("data-gn-git-i", String(m.i));
                }
            }
        }
        gnLayoutGit();
    }
    // The bars: one per change, in one column 16 px left of the text, spanning every block the change touches. A bar on
    // the block itself stood inside a list's indent over the item number, and a table row cannot hold a positioned
    // ::before. A resize of the article (pictures, diagrams, the reading width) places them again.
    var gnGitObserved = false;
    function gnLayoutGit() {
        var art = document.getElementById("gn-article"),
            col = document.getElementById("gn-column");
        if (!art || !col) {
            return;
        }
        var layer = document.getElementById("gn-git-layer");
        if (!layer) {
            layer = document.createElement("div");
            layer.id = "gn-git-layer";
            col.appendChild(layer);
        }
        if (!gnGitObserved && window.ResizeObserver) {
            gnGitObserved = true;
            new ResizeObserver(() => {
                requestAnimationFrame(gnLayoutGit);
            }).observe(art);
        }
        var focused = layer.contains(document.activeElement) ? document.activeElement.getAttribute("data-i") : null;
        layer.textContent = "";
        // Git marks (Swift's list, clickable) and the rendered diff's marks (index "d…", not clickable) share the column.
        var marked = art.querySelectorAll("[data-gn-git],[data-gn-diff]");
        if (!marked.length) {
            return;
        }
        var c = col.getBoundingClientRect(),
            a = art.getBoundingClientRect();
        var x = a.left + (parseFloat(getComputedStyle(art).paddingLeft) || 0) - c.left - 16,
            groups = {},
            order = [];
        for (var i = 0; i < marked.length; i++) {
            var el = marked[i],
                git = el.hasAttribute("data-gn-git"),
                r = el.getBoundingClientRect();
            var idx = git ? el.getAttribute("data-gn-git-i") : "d" + el.getAttribute("data-gn-diff-i");
            if (!r.width && !r.height) {
                continue;
            }
            var g = groups[idx];
            if (!g) {
                g = groups[idx] = {
                    k: git ? el.getAttribute("data-gn-git") : el.getAttribute("data-gn-diff"),
                    t: r.top,
                    b: r.bottom,
                };
                order.push(idx);
            } else {
                g.t = Math.min(g.t, r.top);
                g.b = Math.max(g.b, r.bottom);
            }
        }
        for (var j = 0; j < order.length; j++) {
            idx = order[j];
            var interactive = idx.charAt(0) !== "d",
                gg = groups[idx];
            var bar = document.createElement(interactive ? "button" : "div");
            bar.className = "gn-git-bar";
            bar.setAttribute("data-k", gg.k);
            bar.setAttribute("data-i", idx);
            if (interactive) {
                bar.type = "button";
                var mark = gnGit.find((m) => String(m.i) === idx);
                var range = mark
                    ? mark.a === mark.b
                        ? "Body line " + (mark.a + 1)
                        : "Body lines " + (mark.a + 1) + "–" + (mark.b + 1)
                    : "Change";
                bar.setAttribute("aria-label", range + " " + gg.k + ". Show previous content and revert options");
            } else {
                bar.setAttribute("aria-hidden", "true");
            }
            bar.style.left = x + "px";
            if (gg.k === "deleted") {
                bar.style.top = gg.t - c.top - 5 + "px";
            } else {
                bar.style.top = gg.t - c.top + 2 + "px";
                bar.style.height = Math.max(4, gg.b - gg.t - 4) + "px";
            }
            layer.appendChild(bar);
            if (interactive && focused === idx) {
                bar.focus({ preventScroll: true });
            }
        }
    }
    document.addEventListener(
        "click",
        (e) => {
            var bar = e.target && e.target.closest ? e.target.closest(".gn-git-bar") : null;
            if (bar) {
                if (bar.tagName !== "BUTTON") {
                    return;
                }
                var br = bar.getBoundingClientRect();
                e.preventDefault();
                e.stopPropagation();
                gnPost({
                    type: "gitMark",
                    index: parseInt(bar.getAttribute("data-i"), 10),
                    rect: { x: br.left - 2, y: br.top, w: 8, h: Math.max(br.height, 8) },
                });
                return;
            }
            var el = e.target && e.target.closest ? e.target.closest("[data-gn-git]") : null;
            if (!el) {
                return;
            }
            var r = el.getBoundingClientRect();
            if (e.clientX > r.left) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            gnPost({
                type: "gitMark",
                index: parseInt(el.getAttribute("data-gn-git-i"), 10),
                rect: { x: r.left - 18, y: r.top, w: 8, h: r.height },
            });
        },
        true
    );
    window.gnHighlightLines = (a, b, mode, scroll) => {
        gnHL = a === null || a === undefined ? null : { a: a, b: b, mode: mode };
        gnApplyHL(!!scroll);
    };
    window.gnScrollTo = (px) => {
        var sc = document.scrollingElement || document.documentElement;
        sc.scrollTop = Math.max(0, px || 0);
    };
    window.gnScrollTop = () => {
        var sc = document.scrollingElement || document.documentElement;
        return sc.scrollTop;
    };
    // `label` is the heading as the link or the outline named it, for the answer when the note has no such heading.
    window.gnScrollToSlug = (slug, label) => {
        var el = slug ? document.getElementById(slug) : null;
        if (el && document.getElementById("gn-article").contains(el)) {
            gnNav++;
            el.scrollIntoView({ behavior: gnScrollBehavior(), block: "start" });
            return true;
        }
        gnPost({ type: "deadAnchor", slug: String(slug || ""), label: String(label || slug || "") });
        return false;
    };
    // Find bar: wrap every occurrence in a <mark>, then walk them. The marks are
    // plain DOM, so a re-render drops them and Swift re-issues the search.
    // `opts` comes from Swift (MarkdownFindCommand.jsOptions): matchCase,
    // wholeWord and regex follow the source search's rules (SourceFind.swift),
    // `scope` is find in selection (a new token takes the DOM selection of that
    // moment, as text offsets in the article; null = the whole page) and `ticks`
    // draws the matches on the right edge. Missing options are all off.
    var gnFindIdx = -1;
    var gnFindOpts = {};
    var gnFindScope = null,
        gnFindScopeTok = null;
    // A word on either side of a whole-word match: letters, digits, marks and _
    // in any script, the class SourceFind uses. `\b` is ASCII-only here, so it
    // would split a Czech word at every háček.
    var gnWordCh = "[\\p{L}\\p{N}\\p{M}_]";
    function gnClearFind() {
        var art = document.getElementById("gn-article");
        if (!art) {
            return;
        }
        var ms = art.querySelectorAll("mark.gn-find");
        for (var i = 0; i < ms.length; i++) {
            var m = ms[i];
            m.parentNode.replaceChild(document.createTextNode(m.textContent), m);
        }
        art.normalize();
    }
    // Text offsets in the article. Rebuilding the marks replaces the text nodes a
    // selection points into, which used to shrink the reader's selection on every
    // keystroke; it is kept as offsets and put back, so find in selection still
    // sees what the reader selected.
    function gnTextOffset(art, node, off) {
        var r = document.createRange();
        r.selectNodeContents(art);
        try {
            r.setEnd(node, off);
        } catch {
            return 0;
        }
        return r.toString().length;
    }
    function gnSelOffsets(art) {
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) {
            return null;
        }
        var r = sel.getRangeAt(0);
        if (r.collapsed || !r.intersectsNode(art)) {
            return null;
        }
        var n = (art.textContent || "").length;
        var s = Math.min(n, gnTextOffset(art, r.startContainer, r.startOffset));
        var e = Math.min(n, gnTextOffset(art, r.endContainer, r.endOffset));
        return e > s ? { s: s, e: e } : null;
    }
    // On a boundary between two text nodes a start goes to the next node and an
    // end stays in the earlier one: the end of the "\n" between two paragraphs is
    // not a visible place, and WebKit moved such a start back into the paragraph
    // before, so the selection grew by a line break.
    function gnPointAt(art, off, start) {
        var w = document.createTreeWalker(art, NodeFilter.SHOW_TEXT, null),
            n,
            acc = 0,
            last = null;
        for (n = w.nextNode(); n; n = w.nextNode()) {
            var l = (n.nodeValue || "").length;
            if (start ? off < acc + l : off <= acc + l) {
                return { node: n, offset: off - acc };
            }
            acc += l;
            last = n;
        }
        return last ? { node: last, offset: (last.nodeValue || "").length } : { node: art, offset: 0 };
    }
    function gnRestoreSel(art, o) {
        if (!o) {
            return;
        }
        var a = gnPointAt(art, o.s, true),
            b = gnPointAt(art, o.e, false);
        var r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
    }
    // The query as one RegExp, or null when the regex does not compile. A regex
    // is checked on its own first, so a stray `)` cannot pair up with the
    // whole-word wrapper and pass.
    function gnFindRegex(q, o) {
        var src = q;
        if (o.regex) {
            try {
                new RegExp(q, "u");
            } catch {
                return null;
            }
        } else {
            src = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        if (o.wholeWord) {
            src = "(?<!" + gnWordCh + ")(?:" + src + ")(?!" + gnWordCh + ")";
        }
        try {
            return new RegExp(src, "g" + (o.matchCase ? "" : "i") + (o.regex ? "m" : "") + "u");
        } catch {
            return null;
        }
    }
    // `keep` is a re-render of the same search (live preview while typing): the
    // marks are rebuilt, the selected match stays selected and nothing scrolls.
    // Only a new search or next/previous moves the page.
    window.gnFind = (q, keep, opts) => {
        var o = opts || {};
        gnFindOpts = o;
        var art = document.getElementById("gn-article");
        var sel = art ? gnSelOffsets(art) : null;
        if (o.scope === null || o.scope === undefined) {
            gnFindScope = null;
            gnFindScopeTok = null;
        } else if (o.scope !== gnFindScopeTok) {
            gnFindScopeTok = o.scope;
            gnFindScope = sel;
        }
        gnClearFind();
        q = q || "";
        if (!o.regex) {
            q = q.trim();
        }
        var re = q && art ? gnFindRegex(q, o) : null;
        if (!re) {
            gnFindIdx = -1;
            if (art) {
                gnRestoreSel(art, sel);
            }
            gnPlaceTicks();
            // -1: the pattern itself was refused, so the counter says so instead of "no match".
            gnPost({ type: "find", index: q && art ? -1 : 0, count: 0 });
            return;
        }
        // Matched in the original text: lowercasing can change a string's length
        // (İ becomes two code units), so offsets into a lowercased copy drift.
        var walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT, null);
        var nodes = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
        }
        var sc = gnFindScope,
            acc = 0;
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var text = node.nodeValue || "";
            var base = acc;
            acc += text.length;
            var parent = node.parentNode;
            if (!parent || parent.nodeName === "SCRIPT" || parent.nodeName === "STYLE") {
                continue;
            }
            if (sc && (acc <= sc.s || base >= sc.e)) {
                continue;
            }
            re.lastIndex = 0;
            var m = re.exec(text);
            var frag = null,
                last = 0;
            while (m) {
                var len = m[0].length;
                // An empty match (`^`, `a*`) has nothing to mark; step past it.
                if (!len) {
                    re.lastIndex++;
                    m = re.exec(text);
                    continue;
                }
                if (!sc || (base + m.index >= sc.s && base + m.index + len <= sc.e)) {
                    if (!frag) {
                        frag = document.createDocumentFragment();
                    }
                    if (m.index > last) {
                        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                    }
                    var mk = document.createElement("mark");
                    mk.className = "gn-find";
                    mk.textContent = m[0];
                    frag.appendChild(mk);
                    last = m.index + len;
                }
                m = re.exec(text);
            }
            if (!frag) {
                continue;
            }
            if (last < text.length) {
                frag.appendChild(document.createTextNode(text.slice(last)));
            }
            parent.replaceChild(frag, node);
        }
        gnRestoreSel(art, sel);
        if (keep && gnFindIdx >= 0) {
            var ms = art.querySelectorAll("mark.gn-find");
            if (!ms.length) {
                gnFindIdx = -1;
                gnPlaceTicks();
                gnPost({ type: "find", index: 0, count: 0 });
                return;
            }
            gnFindIdx = Math.min(gnFindIdx, ms.length - 1);
            ms[gnFindIdx].classList.add("gn-find-current");
            gnPlaceTicks();
            gnPost({ type: "find", index: gnFindIdx + 1, count: ms.length });
            return;
        }
        gnFindIdx = -1;
        window.gnFindStep(1);
    };
    window.gnFindStep = (delta) => {
        var ms = document.querySelectorAll("#gn-article mark.gn-find");
        if (!ms.length) {
            gnPost({ type: "find", index: 0, count: 0 });
            return;
        }
        // Nothing chosen yet: forward starts at the first match, back at the last.
        gnFindIdx =
            gnFindIdx < 0
                ? delta >= 0
                    ? 0
                    : ms.length - 1
                : (((gnFindIdx + delta) % ms.length) + ms.length) % ms.length;
        for (var i = 0; i < ms.length; i++) {
            ms[i].classList.remove("gn-find-current");
        }
        var cur = ms[gnFindIdx];
        cur.classList.add("gn-find-current");
        gnNav++;
        cur.scrollIntoView({ behavior: gnScrollBehavior(), block: "center" });
        gnPlaceTicks();
        gnPost({ type: "find", index: gnFindIdx + 1, count: ms.length });
    };
    // A tick was clicked: that match becomes the current one.
    function gnFindGo(i) {
        gnFindIdx = i - 1;
        window.gnFindStep(1);
    }
    // Match ticks on the right edge (`opts.ticks`). The lane stands for the whole
    // page, so a tick sits at the match's share of the scroll height. Ticks on the
    // same pixel collapse into one; the current one is drawn last, on top. Placed
    // after every search and step, and again when the page's height changes
    // (images, mermaid, a resize), coalesced into one frame. No timers.
    function gnTick(y, i, current) {
        var t = document.createElement("div");
        t.className = current ? "gn-find-tick gn-find-tick-current" : "gn-find-tick";
        t.style.top = y + "px";
        t.setAttribute("data-i", String(i));
        return t;
    }
    function gnPlaceTicks() {
        var box = document.getElementById("gn-find-ticks");
        var ms = gnFindOpts.ticks ? document.querySelectorAll("#gn-article mark.gn-find") : [];
        if (!ms.length) {
            if (box) {
                box.parentNode.removeChild(box);
            }
            return;
        }
        if (!box) {
            box = document.createElement("div");
            box.id = "gn-find-ticks";
            box.setAttribute("aria-hidden", "true");
            box.addEventListener("click", (e) => {
                var i = e.target && e.target.getAttribute ? e.target.getAttribute("data-i") : null;
                if (i === null) {
                    return;
                }
                e.preventDefault();
                gnFindGo(+i);
            });
            document.body.appendChild(box);
        }
        var sc = document.scrollingElement || document.documentElement;
        var total = Math.max(1, sc.scrollHeight),
            h = sc.clientHeight;
        var frag = document.createDocumentFragment(),
            seen = {},
            cur = null;
        for (var i = 0; i < ms.length; i++) {
            var y = Math.max(
                1,
                Math.min(h - 3, Math.round(((ms[i].getBoundingClientRect().top + sc.scrollTop) / total) * h))
            );
            if (i === gnFindIdx) {
                cur = { y: y, i: i };
                continue;
            }
            if (seen[y]) {
                continue;
            }
            seen[y] = 1;
            frag.appendChild(gnTick(y, i, false));
        }
        if (cur) {
            frag.appendChild(gnTick(cur.y, cur.i, true));
        }
        box.textContent = "";
        box.appendChild(frag);
    }
    var gnTicksQueued = false;
    function gnTicksSoon() {
        if (gnTicksQueued || !document.getElementById("gn-find-ticks")) {
            return;
        }
        gnTicksQueued = true;
        window.requestAnimationFrame(() => {
            gnTicksQueued = false;
            gnPlaceTicks();
        });
    }
    window.addEventListener("resize", gnTicksSoon);
    (() => {
        var art = document.getElementById("gn-article");
        if (art && window.ResizeObserver) {
            new ResizeObserver(gnTicksSoon).observe(art);
        }
    })();
    window.gnHighlight = (q) => {
        q = (q || "").toLowerCase().trim();
        if (!q) {
            return;
        }
        var els = document.querySelectorAll(
            "#gn-article p,#gn-article li,#gn-article h1,#gn-article h2,#gn-article h3,#gn-article td"
        );
        for (var i = 0; i < els.length; i++) {
            if ((els[i].textContent || "").toLowerCase().indexOf(q) !== -1) {
                els[i].scrollIntoView({ behavior: gnScrollBehavior(), block: "center" });
                ((el) => {
                    el.classList.remove("gn-flash");
                    void el.offsetWidth;
                    el.classList.add("gn-flash");
                    setTimeout(() => {
                        el.classList.remove("gn-flash");
                    }, 1300);
                })(els[i]);
                break;
            }
        }
    };
    // The page says it is ready itself, besides the navigation's didFinish: a render waiting for that callback alone
    // waited forever when it never came.
    gnPost({ type: "ready" });
    return textPasses;
});
