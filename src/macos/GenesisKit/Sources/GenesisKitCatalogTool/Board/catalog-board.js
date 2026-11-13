// biome-ignore-all lint/style/noRestrictedGlobals: This unbundled board page uses the browser's native JSON implementation.
// The manifest arrives base64-encoded in catalog-data.js (window.genesisKitCatalog), written beside this file.
const bytes = Uint8Array.from(atob(window.genesisKitCatalog), (c) => c.charCodeAt(0));
const manifest = JSON.parse(new TextDecoder().decode(bytes));
const query = document.querySelector("#query"),
    group = document.querySelector("#group"),
    look = document.querySelector("#look"),
    root = document.querySelector("#catalog");
function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) {
        node.textContent = text;
    }

    if (className) {
        node.className = className;
    }

    return node;
}
[...new Set(manifest.entries.map((e) => e.group))].sort().forEach((name) => {
    const option = el("option", name);
    option.value = name;
    group.append(option);
});
manifest.looks.forEach((item) => {
    const option = el("option", item.title);
    option.value = item.id;
    look.append(option);
});
const articles = manifest.entries.map((entry) => {
    const article = el("article");
    article.id = entry.id;
    article.append(
        el("p", entry.group, "group"),
        el("h2", entry.name),
        el("p", entry.summary, "summary"),
        el("p", entry.source, "source")
    );
    const critique = el("ul", undefined, "critique");
    for (const text of entry.critique) {
        critique.append(el("li", text));
    }

    article.append(critique);
    const sheets = el("div", undefined, "sheets");
    entry.sheets.forEach((sheet) => {
        const figure = el("figure");
        figure.dataset.look = sheet.look;
        const caption = el("figcaption"),
            link = el("a", sheet.title);
        link.href = sheet.file;
        caption.append(link);
        figure.append(caption);
        if (sheet.note) {
            figure.append(el("p", sheet.note));
        }

        const image = el("img");
        image.src = sheet.file;
        image.alt = `${entry.name} — ${sheet.title}`;
        image.width = sheet.pixelWidth;
        image.height = sheet.pixelHeight;
        image.loading = "lazy";
        image.decoding = "async";
        figure.append(image);
        sheets.append(figure);
    });
    article.append(sheets);
    const details = el("details");
    details.append(el("summary", "States and variants"));
    entry.sections.forEach((section) => {
        details.append(el("h3", section.title));
        const list = el("ul");
        for (const variant of section.variants) {
            list.append(el("li", variant.title + (variant.props ? ` · ${variant.props}` : "")));
        }

        details.append(list);
    });
    article.append(details);
    root.append(article);
    return {
        entry,
        article,
        sheets,
        search: [
            entry.name,
            entry.group,
            entry.summary,
            entry.source,
            ...entry.critique,
            ...entry.sections.flatMap((s) => s.variants.map((v) => v.title)),
        ]
            .join(" ")
            .toLocaleLowerCase(),
    };
});
const empty = el("p", "No components match these filters.", "empty");
empty.hidden = true;
root.append(empty);
function filter() {
    const term = query.value.trim().toLocaleLowerCase();
    let count = 0;
    articles.forEach((item) => {
        const visible = (!group.value || item.entry.group === group.value) && (!term || item.search.includes(term));
        item.article.hidden = !visible;
        if (visible) {
            count++;
        }

        item.sheets.classList.toggle("single", Boolean(look.value));
        for (const figure of item.sheets.children) {
            figure.hidden = Boolean(look.value) && figure.dataset.look !== look.value;
        }
    });
    document.querySelector("#count").textContent = `${count} of ${articles.length} components`;
    empty.hidden = count !== 0;
}
query.addEventListener("input", filter);
group.addEventListener("change", filter);
look.addEventListener("change", filter);
filter();
