import { z } from 'zod';

export const EnvSchema = z.object({
  DATABASE_URL: z.url().refine((url) => /^postgres(?:ql)?:/.test(url)),
  CIC_ORG_ID: z.uuid(),
  CLERK_SECRET_KEY: z.string().regex(/^sk_(?:test|live)_\S+$/),
  CLERK_JWT_ISSUER: z.url().refine((url) => URL.canParse(url) && new URL(url).protocol === 'https:'),
  APP_ORIGIN: z.url().refine((url) => {
    if (!URL.canParse(url)) return false;
    const parsed = new URL(url);
    return parsed.origin === url && (parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)));
  }),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export type Env = z.infer<typeof EnvSchema>;
export class HttpError extends Error {
  status: number;
  constructor(status: number) { super('Request rejected'); this.status = status; }
}
