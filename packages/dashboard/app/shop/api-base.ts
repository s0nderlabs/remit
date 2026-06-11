// /shop calls the server's PUBLIC shop routes, which live at the server root,
// NOT under /api: so the dashboard's NEXT_PUBLIC_REMIT_API (".../api") needs
// its trailing /api stripped. Kept as a pure helper so it's unit-testable.

export function shopApiBase(raw?: string): string {
  const v = (raw && raw.trim() !== "" ? raw : "http://localhost:4070/api").replace(/\/+$/, "");
  return v.replace(/\/api$/, "");
}
