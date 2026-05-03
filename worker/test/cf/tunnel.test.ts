import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ensureTunnelConfigSrcLocal,
  ensureTunnelCredentials,
  findZoneIdForHostname,
  provisionDnsRoutes,
  setTunnelConfigSrc,
  upsertTunnelDnsRoute,
} from "../../src/cf/tunnel";

type FetchInit = Parameters<typeof fetch>[1];
type FetchCall = { url: string; init?: FetchInit };

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers as object) },
  });
}

describe("cf/tunnel", () => {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: FetchInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init });
    return jsonResponse({ success: true, result: {} });
  });
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string | URL, init?: FetchInit) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push({ url: u, init });
      return jsonResponse({ success: true, result: {} });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("createNamedTunnel via ensureTunnelCredentials", () => {
    it("creates new tunnels with config_src=local", async () => {
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: { id: "tid-new", token: "tok-new" },
        });
      });
      const out = await ensureTunnelCredentials("acct", "api", "node-x");
      expect(out.tunnelId).toBe("tid-new");
      expect(out.tunnelToken).toBe("tok-new");
      // First call is the POST create — assert config_src=local payload
      const create = calls[0];
      expect(create.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct/cfd_tunnel",
      );
      expect(create.init?.method).toBe("POST");
      const body = JSON.parse((create.init?.body as string) ?? "{}") as {
        name: string;
        config_src: string;
      };
      expect(body.config_src).toBe("local");
      expect(body.name).toBe("node-x");
    });

    it("migrates existing tunnel with config_src=cloudflare to local", async () => {
      // 1st call: POST create -> 409 duplicate
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse(
          {
            success: false,
            errors: [{ message: "tunnel already exists" }],
          },
          { status: 409 },
        );
      });
      // 2nd call: GET list -> tunnel with config_src=cloudflare
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: [
            { id: "tid-old", name: "node-x", config_src: "cloudflare" },
          ],
        });
      });
      // 3rd call: PATCH config_src
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ success: true, result: { id: "tid-old" } });
      });
      // 4th call: GET token
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ success: true, result: "tok-old" });
      });

      const out = await ensureTunnelCredentials("acct", "api", "node-x");
      expect(out.tunnelId).toBe("tid-old");
      expect(out.tunnelToken).toBe("tok-old");

      const patch = calls[2];
      expect(patch.init?.method).toBe("PATCH");
      expect(patch.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct/cfd_tunnel/tid-old",
      );
      const patchBody = JSON.parse((patch.init?.body as string) ?? "{}") as {
        config_src: string;
      };
      expect(patchBody.config_src).toBe("local");
    });
  });

  describe("ensureTunnelConfigSrcLocal", () => {
    it("PATCHes only when current src is not local", async () => {
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: { id: "tid", name: "n", config_src: "cloudflare" },
        });
      });
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ success: true, result: { id: "tid" } });
      });
      await ensureTunnelConfigSrcLocal("acct", "api", "tid");
      expect(calls).toHaveLength(2);
      expect(calls[1].init?.method).toBe("PATCH");
    });

    it("is a no-op when already local", async () => {
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: { id: "tid", name: "n", config_src: "local" },
        });
      });
      await ensureTunnelConfigSrcLocal("acct", "api", "tid");
      expect(calls).toHaveLength(1);
    });
  });

  describe("setTunnelConfigSrc", () => {
    it("PATCHes the tunnel resource with the requested config_src", async () => {
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ success: true, result: { id: "tid" } });
      });
      await setTunnelConfigSrc("acct", "api", "tid", "local");
      expect(calls[0].init?.method).toBe("PATCH");
      const body = JSON.parse((calls[0].init?.body as string) ?? "{}") as {
        config_src: string;
      };
      expect(body.config_src).toBe("local");
    });

    it("throws on non-success response", async () => {
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: false,
          errors: [{ message: "permission denied" }],
        });
      });
      await expect(setTunnelConfigSrc("acct", "api", "tid", "local")).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe("findZoneIdForHostname", () => {
    it("returns the longest matching zone for a subdomain", async () => {
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: [
            { id: "z-root", name: "example.com" },
            { id: "z-sub", name: "sub.example.com" },
            { id: "z-other", name: "other.com" },
          ],
        });
      });
      const id = await findZoneIdForHostname(
        "acct",
        "api",
        "deep.sub.example.com",
      );
      expect(id).toBe("z-sub");
    });

    it("returns null when no zone matches", async () => {
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: [{ id: "z-root", name: "example.com" }],
        });
      });
      const id = await findZoneIdForHostname("acct", "api", "foo.bar.org");
      expect(id).toBeNull();
    });
  });

  describe("upsertTunnelDnsRoute", () => {
    it("creates a CNAME when none exists", async () => {
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ success: true, result: [] });
      });
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ success: true, result: { id: "rec-1" } });
      });
      const out = await upsertTunnelDnsRoute(
        "api",
        "z-1",
        "app.example.com",
        "tid-1",
      );
      expect(out.created).toBe(true);
      expect(out.recordId).toBe("rec-1");
      expect(calls[1].init?.method).toBe("POST");
      const body = JSON.parse((calls[1].init?.body as string) ?? "{}") as {
        type: string;
        name: string;
        content: string;
        proxied: boolean;
      };
      expect(body.type).toBe("CNAME");
      expect(body.content).toBe("tid-1.cfargotunnel.com");
      expect(body.proxied).toBe(true);
    });

    it("updates a stale CNAME pointing elsewhere", async () => {
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: [
            {
              id: "rec-old",
              type: "CNAME",
              name: "app.example.com",
              content: "old.cfargotunnel.com",
              proxied: true,
            },
          ],
        });
      });
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ success: true, result: { id: "rec-old" } });
      });
      const out = await upsertTunnelDnsRoute(
        "api",
        "z-1",
        "app.example.com",
        "tid-new",
      );
      expect(out.updated).toBe(true);
      expect(out.created).toBe(false);
      expect(calls[1].init?.method).toBe("PATCH");
    });

    it("is a no-op when CNAME already correct", async () => {
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: [
            {
              id: "rec-ok",
              type: "CNAME",
              name: "app.example.com",
              content: "tid-1.cfargotunnel.com",
              proxied: true,
            },
          ],
        });
      });
      const out = await upsertTunnelDnsRoute(
        "api",
        "z-1",
        "app.example.com",
        "tid-1",
      );
      expect(out.created).toBe(false);
      expect(out.updated).toBe(false);
      expect(calls).toHaveLength(1);
    });
  });

  describe("provisionDnsRoutes", () => {
    it("returns per-hostname outcomes including skipped zones", async () => {
      // hostname 1: zone resolved → record created
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: [{ id: "z-1", name: "example.com" }],
        });
      });
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ success: true, result: [] });
      });
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ success: true, result: { id: "rec-a" } });
      });
      // hostname 2: zone not in account → skipped
      fetchMock.mockImplementationOnce(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          success: true,
          result: [{ id: "z-1", name: "example.com" }],
        });
      });

      const out = await provisionDnsRoutes("acct", "api", "tid-1", [
        "a.example.com",
        "b.notmine.io",
      ]);
      expect(out).toEqual([
        { hostname: "a.example.com", status: "created" },
        { hostname: "b.notmine.io", status: "skipped", error: "zone_not_in_account" },
      ]);
    });
  });
});
