export const appConfig = {
  name: "browsefleetmcp",
  displayName: "BrowseFleetMCP",
};

const DEFAULT_WS_PORT = 9150;
const DEFAULT_WS_FALLBACK_PORTS = [9152, 9154];
const AUTH_TOKEN_ENV_NAMES = [
  "BROWSEFLEETMCP_AUTH_TOKEN",
  "BROWSERMCP_AUTH_TOKEN",
] as const;

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return undefined;
  }

  return parsed;
}

function parsePortList(value: string | undefined): number[] {
  if (!value) {
    return [];
  }

  const ports: number[] = [];
  for (const candidate of value.split(",")) {
    const port = parsePort(candidate.trim());
    if (port !== undefined) {
      ports.push(port);
    }
  }
  return ports;
}

function uniquePorts(ports: number[]): number[] {
  return Array.from(new Set(ports));
}

function normalizeToken(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function getWsPortCandidates(): number[] {
  return uniquePorts([
    parsePort(process.env.BROWSEFLEETMCP_PORT) ?? DEFAULT_WS_PORT,
    ...parsePortList(process.env.BROWSEFLEETMCP_FALLBACK_PORTS),
    ...DEFAULT_WS_FALLBACK_PORTS,
  ]);
}

export function getBrokerPortCandidates(): number[] {
  const explicit = uniquePorts([
    parsePort(process.env.BROWSEFLEETMCP_BROKER_PORT) ??
      parsePort(process.env.BROWSERMCP_BROKER_PORT) ??
      NaN,
    ...parsePortList(process.env.BROWSEFLEETMCP_BROKER_FALLBACK_PORTS),
  ].filter((port) => Number.isInteger(port)));

  if (explicit.length > 0) {
    return explicit;
  }

  return uniquePorts(getWsPortCandidates().map((port) => port + 1));
}

export function getAuthToken(): string | undefined {
  for (const envName of AUTH_TOKEN_ENV_NAMES) {
    const token = normalizeToken(process.env[envName]);
    if (token) {
      return token;
    }
  }

  return undefined;
}

export const mcpConfig = {
  defaultWsPort: DEFAULT_WS_PORT,
  defaultWsFallbackPorts: DEFAULT_WS_FALLBACK_PORTS,
  authTokenEnvNames: AUTH_TOKEN_ENV_NAMES,
  errors: {
    noConnectedTab: "No connected tab",
  },
};
