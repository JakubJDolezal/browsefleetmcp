import type { SessionPoolHealth } from "@/session-pool";

export type TransportHealth = {
  brokerConnected: boolean;
  ownsBrokerStack: boolean;
  transportRestartScheduled: boolean;
  wsPortCandidates: number[];
  brokerPortCandidates: number[];
  serverPid: number;
  serverCwd: string;
  serverRoot: string;
  serverVersion: string;
  broker: {
    protocolVersion: number;
    serverName: string;
    serverVersion: string;
    serverCwd: string;
    serverRoot: string;
    serverPid: number;
    brokerPort: number;
    startedAt: string;
    toolCount: number;
    toolSurfaceFingerprint: string;
  } | null;
};

export type AdminControls = {
  scheduleTransportRestart: () => boolean;
  getTransportHealth: () => TransportHealth;
  getSessionPoolHealth: () => SessionPoolHealth;
};
