import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// The demo merchant wears its own domain: any shop.* host (shop.s0nderlabs.xyz
// in prod, shop.localhost:4071 in dev) serves /shop at its root. A rewrite,
// not a redirect: the URL bar keeps the merchant's address, which is the point.
// Assets and API routes never reach here (matcher below). Next 16 calls this
// layer "proxy" (the middleware.ts name is deprecated).
export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (!host.startsWith("shop.")) return NextResponse.next();
  const url = req.nextUrl.clone();
  if (url.pathname === "/") {
    url.pathname = "/shop";
    return NextResponse.rewrite(url);
  }
  // every other path on the shop host goes home to the storefront
  if (!url.pathname.startsWith("/shop")) {
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|api|favicon.ico|.*\\..*).*)"],
};
