import express from 'express';
import cookieParser from 'cookie-parser';
import {
  COOKIE_SAMESITE,
  EVE_API_URL,
  EVE_DEFAULT_DOMAIN,
  PORT,
  SECURE_COOKIES,
  SIGNUP_ALLOWED_DOMAINS,
  SUPABASE_AUTH_URL,
} from './config.js';
import { registerCallbackRoutes } from './routes/callback.js';
import { registerLandingRoutes } from './routes/landing.js';
import { registerLoginRoutes } from './routes/login.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerSetPasswordRoutes } from './routes/set-password.js';
import { registerWrapRoutes } from './routes/wrap.js';

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------

const app = express();
app.use(cookieParser());
app.use(express.json());

registerWrapRoutes(app);
registerLandingRoutes(app);
registerLoginRoutes(app);
registerCallbackRoutes(app);
registerSetPasswordRoutes(app);
registerSessionRoutes(app);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[eve-sso] Listening on port ${PORT}`);
  console.log(`[eve-sso] Domain: ${EVE_DEFAULT_DOMAIN}`);
  console.log(`[eve-sso] GoTrue (internal): ${SUPABASE_AUTH_URL}`);
  console.log(`[eve-sso] GoTrue (proxied via /auth/*)`);

  console.log(`[eve-sso] Eve API: ${EVE_API_URL}`);
  console.log(`[eve-sso] Secure cookies: ${SECURE_COOKIES} (SameSite=${COOKIE_SAMESITE})`);
  console.log(`[eve-sso] Signup domain restriction: ${SIGNUP_ALLOWED_DOMAINS.length > 0 ? SIGNUP_ALLOWED_DOMAINS.join(', ') : 'none (all domains allowed)'}`);
});
