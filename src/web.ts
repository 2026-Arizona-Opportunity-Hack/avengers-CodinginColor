// Serves the built web app (public/) from the same Express function as the API (#30), so the
// deployment works even when the host routes every request to the function. API and health
// paths always fall through to the API; dotfiles are never served.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';

const API = /^\/(?:api(?:\/|$)|healthz$)/;
const ASSET = /\.[a-z0-9]+$/i;

export function webApp(dir: string): express.Router {
  const router = express.Router();
  const index = join(dir, 'index.html');
  router.use(express.static(dir, {
    dotfiles: 'ignore', index: false, fallthrough: true,
    setHeaders: (res, path) => {
      // config.json and index.html change on every deploy; hashed assets can be cached.
      if (/\.(?:html|json)$/i.test(path)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  // Page routes (no file extension) and the explicit /index.html get the single-page app.
  const page: RequestHandler = (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || API.test(req.path) ||
      (ASSET.test(req.path) && req.path !== '/index.html') || !existsSync(index)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  };
  router.use(page);
  return router;
}
