// Explicit .js extension keeps this module loadable by plain Node ESM (the test runner),
// matching the convention documented in src/api/axios.js.
import { skeletonCellWidth, skeletonClassName, skeletonColumnKind } from './skeletonStyles.js';

/**
 * Reusable animated loading placeholders (issue #3).
 *
 * `<Skeleton>` is the primitive shape; `<SkeletonStatCard>`, `<SkeletonStatGrid>` and
 * `<SkeletonTable>` compose it into the dashboard/section layouts used by the Patient and
 * Doctor dashboards. Every shape is decorative, so it is hidden from assistive technology:
 * pair a skeleton layout with a single `role="status"` region carrying a
 * screen-reader-only message instead of letting each block be announced.
 */

/**
 * One placeholder shape.
 * `variant`: 'line' | 'block' | 'circle'; `height`/`width`/`rounded` are Tailwind classes
 * that replace the preset dimensions; `className` is for spacing and anything else.
 */
export default function Skeleton({ variant = 'line', height, width, rounded, className = '', ...rest }) {
  return <div aria-hidden="true" className={skeletonClassName({ variant, height, width, rounded, className })} {...rest} />;
}

/**
 * Placeholder for one `StatCard`: a label line plus a pill-shaped value block sized to the
 * card's real metrics (`text-sm` label, `text-2xl` value with `py-1`), so the card height
 * does not change when the data arrives.
 */
export function SkeletonStatCard({ className = '' }) {
  return (
    <div className={`card ${className}`.trim()} aria-hidden="true">
      <Skeleton variant="line" height="h-5" width="w-28" />
      <Skeleton variant="block" height="h-10" width="w-16" rounded="rounded-lg" className="mt-2" />
    </div>
  );
}

/** The responsive stat-card row used by the dashboards (`gap-4`, 1/2/4 columns). */
export function SkeletonStatGrid({ count = 4, className = '' }) {
  return (
    <div className={`mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: Math.max(1, count) }, (_, index) => (
        <SkeletonStatCard key={index} />
      ))}
    </div>
  );
}

/**
 * Placeholder for a `DataTable`: the same bordered container, header row and cell padding,
 * with one skeleton row per expected record so the table occupies the space it will once
 * the real rows render.
 */
export function SkeletonTable({ rows = 4, columns = 5, className = '' }) {
  const columnIndexes = Array.from({ length: Math.max(1, columns) }, (_, index) => index);

  return (
    <div
      className={`overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm ${className}`.trim()}
      aria-hidden="true"
    >
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            {columnIndexes.map((index) => (
              <th key={index} className="th">
                <Skeleton variant="line" height="h-4" width="w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {Array.from({ length: Math.max(1, rows) }, (_, rowIndex) => (
            <tr key={rowIndex}>
              {columnIndexes.map((columnIndex) => {
                const kind = skeletonColumnKind(columnIndex, columnIndexes.length);
                return (
                  <td key={columnIndex} className="td">
                    {kind === 'stacked' ? (
                      <>
                        <Skeleton variant="line" height="h-4" width="w-3/4" />
                        <Skeleton variant="line" height="h-3" width="w-1/2" className="mt-1" />
                      </>
                    ) : kind === 'action' ? (
                      <Skeleton variant="block" height="h-8" width="w-20" rounded="rounded-lg" />
                    ) : (
                      <Skeleton variant="line" height="h-4" width={skeletonCellWidth(columnIndex)} />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
