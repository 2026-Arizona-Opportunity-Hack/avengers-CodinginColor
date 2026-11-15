import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDeploymentEnv } from '../deploy/check-env.ts';

const env = {
  DATABASE_URL: 'postgresql://cic_app:fixture@localhost/cic',
  CIC_ORG_ID: '00000000-0000-4000-8000-000000000001',
  CLERK_SECRET_KEY: 'sk_test_fixture',
  CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
  CLERK_JWT_ISSUER: 'https://example.clerk.accounts.dev',
  APP_ORIGIN: 'https://example.vercel.app',
};

test('deployment accepts valid runtime configuration and the supplied public-key alias', () => {
  checkDeploymentEnv(env);
  checkDeploymentEnv({ ...env, CLERK_PUBLISHABLE_KEY: undefined,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY });
});

test('missing or invalid runtime settings fail before publishing, without their values', () => {
  for (const name of Object.keys(env)) {
    assert.throws(() => checkDeploymentEnv({ ...env, [name]: undefined }), new RegExp(name));
  }
  for (const name of ['APP_ORIGIN', 'CLERK_JWT_ISSUER']) {
    assert.throws(() => checkDeploymentEnv({ ...env, [name]: 'PRIVATE_INVALID_VALUE' }), error => {
      assert.match((error as Error).message, new RegExp(name));
      assert.doesNotMatch((error as Error).message, /PRIVATE_INVALID_VALUE/);
      return true;
    });
  }
  assert.throws(() => checkDeploymentEnv({ ...env, CLERK_PUBLISHABLE_KEY: 'pk_live_fixture' }), /same Clerk instance mode/);
  assert.throws(() => checkDeploymentEnv({ ...env, VERCEL: '1', APP_ORIGIN: 'http://localhost:4200' }), /APP_ORIGIN/);
});

test('static demo mode remains an explicit configuration choice', () => {
  checkDeploymentEnv({ CIC_WEB_DEMO_MODE: '1' });
  assert.throws(() => checkDeploymentEnv({}), /Invalid API configuration/);
});
