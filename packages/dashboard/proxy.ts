// Deployment gate (dev posture): HTTP Basic Auth over the WHOLE dashboard, static
// chunks included — the client bundle embeds NEXT_PUBLIC_REMIT_ADMIN_TOKEN, so every
// asset stays behind the gate, not just pages. Credentials come from SERVER-side env
// (DASH_BASIC_USER / DASH_BASIC_PASS, never NEXT_PUBLIC_*). Gate states:
//   both unset        -> open (local dev)
//   exactly one set   -> 401 everything (half-configured = misconfiguration, fail CLOSED)
//   both set          -> basic-auth challenge
// Next 16 convention: this is proxy.ts (middleware.ts is the deprecated name).
// Replaced by per-user Privy session auth in the OAuth lane.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Constant-time-ish string compare (no early exit on first differing byte). */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function proxy(req: NextRequest) {
  const user = process.env.DASH_BASIC_USER ?? "";
  const pass = process.env.DASH_BASIC_PASS ?? "";
  if (!user && !pass) return NextResponse.next(); // local dev: ungated

  const header = req.headers.get("authorization");
  if (user && pass && header?.startsWith("Basic ")) {
    try {
      const [u, ...rest] = atob(header.slice(6)).split(":");
      const userOk = safeEqual(u ?? "", user);
      const passOk = safeEqual(rest.join(":"), pass);
      if (userOk && passOk) return NextResponse.next();
    } catch {
      // malformed base64: fall through to 401, never 500
    }
  }
  return new NextResponse("authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="remit"' },
  });
}

export const config = { matcher: "/(.*)" };
