import test from "node:test";
import assert from "node:assert/strict";

import {
  ExtensionE2EHarness,
  assertActionPreservesBackgroundFocus,
} from "./support/e2e-harness.mjs";

test(
  "extension-v2 E2E background actions preserve focus",
  { timeout: 120_000 },
  async () => {
    const harness = await ExtensionE2EHarness.launch();
    let step = "opening test pages";

    try {
      const first = await harness.openConnectedPage();
      const second = await harness.openConnectedPage("second");
      const backgroundNavigateUrl = `${harness.origin}/page2?label=background-nav`;

      step = "background snapshot classification";
      await assertActionPreservesBackgroundFocus({
        actingPage: first.page,
        actingSession: first.session,
        otherSession: second.session,
        otherPage: second.page,
        description: "browser_snapshot",
        runAction: async () => await first.socketClient.request("browser_snapshot", {}),
        verify: async (snapshot) => {
          assert.match(snapshot, /Page One/);
        },
      });

      step = "background console logs classification";
      await assertActionPreservesBackgroundFocus({
        actingPage: first.page,
        actingSession: first.session,
        otherSession: second.session,
        otherPage: second.page,
        description: "browser_get_console_logs",
        runAction: async () =>
          await first.socketClient.request("browser_get_console_logs", {}),
        verify: async (logs) => {
          assert.ok(Array.isArray(logs));
        },
      });

      step = "background screenshot classification";
      await assertActionPreservesBackgroundFocus({
        actingPage: first.page,
        actingSession: first.session,
        otherSession: second.session,
        otherPage: second.page,
        description: "browser_screenshot",
        runAction: async () => await first.socketClient.request("browser_screenshot", {}),
        verify: async (screenshot) => {
          assert.ok(typeof screenshot === "string" && screenshot.startsWith("iVBOR"));
        },
      });

      step = "background screen screenshot classification";
      await assertActionPreservesBackgroundFocus({
        actingPage: first.page,
        actingSession: first.session,
        otherSession: second.session,
        otherPage: second.page,
        description: "browser_screen_screenshot",
        runAction: async () =>
          await first.socketClient.request("browser_screen_screenshot", {}),
        verify: async (screenshot) => {
          assert.ok(typeof screenshot === "string" && screenshot.startsWith("iVBOR"));
        },
      });

      step = "background wait classification";
      const backgroundWaitStartedAt = Date.now();
      await assertActionPreservesBackgroundFocus({
        actingPage: first.page,
        actingSession: first.session,
        otherSession: second.session,
        otherPage: second.page,
        description: "browser_wait",
        runAction: async () => await first.socketClient.request("browser_wait", { time: 0.1 }),
      });
      assert.ok(Date.now() - backgroundWaitStartedAt >= 90);

      step = "background navigate classification";
      await assertActionPreservesBackgroundFocus({
        actingPage: first.page,
        actingSession: first.session,
        otherSession: second.session,
        otherPage: second.page,
        description: "browser_navigate",
        runAction: async () =>
          await first.socketClient.request("browser_navigate", {
            url: backgroundNavigateUrl,
          }),
        verify: async () => {
          await first.page.waitForURL(backgroundNavigateUrl);
        },
      });

      step = "priming navigation history";
      await first.page.goto(`${harness.origin}/page1?navigate=1`, {
        waitUntil: "domcontentloaded",
      });
      await first.page.waitForLoadState("networkidle");
      await first.page.goto(backgroundNavigateUrl, {
        waitUntil: "domcontentloaded",
      });
      await first.page.waitForLoadState("networkidle");

      step = "background go_back classification";
      await assertActionPreservesBackgroundFocus({
        actingPage: first.page,
        actingSession: first.session,
        otherSession: second.session,
        otherPage: second.page,
        description: "browser_go_back",
        runAction: async () => await first.socketClient.request("browser_go_back", {}),
        verify: async () => {
          await first.page.waitForURL(`${harness.origin}/page1?navigate=1`);
        },
      });

      step = "background go_forward classification";
      await assertActionPreservesBackgroundFocus({
        actingPage: first.page,
        actingSession: first.session,
        otherSession: second.session,
        otherPage: second.page,
        description: "browser_go_forward",
        runAction: async () => await first.socketClient.request("browser_go_forward", {}),
        verify: async () => {
          await first.page.waitForURL(backgroundNavigateUrl);
        },
      });
    } catch (error) {
      await harness.captureFailureArtifacts("e2e-background-actions-failure");
      throw new Error(
        [
          `E2E failed during: ${step}`,
          error instanceof Error ? error.stack ?? error.message : String(error),
        ].join("\n\n"),
      );
    } finally {
      await harness.close();
    }
  },
);
