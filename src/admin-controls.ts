import type { SessionPoolHealth } from "@/session-pool";

export type TransportHealth = {
  brokerConnected: boolean;
  ownsBrokerStack: boolean;
  transportRestartScheduled: boolean;
  wsPortCandidates: number[];
  brokerPortCandidates: number[];
  serverPid: number;
  serverCwd: string;
  serverVersion: string;
};

export type AdminControls = {
  scheduleTransportRestart: () => boolean;
  getTransportHealth: () => TransportHealth;
  getSessionPoolHealth: () => SessionPoolHealth;
};
