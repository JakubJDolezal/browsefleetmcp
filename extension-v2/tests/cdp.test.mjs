import test from "node:test";
import assert from "node:assert/strict";

import {
  clickPoint,
  detachDebugger,
  dragBetweenPoints,
  typeText,
} from "../dist/background/cdp.js";

function createChromeMock() {
  const commands = [];
  let attachCount = 0;
  let detachCount = 0;
  let layoutMetricsCount = 0;

  return {
    commands,
    get attachCount() {
      return attachCount;
    },
    get detachCount() {
      return detachCount;
    },
    get layoutMetricsCount() {
      return layoutMetricsCount;
    },
    chrome: {
      debugger: {
        async attach() {
          attachCount += 1;
        },
        async detach() {
          detachCount += 1;
        },
        async sendCommand(_target, command, params) {
          commands.push({ command, params });
          if (command === "Page.getLayoutMetrics") {
            layoutMetricsCount += 1;
            return {
              cssVisualViewport: {
                zoom: 2,
                clientWidth: 800,
                clientHeight: 600,
              },
            };
          }
          return {};
        },
      },
    },
  };
}

test("clickPoint reuses one debugger attachment and one layout lookup", async () => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chrome;

  await clickPoint(11, { x: 10, y: 20 });
  await detachDebugger(11);

  assert.equal(mock.attachCount, 1);
  assert.equal(mock.layoutMetricsCount, 1);
  assert.deepEqual(
    mock.commands.map(({ command }) => command),
    [
      "Page.getLayoutMetrics",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ],
  );
  assert.equal(mock.detachCount, 1);
});

test("clickPoint supports human pointer motion", async () => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chrome;

  await clickPoint(
    21,
    { x: 10, y: 20 },
    { pointerMode: "human", moveSteps: 4, stepDelayMs: 0 },
  );
  await detachDebugger(21);

  assert.equal(mock.attachCount, 1);
  assert.equal(mock.layoutMetricsCount, 1);
  assert.equal(
    mock.commands.filter(({ command }) => command === "Input.dispatchMouseEvent")
      .length,
    6,
  );
});

test("dragBetweenPoints keeps layout metrics cached for the whole drag", async () => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chrome;

  await dragBetweenPoints(12, { x: 0, y: 0 }, { x: 120, y: 60 });
  await detachDebugger(12);

  assert.equal(mock.attachCount, 1);
  assert.equal(mock.layoutMetricsCount, 1);
  assert.equal(
    mock.commands.filter(({ command }) => command === "Input.dispatchMouseEvent")
      .length,
    15,
  );
});

test("typeText dispatches keyboard events for each character", async () => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chrome;

  await typeText(31, "A1-");
  await detachDebugger(31);

  assert.equal(mock.attachCount, 1);
  assert.equal(mock.layoutMetricsCount, 0);
  assert.deepEqual(
    mock.commands.map(({ command }) => command),
    [
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ],
  );
  assert.equal(
    mock.commands.some(({ command }) => command === "Input.insertText"),
    false,
  );
});
