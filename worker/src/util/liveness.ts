import type { NodeLivenessStatus } from "../../../schema/api";

export function computeNodeStatus(
  lastSeen: number | null,
  nowSec: number,
): NodeLivenessStatus {
  if (lastSeen === null) {
    return "unknown";
  }
  if (lastSeen > nowSec - 90) {
    return "online";
  }
  return "offline";
}
