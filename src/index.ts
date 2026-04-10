#!/usr/bin/env node
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command, program } from "commander";

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
  .action(async (options: PortOptions) => {
    applyPortOptions(options);
    await runServer();
  });

program.parse(process.argv);
