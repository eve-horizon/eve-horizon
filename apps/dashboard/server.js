import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { refuseInternalApi } from './server/internal-api-guard.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { contentSecurityPolicy, ssoOriginFromApi } from './server/content-security-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3200;
const apiUrl = process.env.EVE_API_URL || 'http://eve-api:4701';

// The API's /internal/* routes are for platform services only: 404 for
// /api/internal and anything under it, however spelled (server/internal-api-guard.js).
app.use(refuseInternalApi);

// Proxy /api/* to the Eve API
app.use('/api', createProxyMiddleware({
  target: apiUrl,
  changeOrigin: true,
  pathRewrite: { '^/api': '' },
  // Support SSE streaming
  onProxyRes(proxyRes) {
    if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
      proxyRes.headers['cache-control'] = 'no-cache';
      proxyRes.headers['connection'] = 'keep-alive';
    }
  },
}));

// Pages carry a Content-Security-Policy whose connect-src names the SSO
// origin the API reports (see server/content-security-policy.js).
app.use(contentSecurityPolicy(ssoOriginFromApi(apiUrl)));

// Serve static files
app.use(express.static(join(__dirname, 'dist')));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => {
  console.log(`Dashboard listening on port ${port}, proxying API to ${apiUrl}`);
});
