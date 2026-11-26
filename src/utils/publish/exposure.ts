import type { ShareServerConfig } from "../genesis-tools/publish/store";

export const TUNNEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function listenOrigin(host: string, port: number): string {
    const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return `http://${authority}:${port}`;
}

export function proxySnippet(input: {
    proxy: "apache" | "nginx" | "caddy" | "other";
    server: ShareServerConfig;
}): string {
    const { server, proxy } = input;
    const { host, port } = server.listen;
    const backend = listenOrigin(host, port);
    const hostname = new URL(server.publicOrigin).hostname;

    switch (proxy) {
        case "apache":
            return `# In the VirtualHost for ${hostname}
ProxyPreserveHost On
ProxyPass "/" "${backend}/"
ProxyPassReverse "/" "${backend}/"`;
        case "nginx":
            return `# In the server block for ${hostname}
location / {
    client_max_body_size 64m;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass ${backend};
}`;
        case "caddy":
            return `${hostname} {
    reverse_proxy ${backend}
}`;
        default:
            return `Proxy ${server.publicOrigin} to ${backend} and preserve the Host header.`;
    }
}
