import test from "node:test";
import assert from "node:assert/strict";

import {
  ExtensionE2EHarness,
  assertActionBringsFocus,
  getRefs,
  waitForPageText,
} from "./support/e2e-harness.mjs";

test(
  "extension-v2 E2E focus-required actions move focus to the acting session",
  { timeout: 120_000 },
  async () => {
    const harness = await ExtensionE2EHarness.launch();
    let step = "opening test pages";

    try {
      const first = await harness.openConnectedPage();
      const second = await harness.openConnectedPage("second");

      step = "loading refs";
      const refs = await getRefs(first.socketClient, {
        selectRef: ["combobox", "Color selector"],
        hoverRef: ["button", "Hover target"],
        busyRef: ["button", "Busy action"],
        inputRef: ["textbox", "Your name"],
        dragSourceRef: ["button", "Drag source"],
        dropZoneRef: ["button", "Drop zone"],
      });

      step = "focus-required select option";
      await assertActionBringsFocus({
        actingPage: first.page,
        otherPage: second.page,
        description: "browser_select_option",
        runAction: async () =>
          await first.socketClient.request("browser_select_option", {
            ref: refs.selectRef,
            values: ["blue"],
          }),
        verify: async () => {
          assert.equal(await first.page.inputValue("#color-select"), "blue");
          assert.equal(await first.page.textContent("#select-status"), "blue");
        },
      });

      step = "focus-required hover";
      await first.page.evaluate(() => {
        document.getElementById("hover-status").textContent = "not hovered";
      });
      await assertActionBringsFocus({
        actingPage: first.page,
        otherPage: second.page,
        description: "browser_hover",
        runAction: async () =>
          await first.socketClient.request("browser_hover", { ref: refs.hoverRef }),
        verify: async () => {
          assert.equal(await first.page.textContent("#hover-status"), "hovered");
        },
      });

      step = "focus-required click";
      await first.page.evaluate(() => {
        document.getElementById("busy-status").textContent = "idle";
        if (window.__browseFleetTestState) {
          window.__browseFleetTestState.busyStartedAt = null;
          window.__browseFleetTestState.busyDoneAt = null;
        }
      });
      await assertActionBringsFocus({
        actingPage: first.page,
        otherPage: second.page,
        description: "browser_click",
        runAction: async () =>
          await first.socketClient.request("browser_click", { ref: refs.busyRef }),
        verify: async () => {
          await waitForPageText(
            first.page,
            "#busy-status",
            "busy done",
            "browser_click busy completion",
            5_000,
          );
        },
      });

      step = "focus-required type";
      await first.page.evaluate(() => {
        document.getElementById("name-input").value = "";
      });
      await assertActionBringsFocus({
        actingPage: first.page,
        otherPage: second.page,
        description: "browser_type",
        runAction: async () =>
          await first.socketClient.request("browser_type", {
            ref: refs.inputRef,
            text: "FocusType",
            submit: false,
          }),
        verify: async () => {
          assert.equal(await first.page.inputValue("#name-input"), "FocusType");
        },
      });

      step = "focus-required press key";
      await first.page.evaluate(() => {
        const input = document.getElementById("name-input");
        input.value = "FocusKey";
        input.focus();
        document.getElementById("keypress-status").textContent = "no keypress";
      });
      await assertActionBringsFocus({
        actingPage: first.page,
        otherPage: second.page,
        description: "browser_press_key",
        runAction: async () =>
          await first.socketClient.request("browser_press_key", { key: "Enter" }),
        verify: async () => {
          assert.equal(await first.page.textContent("#keypress-status"), "enter:FocusKey");
        },
      });

      step = "focus-required drag";
      await first.page.evaluate(() => {
        document.getElementById("drag-status").textContent = "not dropped";
      });
      await assertActionBringsFocus({
        actingPage: first.page,
        otherPage: second.page,
        description: "browser_drag",
        runAction: async () =>
          await first.socketClient.request("browser_drag", {
            startRef: refs.dragSourceRef,
            endRef: refs.dropZoneRef,
          }),
        verify: async () => {
          assert.equal(await first.page.textContent("#drag-status"), "dropped:Drag source");
        },
      });
    } catch (error) {
      await harness.captureFailureArtifacts("e2e-focus-required-actions-failure");
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
