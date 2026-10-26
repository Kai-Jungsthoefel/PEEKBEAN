// SPDX-License-Identifier: GPL-3.0-or-later
// Pattern hatches whose lines are tiny compared with their area make dxf-viewer compute millions of segments (one large
// drawing spent 62 of 65 seconds on 68 hatches) and then give up anyway. Each pattern hatch gets a budget here; a hatch
// that runs over it is drawn as a filled area in its color, which is also how such dense patterns look in CAD programs.

const MAX_LINES = 3000;
const MAX_SEGMENTS = 150_000;
const MAX_MILLISECONDS = 400;

class TooDense extends Error {}

interface Budget {
  lines: number;
  segments: number;
  until: number;
}

type Generator = (...args: unknown[]) => Iterable<unknown>;

/** Patches DxfScene.prototype in place; returns a counter of the hatches drawn as fills. */
export function limitHatchDensity(DxfScene: { prototype: object }): { filled: number } {
  const proto = DxfScene.prototype as Record<string, Generator>;
  const decomposeHatch = proto._DecomposeHatch;
  const decomposeLine = proto._DecomposeHatchLine;
  if (typeof decomposeHatch !== 'function' || typeof decomposeLine !== 'function') {
    throw new Error('dxf-viewer changed: the hatch budget in hatch-limit.ts no longer applies.');
  }
  const stats = { filled: 0 };
  let budget: Budget | null = null;

  proto._DecomposeHatchLine = function* (this: unknown, ...args: unknown[]) {
    if (budget && (++budget.lines > MAX_LINES || performance.now() > budget.until)) throw new TooDense();
    for (const entity of decomposeLine.apply(this, args)) {
      if (budget && ++budget.segments > MAX_SEGMENTS) throw new TooDense();
      yield entity;
    }
  };

  proto._DecomposeHatch = function* (this: unknown, entity: unknown, blockCtx: unknown) {
    const hatch = entity as { isSolid?: boolean };
    if (hatch.isSolid) {
      yield* decomposeHatch.call(this, entity, blockCtx);
      return;
    }
    // Collect first: if the budget runs out halfway, none of the partial pattern is drawn.
    const produced: unknown[] = [];
    budget = { lines: 0, segments: 0, until: performance.now() + MAX_MILLISECONDS };
    try {
      for (const e of decomposeHatch.call(this, entity, blockCtx)) produced.push(e);
    } catch (error) {
      if (!(error instanceof TooDense)) throw error;
      budget = null;
      stats.filled++;
      yield* decomposeHatch.call(this, { ...hatch, isSolid: true }, blockCtx);
      return;
    } finally {
      budget = null;
    }
    yield* produced;
  };
  return stats;
}
