// Vercel build step (#30): publish the built web app from public/ (same origin as the API) and write
// the runtime config.json the web app reads to switch from demo data to the live API (#59).
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type WebConfig = { apiBase: string; clerkPublishableKey: string };

/** Same-origin config: apiBase "" means the API is served from this host. Only public values belong here. */
export function webConfig(env: Record<string, string | undefined>): WebConfig {
  const key = env.CLERK_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!key || !/^pk_(test|live)_\S+$/.test(key)) {
    // Never echo the value: a secret key pasted by mistake must not reach build logs.
    throw new Error('CLERK_PUBLISHABLE_KEY must be set to a Clerk publishable key (pk_test_… or pk_live_…)');
  }
  return { apiBase: '', clerkPublishableKey: key };
}

/**
 * Copy the web build into the output directory and write config.json. Without a key the build fails,
 * unless CIC_WEB_DEMO_MODE=1 asks for the app's built-in demo data on purpose. The output directory is
 * generated (gitignored) and emptied first, so a previous live build's config.json can't survive a demo build.
 */
export async function buildForVercel(options: { dist: string; out: string; env: Record<string, string | undefined> }) {
  const demo = options.env.CIC_WEB_DEMO_MODE === '1';
  const config = demo ? null : webConfig(options.env);
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  await cp(options.dist, options.out, { recursive: true });
  if (config) await writeFile(join(options.out, 'config.json'), JSON.stringify(config));
  return { demo };
}

if (import.meta.main) {
  try {
    const { demo } = await buildForVercel({ dist: 'apps/web/dist/web/browser', out: 'public', env: process.env });
    console.log(demo ? 'Web app published in DEMO mode (CIC_WEB_DEMO_MODE=1): no config.json written.'
      : 'Web app published to public/ with config.json (same-origin API, Clerk publishable key).');
  } catch (error) {
    console.error(`Vercel build failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
