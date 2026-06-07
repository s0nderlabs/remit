// Privy session verification (server side). The dashboard sends the user's Privy
// access token as the API bearer; we verify it OFFLINE against the app's JWKS
// (ES256, iss "privy.io", aud = app id) — no Privy app secret, no per-request
// Privy API call. The verified claim is only WHO the user is (sub = did:privy:...);
// the wallet binding is proven separately at onboard (see routes.ts).

import { createRemoteJWKSet, jwtVerify } from "jose";

export type PrivyAuth = { did: string };
/** Returns the verified identity, or null for any invalid/expired/foreign token. */
export type PrivyVerifier = (token: string) => Promise<PrivyAuth | null>;

export function makePrivyVerifier(appId: string): PrivyVerifier {
  // jose caches the JWKS and refetches on unknown-kid / cooldown — one fetch, not one per request
  const jwks = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: "privy.io",
        audience: appId,
        algorithms: ["ES256"],
      });
      return typeof payload.sub === "string" && payload.sub.startsWith("did:privy:")
        ? { did: payload.sub }
        : null;
    } catch {
      return null; // invalid signature, expired, wrong aud/iss, malformed — all just "not authenticated"
    }
  };
}

/** The message the embedded wallet signs at onboard to PROVE it belongs to this Privy
 * login. Including the DID makes the signature non-replayable by any other login
 * (a stolen signature recovers fine but carries the wrong DID). */
export const onboardProofMessage = (did: string): string => `remit-onboard:v1:${did}`;
