/** Canonical API types — update here first, then mirror into worker/dashboard copies. */

export interface RegisterRequestBody {
  nodeId: string;
  machineName: string;
}

export interface RegisterResponseBody {
  sessionToken: string;
  nodeId: string;
  machineName: string;
}

export interface IngressRuleEntry {
  hostname: string;
  service: string;
}

export interface NodeConfigResponseBody {
  /** Named tunnel UUID — agent uses this in generated cloudflared config.yml (token stays in env only). */
  tunnelId: string;
  ingress: IngressRuleEntry[];
  tunnelToken: string;
  configHash: string;
}

export interface LoginRequestBody {
  password: string;
}

export interface LoginResponseBody {
  adminToken: string;
}

export type NodeLivenessStatus = "online" | "offline" | "unknown";

export interface NodeSummary {
  id: string;
  name: string;
  status: NodeLivenessStatus;
  lastSeen: number | null;
  /** First ingress hostname (display). */
  tunnelHostname: string | null;
}

export interface NodesListResponseBody {
  nodes: NodeSummary[];
}

export interface PatchNodeRequestBody {
  name: string;
}

export interface PutIngressRequestBody {
  ingress: IngressRuleEntry[];
}

export type DnsProvisionStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped"
  | "permission_denied"
  | "error";

export interface DnsProvisionOutcome {
  hostname: string;
  status: DnsProvisionStatus;
  error?: string;
}

export interface PutIngressResponseBody {
  ok: true;
  dns: DnsProvisionOutcome[];
}

export interface NodeDetailResponseBody {
  id: string;
  name: string;
  status: NodeLivenessStatus;
  lastSeen: number | null;
  tunnelHostname: string | null;
  ingress: IngressRuleEntry[];
}
