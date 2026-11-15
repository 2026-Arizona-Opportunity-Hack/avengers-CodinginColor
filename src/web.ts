// Serves the built web app (public/) from the same Express function as the API (#30), so the
// deployment works even when the host routes every request to the function. API and health
// paths always fall through to the API; dotfiles are never served.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';

const API = /^\/(?:api(?:\/|$)|healthz$)/;
const ASSET = /\.[a-z0-9]+$/i;

export function webApp(dir: string, assets?: RequestHandler): express.Router {
  const router = express.Router();
  const index = join(dir, 'index.html');
  // Mutable startup files bypass stat validators, including when static middleware is supplied.
  const page: RequestHandler = async (req, res, next) => {
    const recovery = req.path === '/chunk-recovery.js';
    const file = recovery ? join(dir, 'chunk-recovery.js') : index;
    if ((req.method !== 'GET' && req.method !== 'HEAD') || API.test(req.path) ||
      (ASSET.test(req.path) && req.path !== '/index.html' && !recovery) || !existsSync(file)) return next();
    // Deployment archives fix mtimes, so same-size HTML can share a stale stat ETag.
    res.setHeader('Cache-Control', 'no-store');
    res.type(recovery ? 'js' : 'html').send(await readFile(file));
  };
  router.use(page);
  router.use(assets ?? express.static(dir, {
    dotfiles: 'ignore', index: false, fallthrough: true,
    setHeaders: (res, path) => {
      if (/\.(?:html|json)$/i.test(path)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  return router;
}
