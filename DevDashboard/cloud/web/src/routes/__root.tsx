import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { RouteError } from "@/components/RouteError";
import { RouteNotFound } from "@/components/RouteNotFound";
import appCss from "@/styles/app.css?url";

interface RouterContext {
    queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
    head: () => ({
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { title: "DevDashboard — Your machine. Your keys. We can't see your data." },
            {
                name: "description",
                content:
                    "Stream your dev machine to your phone: live tmux/cmux terminals, system Pulse metrics, and agent-session alerts. Privacy-first, trust-verifiable transport — LAN, Tailscale, your own Cloudflare tunnel, or managed with end-to-end encryption.",
            },
        ],
        links: [
            { rel: "stylesheet", href: appCss },
            { rel: "preconnect", href: "https://api.fontshare.com", crossOrigin: "anonymous" },
            {
                rel: "stylesheet",
                href: "https://api.fontshare.com/v2/css?f[]=clash-display@600,700&f[]=general-sans@400,500,600&f[]=satoshi@400,500&display=swap",
            },
        ],
    }),

    shellComponent: RootDocument,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    notFoundComponent: () => <RouteNotFound />,
});

const revealScript = `
(function () {
  function init() {
    var els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (el) { io.observe(el); });
  }
  if (document.readyState !== 'loading') { init(); } else { document.addEventListener('DOMContentLoaded', init); }
})();
`;

function RootDocument({ children }: { children: ReactNode }) {
    return (
        <html lang="en" className="scroll-smooth">
            <head>
                <HeadContent />
            </head>
            <body className="text-zinc-300 antialiased">
                <div className="mesh" aria-hidden="true">
                    <div
                        className="orb orb-emerald"
                        style={{ width: "46rem", height: "46rem", top: "-14rem", left: "-10rem" }}
                    />
                    <div
                        className="orb orb-violet"
                        style={{ width: "42rem", height: "42rem", top: "30%", right: "-12rem", opacity: 0.4 }}
                    />
                    <div
                        className="orb orb-emerald"
                        style={{ width: "34rem", height: "34rem", bottom: "-12rem", left: "25%", opacity: 0.32 }}
                    />
                </div>
                <div className="grain" aria-hidden="true" />
                {children}
                {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, author-controlled scroll-reveal bootstrap */}
                <script dangerouslySetInnerHTML={{ __html: revealScript }} />
                <Scripts />
            </body>
        </html>
    );
}
