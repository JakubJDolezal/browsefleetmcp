export type Point = {
  x: number;
  y: number;
};

export type RectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ViewportLike = {
  width: number;
  height: number;
};

function rectArea(rect: RectLike): number {
  return rect.width * rect.height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clipRectToViewport(
  rect: RectLike,
  viewport: ViewportLike,
): RectLike | null {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const clippedLeft = Math.max(rect.left, 0);
  const clippedTop = Math.max(rect.top, 0);
  const clippedRight = Math.min(right, viewport.width);
  const clippedBottom = Math.min(bottom, viewport.height);

  if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) {
    return null;
  }

  return {
    left: clippedLeft,
    top: clippedTop,
    width: clippedRight - clippedLeft,
    height: clippedBottom - clippedTop,
  };
}

function buildCandidatePoints(rect: RectLike): Point[] {
  const columns = Math.min(8, Math.max(3, Math.ceil(rect.width / 80)));
  const rows = Math.min(6, Math.max(3, Math.ceil(rect.height / 40)));
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const points: Array<Point & { distance: number }> = [];
  const seen = new Set<string>();

  const addPoint = (x: number, y: number) => {
    const key = `${Math.round(x * 100)}:${Math.round(y * 100)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const dx = x - centerX;
    const dy = y - centerY;
    points.push({
      x,
      y,
      distance: dx * dx + dy * dy,
    });
  };

  addPoint(centerX, centerY);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      addPoint(
        rect.left + ((column + 0.5) / columns) * rect.width,
        rect.top + ((row + 0.5) / rows) * rect.height,
      );
    }
  }

  return points
    .sort((left, right) => left.distance - right.distance)
    .map(({ x, y }) => ({ x, y }));
}

export function findClickablePoint(options: {
  rects: RectLike[];
  viewport: ViewportLike;
  hitTest: (point: Point) => boolean;
}): Point | null {
  const rects = options.rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => clipRectToViewport(rect, options.viewport))
    .filter((rect): rect is RectLike => rect !== null)
    .sort((left, right) => rectArea(right) - rectArea(left));

  for (const rect of rects) {
    for (const point of buildCandidatePoints(rect)) {
      const x = clamp(point.x, rect.left, rect.left + rect.width);
      const y = clamp(point.y, rect.top, rect.top + rect.height);
      if (options.hitTest({ x, y })) {
        return { x, y };
      }
    }
  }

  return null;
}
