import type { Context } from "hono";
import type { HonoEnv } from "../types";

const DEFAULT_INSTALL_SCRIPT_SRC =
  "https://raw.githubusercontent.com/huukhanh/cftun-mager/main/scripts/install.sh";

export async function installScriptHandler(c: Context<HonoEnv>): Promise<Response> {
  const src =
    typeof c.env.INSTALL_SCRIPT_SRC_URL === "string" &&
    c.env.INSTALL_SCRIPT_SRC_URL.trim().length > 0
      ? c.env.INSTALL_SCRIPT_SRC_URL.trim()
      : DEFAULT_INSTALL_SCRIPT_SRC;

  let res: Response;
  try {
    res = await fetch(src, {
      headers: { Accept: "text/plain,*/*" },
      cf: { cacheEverything: true, cacheTtl: 300 },
    } as RequestInit);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "fetch_failed", detail: msg }, 502);
  }

  if (!res.ok) {
    return c.json({ error: "upstream_http", status: res.status }, 502);
  }

  const text = await res.text();
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
