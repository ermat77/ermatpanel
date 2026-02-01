# HTTP-only Helmet configuration

When the manager is served over **HTTP only** (no TLS on nginx), the backend must disable two Helmet defaults so the browser does not upgrade requests to HTTPS. Otherwise assets (JS/CSS) fail with "CORS request did not succeed" because the browser sends them to port 443 where nothing is listening.

## Configuration (backend)

In `manager/backend/src/index.ts`, the Helmet middleware is configured with:

### 1. `strictTransportSecurity: false`

- **Default:** Helmet sends the `Strict-Transport-Security` (HSTS) header.
- **Effect:** The browser stores "always use HTTPS for this host" and upgrades all subsequent requests (including `/assets/*`) to HTTPS.
- **Fix:** Set `strictTransportSecurity: false` so HSTS is not sent when serving over HTTP.

### 2. `upgradeInsecureRequests: null` (in Content-Security-Policy directives)

- **Default:** Helmet adds the CSP directive `upgrade-insecure-requests`.
- **Effect:** The browser upgrades all HTTP requests (e.g. script/link to `/assets/...`) to HTTPS.
- **Fix:** Set `upgradeInsecureRequests: null` in `contentSecurityPolicy.directives` so that directive is omitted. In Helmet, `null` is the way to exclude a directive from the header.

## When you add HTTPS

Once you serve the manager over HTTPS (TLS on nginx, port 443):

1. **Re-enable HSTS:** Remove `strictTransportSecurity: false` or set it to the desired options so the browser enforces HTTPS.
2. **Re-enable upgrade-insecure-requests (optional):** Remove `upgradeInsecureRequests: null` from the CSP directives so the browser upgrades any remaining HTTP URLs to HTTPS.

## Reference

- Helmet: <https://helmetjs.github.io/>
- HSTS: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security>
- CSP upgrade-insecure-requests: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/upgrade-insecure-requests>
