import { createClerkClient, verifyToken } from '@clerk/backend';
import { z } from 'zod';
import { HttpError, type Env } from './env.ts';

export type Identity = { subject: string; mfa: boolean; verifiedEmail?: string };
export interface AuthProvider {
  verify(token: string): Promise<unknown>;
  session(id: string): Promise<{ status: string; userId: string; expireAt: number }>;
  user(id: string): Promise<{
    id: string; banned: boolean; locked: boolean; twoFactorEnabled: boolean;
    primaryEmailAddressId: string | null;
    emailAddresses: { id: string; emailAddress?: string; verification: { status: string } | null }[];
  }>;
}
const Claims = z.object({
  sub: z.string().min(1), sid: z.string().min(1), iss: z.string(), azp: z.string(),
  fva: z.tuple([z.number().int(), z.number().int()]).optional(),
});

export function clerkProvider(env: Env): AuthProvider {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  return {
    verify: (token) => verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY, issuer: env.CLERK_JWT_ISSUER,
      authorizedParties: [env.APP_ORIGIN],
    }),
    session: (id) => clerk.sessions.getSession(id),
    user: (id) => clerk.users.getUser(id),
  };
}

export function createVerifier(env: Env, provider: AuthProvider) {
  return async (authorization: string | undefined): Promise<Identity> => {
    const bearer = /^Bearer ([^\s]+)$/.exec(authorization ?? '');
    if (!bearer) throw new HttpError(401);
    let raw: unknown;
    try { raw = await provider.verify(bearer[1]); } catch { throw new HttpError(401); }
    const result = Claims.safeParse(raw);
    if (!result.success || result.data.iss !== env.CLERK_JWT_ISSUER || result.data.azp !== env.APP_ORIGIN) {
      throw new HttpError(401);
    }
    const claims = result.data;
    let session, user;
    try {
      [session, user] = await Promise.all([provider.session(claims.sid), provider.user(claims.sub)]);
    } catch { throw new HttpError(503); }
    const verifiedEmail = user.emailAddresses.some((email) =>
      email.id === user.primaryEmailAddressId && email.verification?.status === 'verified');
    if (session.status !== 'active' || session.userId !== claims.sub || session.expireAt <= Date.now() ||
      user.id !== claims.sub || user.banned || user.locked || !verifiedEmail) throw new HttpError(401);
    const primary=user.emailAddresses.find(email=>email.id===user.primaryEmailAddressId);
    return { subject: claims.sub, mfa: user.twoFactorEnabled && (claims.fva?.[1] ?? -1) >= 0,
      ...(primary?.emailAddress ? {verifiedEmail:primary.emailAddress.toLowerCase().trim()} : {}) };

  };
}
