import test from "node:test";
import assert from "node:assert/strict";

import { findClickablePoint } from "../dist/content/hit-testing.js";
import {
  isProbablyNoiseText,
  normalizeText,
  shouldUseTextFallback,
} from "../dist/content/snapshot.js";

test("findClickablePoint falls back away from an obstructed center point", () => {
  const point = findClickablePoint({
    rects: [{ left: 0, top: 0, width: 120, height: 40 }],
    viewport: { width: 200, height: 200 },
    hitTest: ({ x }) => x < 35 || x > 85,
  });

  assert.ok(point);
  assert.notEqual(point.x, 60);
  assert.ok(point.x < 35 || point.x > 85);
});

test("findClickablePoint returns null when no sampled point is clickable", () => {
  const point = findClickablePoint({
    rects: [{ left: 10, top: 10, width: 80, height: 30 }],
    viewport: { width: 200, height: 200 },
    hitTest: () => false,
  });

  assert.equal(point, null);
});

test("findClickablePoint ignores rects fully outside the viewport", () => {
  const point = findClickablePoint({
    rects: [
      { left: -300, top: -50, width: 40, height: 20 },
      { left: 20, top: 20, width: 60, height: 20 },
    ],
    viewport: { width: 100, height: 100 },
    hitTest: ({ x, y }) => x >= 20 && x <= 80 && y >= 20 && y <= 40,
  });

  assert.ok(point);
  assert.ok(point.x >= 20 && point.x <= 80);
  assert.ok(point.y >= 20 && point.y <= 40);
});

test("normalizeText accepts primitive non-string values", () => {
  assert.equal(normalizeText(70), "70");
  assert.equal(normalizeText(false), "false");
  assert.equal(normalizeText(12n), "12");
});

test("normalizeText ignores object values instead of throwing", () => {
  assert.equal(normalizeText({ value: 70 }), "");
  assert.equal(normalizeText(["alpha", "beta"]), "");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(undefined), "");
});

test("isProbablyNoiseText flags generated stylesheet-like or script-like content", () => {
  assert.equal(
    isProbablyNoiseText(
      "._cropped-image-link_style_carouselContainer__3N7M1{overflow-x:scroll;overflow-y:hidden!important}.foo{display:block}@supports (container-type:size){.bar{height:100%}}",
    ),
    true,
  );
  assert.equal(
    isProbablyNoiseText(
      "function imageLoadError(img) { const fallbackImage = '/media/sites/cnn/cnn-fallback-image.jpg'; img.removeAttribute('onerror'); img.src = fallbackImage; img.dataset.imgCssVars?.split(',').forEach((property) => { img.style.removeProperty(property); }); } Andrew Harnik/Getty Images",
    ),
    true,
  );
  assert.equal(
    isProbablyNoiseText("Gallery of Apple TV shows, movies, and sports."),
    false,
  );
});

test("shouldUseTextFallback rejects noisy or oversized structural text", () => {
  assert.equal(
    shouldUseTextFallback(
      "group",
      "._cropped-image-link_style_carouselContainer__3N7M1{overflow-x:scroll;overflow-y:hidden!important}.foo{display:block}@supports (container-type:size){.bar{height:100%}}",
    ),
    false,
  );
  assert.equal(
    shouldUseTextFallback("main", "A".repeat(161)),
    false,
  );
  assert.equal(
    shouldUseTextFallback("group", "Featured content"),
    true,
  );
  assert.equal(
    shouldUseTextFallback("button", "A".repeat(300)),
    true,
  );
});
