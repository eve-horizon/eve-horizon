import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3200;
const apiUrl = process.env.EVE_API_URL || 'http://eve-api:4701';

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

// Serve static files
app.use(express.static(join(__dirname, 'dist')));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => {
  console.log(`Dashboard listening on port ${port}, proxying API to ${apiUrl}`);
});
