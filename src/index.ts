#!/usr/bin/env node
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command, program } from "commander";

import { BrokerClient } from "@/broker";
import { appConfig } from "@/config";

import type { Resource } from "@/resources/resource";
import { createServerWithTools } from "@/server";
import * as common from "@/tools/common";
import * as custom from "@/tools/custom";
import * as snapshot from "@/tools/snapshot";
import type { Tool } from "@/tools/tool";

import packageJSON from "../package.json";

function setupExitWatchdog(server: Server) {
  process.stdin.on("close", async () => {
    setTimeout(() => process.exit(0), 15000);
    await server.close();
    process.exit(0);
  });
}

const commonTools: Tool[] = [common.pressKey, common.wait];

const customTools: Tool[] = [
  custom.getConsoleLogs,
  custom.screenshot,
  custom.screenScreenshot,
];

const snapshotTools: Tool[] = [
  common.navigate(true),
  common.goBack(true),
  common.goForward(true),
  snapshot.snapshot,
  snapshot.click,
  snapshot.drag,
  snapshot.hover,
  snapshot.type,
  snapshot.selectOption,
  ...commonTools,
  ...customTools,
];

const resources: Resource[] = [];

async function createServer(): Promise<Server> {
  return createServerWithTools({
    name: appConfig.name,
    version: packageJSON.version,
    tools: snapshotTools,
    resources,
  });
}

/**
 * Note: Tools must be defined *before* calling `createServer` because only declarations are hoisted, not the initializations
 */
async function runServer(): Promise<void> {
  const server = await createServer();
  setupExitWatchdog(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

type PortOptions = {
  port?: string;
  fallbackPorts?: string;
  brokerPort?: string;
  brokerFallbackPorts?: string;
  authToken?: string;
};

type CreateSessionCommandOptions = PortOptions & {
  url?: string;
  label?: string;
};

function applyPortOptions(options: PortOptions): void {
  if (options.port) {
    process.env.BROWSEFLEETMCP_PORT = options.port;
  }
  if (options.fallbackPorts) {
    process.env.BROWSEFLEETMCP_FALLBACK_PORTS = options.fallbackPorts;
  }
  if (options.brokerPort) {
    process.env.BROWSEFLEETMCP_BROKER_PORT = options.brokerPort;
  }
  if (options.brokerFallbackPorts) {
    process.env.BROWSEFLEETMCP_BROKER_FALLBACK_PORTS =
      options.brokerFallbackPorts;
  }
  if (options.authToken) {
    process.env.BROWSEFLEETMCP_AUTH_TOKEN = options.authToken;
  }
}

function withPortOptions(command: Command): Command {
  return command
    .option("--port <port>", "Preferred browser WebSocket port")
    .option(
      "--fallback-ports <ports>",
      "Comma-separated backup browser WebSocket ports",
    )
    .option("--broker-port <port>", "Preferred internal broker port")
    .option(
      "--broker-fallback-ports <ports>",
      "Comma-separated backup internal broker ports",
    )
    .option(
      "--auth-token <token>",
      "Optional shared token used to authenticate the extension and broker",
    );
}

async function runCreateSessionCommand(
  options: CreateSessionCommandOptions,
): Promise<void> {
  applyPortOptions(options);

  let brokerClient: BrokerClient | undefined;
  try {
    brokerClient = await BrokerClient.connect(1);
  } catch {
    throw new Error(
      `Unable to connect to a running ${appConfig.displayName} server. Start "${appConfig.name} serve" or your MCP client first.`,
    );
  }

  try {
    const createdSession = await brokerClient.createSession(
      options.url,
      options.label,
    );
    process.stdout.write(`${JSON.stringify(createdSession, null, 2)}\n`);
  } finally {
    await brokerClient.close().catch(() => undefined);
  }
}

function getToolText(result: Awaited<ReturnType<BrokerClient["callTool"]>>): string {
  const entry = result.content.find((content) => content.type === "text");
  return entry?.type === "text" ? entry.text : "";
}

async function runToolCommand(
  options: PortOptions,
  toolName: string,
  params?: Record<string, unknown>,
): Promise<void> {
  const result = await withRunningBroker(options, async (brokerClient) =>
    await brokerClient.callTool(toolName, params),
  );
  const text = getToolText(result);
  if (result.isError) {
    throw new Error(text);
  }

  process.stdout.write(`${text}\n`);
}

async function withRunningBroker<T>(
  options: PortOptions,
  action: (client: BrokerClient) => Promise<T>,
): Promise<T> {
  applyPortOptions(options);

  let brokerClient: BrokerClient | undefined;
  try {
    brokerClient = await BrokerClient.connect(1);
  } catch {
    throw new Error(
      `Unable to connect to a running ${appConfig.displayName} server. Start "${appConfig.name} serve" or your MCP client first.`,
    );
  }

  try {
    return await action(brokerClient);
  } finally {
    await brokerClient.close().catch(() => undefined);
  }
}

async function runReloadExtensionCommand(options: PortOptions): Promise<void> {
  await withRunningBroker(options, async (brokerClient) => {
    await brokerClient.reloadExtension();
    process.stdout.write("Reloading the BrowseFleetMCP extension.\n");
  });
}

async function runRestartTransportCommand(options: PortOptions): Promise<void> {
  applyPortOptions(options);

  let brokerClient: BrokerClient | undefined;
  try {
    brokerClient = await BrokerClient.connect(1);
  } catch {
    throw new Error(
      `Unable to connect to a running ${appConfig.displayName} server. Start "${appConfig.name} serve" or your MCP client first.`,
    );
  }

  try {
    const result = await brokerClient.restartTransport();
    await brokerClient.waitForClose().catch(() => undefined);
    const reconnectedClient = await BrokerClient.connect();
    await reconnectedClient.close().catch(() => undefined);
    process.stdout.write(`${result}\n`);
  } finally {
    await brokerClient.close().catch(() => undefined);
  }
}

withPortOptions(program)
  .name(appConfig.name)
  .description(
    `${appConfig.displayName} CLI and stdio MCP server for parallel browser automation.`,
  )
  .version(packageJSON.version)
  .showHelpAfterError()
  .addHelpText(
    "after",
    `
Examples:
  $ ${appConfig.name}
  $ ${appConfig.name} serve
  $ ${appConfig.name} create-session --url https://example.com
  $ ${appConfig.name} create-session --label "Docs Search"
  $ ${appConfig.name} health
  $ ${appConfig.name} prune-sessions
  $ ${appConfig.name} reconnect-session --session-id abc123
  $ ${appConfig.name} destroy-session --session-id abc123
  $ ${appConfig.name} self-test
  $ ${appConfig.name} reload-extension
  $ ${appConfig.name} restart-transport
  $ ${appConfig.name} --port 9150 --fallback-ports 9152,9154
  $ ${appConfig.name} --auth-token your-shared-token
`,
  )
  .action(async (options: PortOptions) => {
    applyPortOptions(options);
    await runServer();
  });

withPortOptions(program
  .command("serve")
  .description(`Start the ${appConfig.displayName} stdio MCP server`))
  .action(async (_value: unknown, command: Command) => {
    const options = command.optsWithGlobals<PortOptions>();
    applyPortOptions(options);
    await runServer();
  });

withPortOptions(program
  .command("create-session")
  .description(
    `Create a new browser session through the running ${appConfig.displayName} broker`,
  )
  .option(
    "--url <url>",
    "Optional starting URL for the new session",
    "about:blank",
  )
  .option(
    "--label <label>",
    "Optional friendly label for the created session",
  ))
  .action(async (_value: unknown, command: Command) => {
    const options = command.optsWithGlobals<CreateSessionCommandOptions>();
    await runCreateSessionCommand(options);
  });

withPortOptions(program
  .command("health")
  .description(`Show ${appConfig.displayName} transport, extension, and session health`))
  .action(async (_value: unknown, command: Command) => {
    const options = command.optsWithGlobals<PortOptions>();
    await runToolCommand(options, "browser_health");
  });

withPortOptions(program
  .command("prune-sessions")
  .description(`Remove stale ${appConfig.displayName} sessions from broker and extension state`))
  .action(async (_value: unknown, command: Command) => {
    const options = command.optsWithGlobals<PortOptions>();
    await runToolCommand(options, "browser_prune_sessions");
  });

withPortOptions(program
  .command("reconnect-session")
  .description(`Reconnect one ${appConfig.displayName} browser session by session id`)
  .requiredOption("--session-id <sessionId>", "Session id to reconnect"))
  .action(async (_value: unknown, command: Command) => {
    const options = command.optsWithGlobals<PortOptions & { sessionId: string }>();
    await runToolCommand(options, "browser_reconnect_session", {
      sessionId: options.sessionId,
    });
  });

withPortOptions(program
  .command("destroy-session")
  .description(`Disconnect and close one ${appConfig.displayName} browser session by session id`)
  .requiredOption("--session-id <sessionId>", "Session id to destroy"))
  .action(async (_value: unknown, command: Command) => {
    const options = command.optsWithGlobals<PortOptions & { sessionId: string }>();
    await runToolCommand(options, "browser_destroy_session", {
      sessionId: options.sessionId,
    });
  });

withPortOptions(program
  .command("self-test")
  .description(`Run a temporary end-to-end ${appConfig.displayName} smoke test`))
  .action(async (_value: unknown, command: Command) => {
    const options = command.optsWithGlobals<PortOptions>();
    await runToolCommand(options, "browser_self_test");
  });

withPortOptions(program
  .command("reload-extension")
  .description(
    `Ask the running ${appConfig.displayName} extension to reload itself`,
  ))
  .action(async (_value: unknown, command: Command) => {
    const options = command.optsWithGlobals<PortOptions>();
    await runReloadExtensionCommand(options);
  });

withPortOptions(program
  .command("restart-transport")
  .description(
    `Restart the running ${appConfig.displayName} broker and browser transport stack`,
  ))
  .action(async (_value: unknown, command: Command) => {
    const options = command.optsWithGlobals<PortOptions>();
    await runRestartTransportCommand(options);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
