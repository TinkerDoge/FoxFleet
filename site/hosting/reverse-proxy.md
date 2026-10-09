# Caddy and nginx

Run the hub on loopback and let the proxy terminate TLS. Three things must pass through: **WebSocket upgrades**, **unbuffered SSE**, and **large request bodies** (90 MiB file uploads).

Set `FOXFLEET_TRUSTED_ORIGINS=https://hub.example.com` on the hub in both cases.

## Caddy

```text
hub.example.com {
    request_body {
        max_size 100MB
    }
    reverse_proxy 127.0.0.1:3080 {
        flush_interval -1          # stream SSE immediately
    }
}
```

Caddy upgrades WebSockets and sends `X-Forwarded-Proto` automatically.

## nginx

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl http2;
    server_name hub.example.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;            # SSE chat streaming
        proxy_read_timeout 3600s;       # long replies, WebSockets
    }
}
```

## Checklist

- [ ] `https://hub.example.com/health` returns `{"ok":true}`
- [ ] Chat text appears token by token (if it arrives all at once, buffering is on)
- [ ] A connector shows *Ready* (WebSocket works)
- [ ] A 50 MB file uploads

Rate limits see only the proxy's address ([details](./cloudflare-tunnel#things-to-know)).

::: warning Status
These are standard configurations written from the hub's behaviour; they have not been run against a live hub by the maintainers.
:::
