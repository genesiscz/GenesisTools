// mermaid.min.js (UMD) already set globalThis.mermaid synchronously above.
if (window.mermaid) {
    window.mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        class: { useMaxWidth: false },
        er: { useMaxWidth: false },
        state: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
        journey: { useMaxWidth: false },
        themeVariables: {
            background: "#101316",
            primaryColor: "#101316",
            primaryTextColor: "#e6edf3",
            primaryBorderColor: "#34d399",
            lineColor: "#5b6670",
            secondaryColor: "#161b20",
            tertiaryColor: "#0c0e10",
            nodeBorder: "#34d399",
            clusterBkg: "#101316",
            clusterBorder: "#1e2428",
        },
        securityLevel: "strict",
    });
    window.gnMermaid = window.mermaid;
    if (window.gnRunMermaid) {
        window.gnRunMermaid();
    }
}
