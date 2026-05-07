import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { WebSocketServer } from "ws";

import {
  ROOT_DIR,
  findAvailablePort,
} from "./support/integration-harness.mjs";

const AUTH_TOKEN = "broker-compatibility-test-token";

async function closeWebSocketServer(server) {
  for (const client of server.clients) {
    client.terminate();
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function createLegacyBroker(port) {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  server.on("connection", (socket) => {
    socket.on("message", (rawMessage) => {
      const message = JSON.parse(String(rawMessage));
      if (message.type !== "hello") {
        return;
      }

      socket.send(
        JSON.stringify({
          id: message.id,
          ok: true,
          result: "browsefleetmcp-broker-ready",
        }),
      );
    });
  });

  if (server.address() === null) {
    await new Promise((resolve) => server.once("listening", resolve));
  }

  return server;
}

async function waitForExit(child, timeoutMs = 5_000) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for child process to exit."));
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("stdio server refuses a legacy broker that cannot report its tool surface", async () => {
  const wsPort = await findAvailablePort();
  const brokerPort = await findAvailablePort();
  const legacyBroker = await createLegacyBroker(brokerPort);

  try {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        BROWSEFLEETMCP_PORT: String(wsPort),
        BROWSEFLEETMCP_BROKER_PORT: String(brokerPort),
        BROWSEFLEETMCP_AUTH_TOKEN: AUTH_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const result = await waitForExit(child);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /legacy BrowseFleetMCP broker/i);
    assert.match(result.stderr, /report its tool surface/i);
  } finally {
    await closeWebSocketServer(legacyBroker);
  }
});
