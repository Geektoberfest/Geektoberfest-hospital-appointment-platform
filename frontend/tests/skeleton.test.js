import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SKELETON_VARIANT,
  SKELETON_BASE,
  SKELETON_CELL_WIDTHS,
  SKELETON_SHAPES,
  skeletonCellWidth,
  skeletonClassName,
  skeletonColumnKind,
} from '../src/components/common/skeletonStyles.js';

/**
 * Unit tests for the pure helpers behind the shared `Skeleton` component (issue #3).
 *
 * The helpers live in `skeletonStyles.js` (no JSX) precisely so the project's existing
 * `node --test` runner can cover them without a DOM harness. They own the two things that
 * are easy to get silently wrong: the reduced-motion/size class contract, and which
 * placeholder each table column gets.
 */

/** Class list as a token Set, so assertions compare whole Tailwind utilities. */
const tokensOf = (options) => new Set(skeletonClassName(options).split(/\s+/).filter(Boolean));

test('the base classes keep skeletons animated, neutral and motion-safe', () => {
  for (const token of ['animate-pulse', 'bg-slate-200', 'motion-reduce:animate-none']) {
    assert.ok(SKELETON_BASE.split(' ').includes(token), `expected "${token}" in the base classes`);
  }
  // Built-in Tailwind utilities only: no custom keyframes or animation library.
  assert.equal(SKELETON_BASE.includes('['), false, 'no arbitrary values are needed');

  for (const variant of Object.keys(SKELETON_SHAPES)) {
    const tokens = tokensOf({ variant });
    for (const token of ['animate-pulse', 'bg-slate-200', 'motion-reduce:animate-none']) {
      assert.ok(tokens.has(token), `variant ${variant} must keep "${token}"`);
    }
  }
});

test('each variant supplies a default corner and dimensions', () => {
  assert.deepEqual(Object.keys(SKELETON_SHAPES), ['line', 'block', 'circle']);
  assert.equal(DEFAULT_SKELETON_VARIANT, 'line');

  assert.deepEqual(SKELETON_SHAPES.line, { rounded: 'rounded', height: 'h-4', width: 'w-full' });
  assert.deepEqual(SKELETON_SHAPES.block, { rounded: 'rounded-lg', height: 'h-16', width: 'w-full' });
  assert.deepEqual(SKELETON_SHAPES.circle, { rounded: 'rounded-full', height: 'h-10', width: 'w-10' });

  const line = tokensOf({});
  assert.ok(line.has('h-4'));
  assert.ok(line.has('w-full'));
  assert.ok(line.has('rounded'));
});

test('explicit dimensions replace the preset instead of being emitted alongside it', () => {
  // Emitting both sizes would leave Tailwind's CSS order, not the class list, to decide the
  // winner - the sizing bug that makes a skeleton the wrong height.
  const tokens = tokensOf({ variant: 'line', height: 'h-5', width: 'w-28' });
  assert.ok(tokens.has('h-5'));
  assert.ok(tokens.has('w-28'));
  assert.equal(tokens.has('h-4'), false, 'the preset height must not be emitted');
  assert.equal(tokens.has('w-full'), false, 'the preset width must not be emitted');

  const circle = tokensOf({ variant: 'circle', rounded: 'rounded-lg', height: 'h-8', width: 'w-20' });
  assert.ok(circle.has('rounded-lg'));
  assert.ok(circle.has('h-8'));
  assert.ok(circle.has('w-20'));
  assert.equal(circle.has('rounded-full'), false);
  assert.equal(circle.has('h-10'), false);
  assert.equal(circle.has('w-10'), false);
});

test('an unknown or missing variant falls back to the line preset', () => {
  assert.equal(skeletonClassName({}), skeletonClassName({ variant: DEFAULT_SKELETON_VARIANT }));
  assert.equal(skeletonClassName({ variant: 'blob' }), skeletonClassName({ variant: 'line' }));
  assert.equal(skeletonClassName({ variant: undefined }), skeletonClassName({ variant: 'line' }));
  assert.equal(skeletonClassName(), skeletonClassName({ variant: 'line' }));
});

test('the call-site className is appended and the class list stays clean', () => {
  const tokens = tokensOf({ className: '  mt-2  ' });
  assert.ok(tokens.has('mt-2'));
  assert.ok(tokens.has('h-4'), 'the preset is still applied');

  const withoutExtra = skeletonClassName({});
  assert.equal(withoutExtra.includes('  '), false, 'no double spaces');
  assert.equal(withoutExtra, withoutExtra.trim(), 'no leading/trailing whitespace');
  assert.equal(tokensOf({ className: '   ' }).has(''), false, 'a whitespace-only className adds nothing');
  assert.equal(tokensOf({ className: null }).size, tokensOf({}).size, 'a non-string className is ignored');
});

test('table columns mirror the appointments table layout', () => {
  // Date, Time, Doctor/Patient, Status, Actions
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => skeletonColumnKind(index, 5)),
    ['line', 'line', 'stacked', 'line', 'action']
  );
  // The last column is always the action column, even in a short table.
  assert.equal(skeletonColumnKind(2, 3), 'action');
  assert.equal(skeletonColumnKind(2, 4), 'stacked');
  // Degenerate inputs never produce an unusable kind.
  assert.equal(skeletonColumnKind(0, 0), 'line');
  assert.equal(skeletonColumnKind(0, Number.NaN), 'line');
  assert.equal(skeletonColumnKind(0, -3), 'line');
});

test('plain cell widths cycle deterministically', () => {
  assert.deepEqual([0, 1, 2, 3].map(skeletonCellWidth), SKELETON_CELL_WIDTHS);
  assert.equal(skeletonCellWidth(SKELETON_CELL_WIDTHS.length), SKELETON_CELL_WIDTHS[0], 'wraps around');
  assert.equal(skeletonCellWidth(-1), SKELETON_CELL_WIDTHS[SKELETON_CELL_WIDTHS.length - 1], 'negative indexes wrap');
  assert.equal(skeletonCellWidth(Number.NaN), SKELETON_CELL_WIDTHS[0]);
  assert.equal(typeof skeletonCellWidth(7), 'string');
});
