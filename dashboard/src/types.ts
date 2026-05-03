export type NodeLivenessStatus = "online" | "offline" | "unknown";

export interface IngressRuleEntry {
  hostname: string;
  service: string;
}

export interface NodeSummary {
  id: string;
  name: string;
  status: NodeLivenessStatus;
  lastSeen: number | null;
  tunnelHostname: string | null;
}

export interface NodeDetail extends NodeSummary {
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

export interface PutIngressResponse {
  ok: true;
  dns: DnsProvisionOutcome[];
}
