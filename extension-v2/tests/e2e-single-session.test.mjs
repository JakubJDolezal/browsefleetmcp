import test from "node:test";
import assert from "node:assert/strict";

import {
  ExtensionE2EHarness,
  getRefs,
  readPageTestState,
} from "./support/e2e-harness.mjs";

test(
  "extension-v2 E2E single-session smoke test",
  { timeout: 120_000 },
  async () => {
    const harness = await ExtensionE2EHarness.launch();
    let step = "opening first session";

    try {
      const first = await harness.openConnectedPage();
      const { page, socketClient } = first;

      step = "single-session smoke assertions";
      assert.equal(await socketClient.request("getTitle", {}), "Page One");
      assert.equal(await socketClient.request("getUrl", {}), `${harness.origin}/page1`);

      const {
        incrementRef,
        inputRef,
        dateRef,
        selectRef,
        hoverRef,
        dragSourceRef,
        dropZoneRef,
        linkRef,
      } = await getRefs(socketClient, {
        incrementRef: ["button", "Increment counter"],
        inputRef: ["textbox", "Your name"],
        dateRef: ["textbox", "Start date"],
        selectRef: ["combobox", "Color selector"],
        hoverRef: ["button", "Hover target"],
        dragSourceRef: ["button", "Drag source"],
        dropZoneRef: ["button", "Drop zone"],
        linkRef: ["link", "Go to page two"],
      });

      step = "single-session hover";
      await socketClient.request("browser_hover", { ref: hoverRef });
      assert.equal(await page.textContent("#hover-status"), "hovered");

      step = "single-session click";
      await socketClient.request("browser_click", { ref: incrementRef });
      assert.equal(await page.textContent("#click-status"), "clicked 1");

      step = "single-session type text";
      const textStateBeforeType = await readPageTestState(page);
      await socketClient.request("browser_type", {
        ref: inputRef,
        text: "Alice",
        submit: false,
      });
      assert.equal(await page.inputValue("#name-input"), "Alice");
      const textStateAfterType = await readPageTestState(page);
      assert.ok(
        textStateAfterType.nameKeydownCount > textStateBeforeType.nameKeydownCount,
      );

      step = "single-session press enter";
      await socketClient.request("browser_press_key", { key: "Enter" });
      assert.equal(await page.textContent("#keypress-status"), "enter:Alice");

      step = "single-session type date";
      const dateStateBeforeType = await readPageTestState(page);
      await socketClient.request("browser_type", {
        ref: dateRef,
        text: "2026-04-10",
        submit: false,
      });
      assert.equal(await page.inputValue("#date-input"), "2026-04-10");
      assert.equal(await page.textContent("#date-status"), "2026-04-10");
      const dateStateAfterType = await readPageTestState(page);
      assert.ok(
        dateStateAfterType.dateKeydownCount > dateStateBeforeType.dateKeydownCount,
      );

      step = "single-session select option";
      await socketClient.request("browser_select_option", {
        ref: selectRef,
        values: ["blue"],
      });
      assert.equal(await page.inputValue("#color-select"), "blue");
      assert.equal(await page.textContent("#select-status"), "blue");

      step = "single-session drag";
      await socketClient.request("browser_drag", {
        startRef: dragSourceRef,
        endRef: dropZoneRef,
      });
      assert.equal(await page.textContent("#drag-status"), "dropped:Drag source");

      step = "single-session wait";
      const waitStartedAt = Date.now();
      await socketClient.request("browser_wait", { time: 0.15 });
      assert.ok(Date.now() - waitStartedAt >= 120);

      step = "single-session console logs";
      const consoleLogs = await socketClient.request("browser_get_console_logs", {});
      assert.ok(Array.isArray(consoleLogs));

      step = "single-session click navigation link";
      await socketClient.request("browser_click", { ref: linkRef });
      await page.waitForURL(`${harness.origin}/page2`);
      assert.equal(await socketClient.request("getTitle", {}), "Page Two");
      assert.equal(await socketClient.request("getUrl", {}), `${harness.origin}/page2`);

      step = "single-session back navigation";
      await socketClient.request("browser_go_back", {});
      await page.waitForURL(`${harness.origin}/page1`);
      assert.equal(await socketClient.request("getTitle", {}), "Page One");

      step = "single-session forward navigation";
      await socketClient.request("browser_go_forward", {});
      await page.waitForURL(`${harness.origin}/page2`);
      assert.equal(await socketClient.request("getTitle", {}), "Page Two");

      step = "single-session navigate";
      await socketClient.request("browser_navigate", {
        url: `${harness.origin}/page1?navigate=1`,
      });
      await page.waitForURL(`${harness.origin}/page1?navigate=1`);
      assert.equal(
        await socketClient.request("getUrl", {}),
        `${harness.origin}/page1?navigate=1`,
      );

      step = "single-session screenshot";
      const screenshot = await socketClient.request("browser_screenshot", {});
      assert.ok(typeof screenshot === "string" && screenshot.startsWith("iVBOR"));

      step = "single-session screen screenshot";
      const screenScreenshot = await socketClient.request(
        "browser_screen_screenshot",
        {},
      );
      assert.ok(
        typeof screenScreenshot === "string" &&
          screenScreenshot.startsWith("iVBOR"),
      );
    } catch (error) {
      await harness.captureFailureArtifacts("e2e-single-session-failure");
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
