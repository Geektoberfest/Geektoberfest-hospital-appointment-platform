/**
 * Pure shape/style helpers for the shared `Skeleton` component (issue #3).
 *
 * Kept free of JSX on purpose so the plain Node test runner can unit test them directly
 * (`frontend/tests/skeleton.test.js`), mirroring `src/api/authSession.js`.
 */

/**
 * Base classes shared by every skeleton shape.
 *
 * - `animate-pulse` is Tailwind's built-in fade, so no custom keyframes and no animation
 *   dependency are needed.
 * - `motion-reduce:animate-none` stops the pulse for users who ask for reduced motion.
 *   The placeholder stays visible (it is a plain `bg-slate-200` block), so the loading
 *   state remains readable with animations disabled.
 * - `bg-slate-200` matches the neutral slate palette used by the cards and tables.
 */
export const SKELETON_BASE = 'animate-pulse bg-slate-200 motion-reduce:animate-none';

/**
 * Shape presets supplying the default corner and dimensions for a variant.
 * `line` = text line / table cell, `block` = content area, button or pill, `circle` = avatar.
 */
export const SKELETON_SHAPES = {
  line: { rounded: 'rounded', height: 'h-4', width: 'w-full' },
  block: { rounded: 'rounded-lg', height: 'h-16', width: 'w-full' },
  circle: { rounded: 'rounded-full', height: 'h-10', width: 'w-10' },
};

export const DEFAULT_SKELETON_VARIANT = 'line';

/**
 * Compose the class list for one skeleton shape.
 *
 * `height`, `width` and `rounded` are Tailwind class strings (`'h-5'`, `'w-28'`,
 * `'rounded-full'`). When one is supplied it *replaces* the preset value rather than being
 * appended to it: emitting both would leave Tailwind's generated CSS order — not the class
 * attribute — to decide the winner, which is exactly the kind of silent sizing bug that
 * makes skeletons the wrong height.
 *
 * `className` is for everything that does not conflict (margins, alignment, visibility).
 */
export const skeletonClassName = ({ variant = DEFAULT_SKELETON_VARIANT, height, width, rounded, className = '' } = {}) => {
  const shape = SKELETON_SHAPES[variant] || SKELETON_SHAPES[DEFAULT_SKELETON_VARIANT];
  const extra = typeof className === 'string' ? className.trim() : '';
  return [
    SKELETON_BASE,
    rounded || shape.rounded,
    height || shape.height,
    width || shape.width,
    extra,
  ]
    .filter(Boolean)
    .join(' ');
};

/**
 * Which placeholder a table column gets.
 *
 * The appointments table (`AppointmentList`) renders five columns — Date, Time,
 * Doctor/Patient, Status, Actions — where the third cell holds two stacked lines (a name
 * plus a secondary detail) and the last cell holds a button. Mirroring that keeps a
 * skeleton row as tall as a real one. Any other table gets plain text lines.
 */
export const skeletonColumnKind = (index, columns) => {
  if (!Number.isFinite(columns) || columns <= 0) return 'line';
  if (index === columns - 1) return 'action';
  if (index === 2 && columns >= 4) return 'stacked';
  return 'line';
};

/** Cell widths cycled for plain text cells so a row does not read as one solid bar. */
export const SKELETON_CELL_WIDTHS = ['w-24', 'w-28', 'w-3/4', 'w-20'];

export const skeletonCellWidth = (index) => {
  const safe = Number.isFinite(index) ? Math.trunc(index) : 0;
  return SKELETON_CELL_WIDTHS[((safe % SKELETON_CELL_WIDTHS.length) + SKELETON_CELL_WIDTHS.length) % SKELETON_CELL_WIDTHS.length];
};
