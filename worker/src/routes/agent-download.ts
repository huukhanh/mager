import type { Context } from "hono";
import type { HonoEnv } from "../types";

const AGENT_RELEASE_REPO_DEFAULT = "huukhanh/mager";
const ALLOWED_OSES = ["linux", "darwin"] as const;
const ALLOWED_ARCHES = ["amd64", "arm64"] as const;
const PLATFORM_RE = /^(linux|darwin)-(amd64|arm64)$/;

/**
 * GET /agent/<os>-<arch> → 302 redirect to GitHub release asset.
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
    const supported: string[] = [];
    for (const os of ALLOWED_OSES) {
      for (const arch of ALLOWED_ARCHES) supported.push(`${os}-${arch}`);
    }
    return c.json({ error: "unsupported_platform", supported }, 404);
  }
  const os = m[1];
  const arch = m[2];

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

  const asset = `mager-agent-${os}-${arch}`;
  const target =
    tag === "latest"
      ? `https://github.com/${repo}/releases/latest/download/${asset}`
      : `https://github.com/${repo}/releases/download/${tag}/${asset}`;

  return Response.redirect(target, 302);
}
