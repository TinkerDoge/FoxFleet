# Media proxy (SSRF) and the browser CSP

## The problem

Agent replies are Markdown and may contain `![](https://…)`. Loading such an image directly would (a) require `img-src https:` in the CSP, letting injected markup beacon to any server, and (b) leak the reader's IP, cookies and referrer to a third party.

## The choice

The web app's CSP stays `img-src 'self' data: blob:`. The Markdown renderer rewrites remote images to `/api/media-proxy?url=…` and **the hub fetches them**. The page CSP is:

```text
default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:;
media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self';
object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
```

## SSRF protections (`server/media-proxy.js`)

- `https` only, port 443 only, no credentials in the URL.
- The hub resolves the name itself and refuses unless **every** address is globally routable: loopback, RFC 1918, CGNAT, link-local (incl. cloud metadata), multicast, ULA, mapped, NAT64, 6to4 and documentation ranges are blocked.
- The socket is **pinned** to the validated address (no DNS rebinding), with SNI and `Host` of the original name.
- Redirects: at most two, each hop re-validated.
- Only PNG, JPEG, GIF, WebP and AVIF. Never SVG or HTML.
- 8 MB cap, 10 s total timeout, no cookies forwarded.
- The reply is served with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: private`.
- A signed-in session is required.

## Markdown sanitizing

`marked` renders, then **DOMPurify** sanitizes (tests cover script tags, event handlers, `javascript:` URLs, SVG and data URLs). Links are limited to `http:`, `https:`, `mailto:` and in-page `#` anchors, and open with `target="_blank" rel="noopener noreferrer"`.
