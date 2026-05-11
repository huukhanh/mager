import type { Context } from "hono";
import type { HonoEnv } from "../types";
import { INSTALL_SCRIPT_SOURCE } from "../embed/install-script";

/**
 * GET /install.sh
 *
 * Serves the bundled `scripts/install.sh` directly out of the Worker.
 * The script content is baked in at deploy time by
 * `worker/scripts/embed-install-script.mjs`, so this route has no
 * runtime dependency on github.com / raw.githubusercontent.com — that
 * matters because those endpoints return 404 for private repos
 * without an Authorization header.
 *
 * `INSTALL_SCRIPT_SRC_URL` (Worker var) overrides with a remote fetch.
 * Useful for testing a branch's install.sh without redeploying the Worker.
 */
export async function installScriptHandler(
  c: Context<HonoEnv>,
): Promise<Response> {
  const override =
    typeof c.env.INSTALL_SCRIPT_SRC_URL === "string" &&
    c.env.INSTALL_SCRIPT_SRC_URL.trim().length > 0
      ? c.env.INSTALL_SCRIPT_SRC_URL.trim()
      : "";

  if (override) {
    let res: Response;
    try {
      res = await fetch(override, {
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

  return new Response(INSTALL_SCRIPT_SOURCE, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
