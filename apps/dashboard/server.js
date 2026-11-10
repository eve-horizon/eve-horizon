import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { internalRouteProxyHooks, refuseInternalApi } from './server/internal-api-guard.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { contentSecurityPolicy, ssoOriginSource } from './server/content-security-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3200;
const apiUrl = process.env.EVE_API_URL || 'http://eve-api:4701';

// The API's /internal/* routes are for platform services only: 404 for
// /api/internal and anything under it, however spelled, and for request
// targets that are not a plain path (server/internal-api-guard.js).
app.use(refuseInternalApi);

// Proxy /api/* to the Eve API. Express strips the /api mount, so req.url is
// already the API path. The proxy hooks also refuse any upstream path under
// the API's /internal.
app.use('/api', createProxyMiddleware({
  target: apiUrl,
  changeOrigin: true,
  on: internalRouteProxyHooks(apiUrl),
  // Support SSE streaming
  onProxyRes(proxyRes) {
    if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
      proxyRes.headers['cache-control'] = 'no-cache';
      proxyRes.headers['connection'] = 'keep-alive';
    }
  },
}));

// Pages carry a Content-Security-Policy whose connect-src names the SSO
// origin: EVE_SSO_URL, or the one the API reports, learned in the background
// (see server/content-security-policy.js).
app.use(contentSecurityPolicy(ssoOriginSource({ ssoUrl: process.env.EVE_SSO_URL, apiUrl })));

// Serve static files
app.use(express.static(join(__dirname, 'dist')));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => {
  console.log(`Dashboard listening on port ${port}, proxying API to ${apiUrl}`);
});
