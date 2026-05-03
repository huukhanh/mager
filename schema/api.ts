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
