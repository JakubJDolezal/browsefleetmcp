import test from "node:test";
import assert from "node:assert/strict";

import {
  ExtensionE2EHarness,
  getRefs,
  readPageTestState,
  wait,
  waitFor,
  waitForPageFocusState,
} from "./support/e2e-harness.mjs";

test(
  "extension-v2 E2E focus lock serialization",
  { timeout: 120_000 },
  async () => {
    const harness = await ExtensionE2EHarness.launch();
    let step = "opening test pages";

    try {
      const first = await harness.openConnectedPage();
      const second = await harness.openConnectedPage("second");

      step = "loading refs";
      const { busyRef } = await getRefs(first.socketClient, {
        busyRef: ["button", "Busy action"],
      });
      const { inputRef } = await getRefs(second.socketClient, {
        inputRef: ["textbox", "Your name"],
      });

      step = "preparing second page";
      await second.page.evaluate(() => {
        document.getElementById("name-input").value = "";
      });
      await second.page.bringToFront();
      await waitForPageFocusState(
        second.page,
        true,
        "second session focused before queued action",
      );

      step = "running focus lock serialization";
      const busyClickPromise = first.socketClient.request("browser_click", {
        ref: busyRef,
      });
      await waitForPageFocusState(
        first.page,
        true,
        "first session focused for busy click",
      );
      await waitFor(
        async () => {
          const state = await readPageTestState(first.page);
          return state.busyStartedAt ? state : undefined;
        },
        "page A busy action start",
      );

      const busyDoneStatePromise = waitFor(
        async () => {
          const state = await readPageTestState(first.page);
          return state.busyDoneAt ? state : undefined;
        },
        "page A busy action completion",
        15_000,
      );

      let queuedTypeResolvedAt = null;
      const queuedTypePromise = second.socketClient
        .request("browser_type", {
          ref: inputRef,
          text: "Serialized",
          submit: false,
        })
        .then((result) => {
          queuedTypeResolvedAt = Date.now();
          return result;
        });

      await wait(250);
      assert.equal(await second.page.inputValue("#name-input"), "");

      const [pageAStateAfterBusy] = await Promise.all([
        busyDoneStatePromise,
        busyClickPromise,
        queuedTypePromise,
      ]);

      await waitForPageFocusState(
        second.page,
        true,
        "second session focused after queued type",
      );
      assert.equal(await first.page.textContent("#busy-status"), "busy done");
      assert.equal(await second.page.inputValue("#name-input"), "Serialized");
      assert.ok(
        queuedTypeResolvedAt !== null &&
          queuedTypeResolvedAt >= pageAStateAfterBusy.busyDoneAt,
        "The second focus-locked action completed before the first busy click finished.",
      );
    } catch (error) {
      await harness.captureFailureArtifacts("e2e-focus-lock-failure");
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
