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
  ingress: IngressRuleEntry[];
  tunnelToken: string;
  configHash: string;
}
