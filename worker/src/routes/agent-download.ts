import type { Context } from "hono";
import type { HonoEnv } from "../types";

const AGENT_RELEASE_REPO_DEFAULT = "huukhanh/mager";
const AGENT_BINARY_PREFIX = "mager-agent-linux-";
const ALLOWED_ARCHES = new Set(["amd64", "arm64"]);
const PLATFORM_RE = /^linux-(amd64|arm64)$/;

/**
 * GET /agent/linux-<arch> → 302 redirect to GitHub release asset.
 * Lets `install.sh` download the prebuilt agent binary without requiring Go on the target host.
 * Bytes flow GitHub → client; the Worker only emits the redirect (no bandwidth cost).
 */
export async function agentDownloadHandler(
  c: Context<HonoEnv>,
): Promise<Response> {
  // Hono can't bind param prefixes ("linux-:arch"), so capture the whole platform segment and validate.
  const platform = c.req.param("platform") ?? "";
  const m = PLATFORM_RE.exec(platform);
  if (!m) {
    return c.json(
      {
        error: "unsupported_platform",
        supported: [...ALLOWED_ARCHES].map((a) => `linux-${a}`),
      },
      404,
    );
  }
  const arch = m[1];

  const repo =
    typeof c.env.AGENT_RELEASE_REPO === "string" &&
    c.env.AGENT_RELEASE_REPO.trim().length > 0
      ? c.env.AGENT_RELEASE_REPO.trim()
      : AGENT_RELEASE_REPO_DEFAULT;

  const tag =
    typeof c.env.AGENT_RELEASE_TAG === "string" &&
    c.env.AGENT_RELEASE_TAG.trim().length > 0
      ? c.env.AGENT_RELEASE_TAG.trim()
      : "latest";

  const asset = `${AGENT_BINARY_PREFIX}${arch}`;
  const target =
    tag === "latest"
      ? `https://github.com/${repo}/releases/latest/download/${asset}`
      : `https://github.com/${repo}/releases/download/${tag}/${asset}`;

  return Response.redirect(target, 302);
}
