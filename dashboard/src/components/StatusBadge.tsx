import type { NodeLivenessStatus } from "../types";

const LABEL: Record<NodeLivenessStatus, string> = {
  online: "Online",
  offline: "Offline",
  unknown: "Unknown",
};

export function StatusBadge({ status }: { status: NodeLivenessStatus }) {
  return <span className={`badge badge-${status}`}>{LABEL[status]}</span>;
}
