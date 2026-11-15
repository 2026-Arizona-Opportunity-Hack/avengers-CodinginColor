import { EnvSchema } from '../apps/api/env.ts';
import { webConfig } from './vercel-build.ts';

/** Check names only: build logs must never contain configuration values. */
export function checkDeploymentEnv(env: Record<string, string | undefined>) {
  if (env.CIC_WEB_DEMO_MODE === '1') return;
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map(issue => String(issue.path[0])))];
    throw new Error(`Invalid API configuration: ${names.join(', ')}`);
  }
  if (env.VERCEL === '1' && !parsed.data.APP_ORIGIN.startsWith('https://')) {
    throw new Error('APP_ORIGIN must be the HTTPS deployment origin on Vercel');
  }
  const { clerkPublishableKey } = webConfig(env);
  if (clerkPublishableKey.startsWith('pk_live_') !== parsed.data.CLERK_SECRET_KEY.startsWith('sk_live_')) {
    throw new Error('CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY must use the same Clerk instance mode');
  }
}

if (import.meta.main) {
  try {
    checkDeploymentEnv(process.env);
    console.log('Deployment configuration check passed.');
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
