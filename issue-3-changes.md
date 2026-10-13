# Issue #3: Reusable Animated Skeleton Loaders for Dashboard Cards

## 1. Issue Overview and Objective

[Issue #3](https://github.com/Geektoberfest/Geektoberfest-hospital-appointment-platform/issues/3)
asks for a **reusable, animated skeleton-loading component** and for the Patient and Doctor
dashboards to use it in place of their text-only loading placeholders.

The delivered work:

- adds `frontend/src/components/common/Skeleton.jsx` — one primitive shape plus three compositions
  (`SkeletonStatCard`, `SkeletonStatGrid`, `SkeletonTable`) that mirror the existing `StatCard`,
  `DataTable` and `AppointmentList` layouts;
- moves the pure class/layout arithmetic into `frontend/src/components/common/skeletonStyles.js`, so
  the project's existing `node --test` runner can unit test it without a DOM;
- replaces `return <Spinner />` on both dashboards with a skeleton layout that matches the loaded
  screen, sharing one header between the loading and loaded branches so the two states cannot drift;
- adds `frontend/tests/skeleton.test.js` (7 tests) covering the class contract and the table-column
  mapping.

No API call, piece of state, route, or business rule was changed, and no dependency was added.

## 2. Problem Addressed

Both dashboards previously rendered a single centred spinner while their data was in flight:

```jsx
// before — frontend/src/pages/patient/PatientDashboard.jsx (and the Doctor dashboard)
if (appts.loading || waiting.loading) return <Spinner />;
```

Three problems with that:

1. **It says nothing about what is coming.** The patient dashboard renders four `StatCard`s and a
   five-row appointments table; a spinner gives no sense of that shape.
2. **It causes a large layout jump.** The spinner is one ~48 px row, so the page grows by hundreds of
   pixels the moment data arrives — the exact shift a loading state should avoid.
3. **It is inconsistent with the design system.** The rest of the app is built from the Tailwind
   `card` / `th` / `td` component classes; a bare centred spinner is the only element that does not
   look like the surrounding UI.

`Spinner` itself is still used by ~20 other places (admin dashboards and lists, session checks,
detail pages), so it was left in place rather than replaced globally — the issue's scope is the two
dashboards.

## 3. The Reusable Skeleton Component

### Files

| File | Role |
|---|---|
| `frontend/src/components/common/Skeleton.jsx` | The component: `Skeleton` primitive + `SkeletonStatCard`, `SkeletonStatGrid`, `SkeletonTable`. |
| `frontend/src/components/common/skeletonStyles.js` | JSX-free helpers (`SKELETON_BASE`, `SKELETON_SHAPES`, `skeletonClassName`, `skeletonColumnKind`, `skeletonCellWidth`, …) that own the class arithmetic. |

The split mirrors the convention already used by `frontend/src/api/authSession.js` and
`frontend/src/utils/format.js`: the logic that is worth asserting lives in a plain ES module that
Node can import directly. `Skeleton.jsx` imports it with an explicit extension
(`'./skeletonStyles.js'`) — the same constraint documented in `frontend/src/api/axios.js` — which is
what makes `frontend/tests/skeleton.test.js` loadable by the `node --test` runner.

### Component API

| Export | Props | Renders |
|---|---|---|
| `Skeleton` *(default)* | `variant` (`'line'` \| `'block'` \| `'circle'`, default `'line'`), `height`, `width`, `rounded` (Tailwind classes that **replace** the preset dimensions), `className` (spacing/anything non-conflicting), `...rest` | One `aria-hidden` placeholder `<div>`. |
| `SkeletonStatCard` | `className` | A `.card` shell with a label line (`h-5 w-28`) and a value pill (`h-10 w-16 rounded-lg mt-2`) — the shape of `StatCard`. |
| `SkeletonStatGrid` | `count = 4`, `className` | `mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4` holding `count` `SkeletonStatCard`s — the exact grid classes the dashboards use for real stats. |
| `SkeletonTable` | `rows = 4`, `columns = 5`, `className` | The same `overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm` container, `th` header row and `td` cells as `DataTable`, with one skeleton row per `rows`. |

Presets (`SKELETON_SHAPES`):

| Variant | Corner | Dimensions | Intended use |
|---|---|---|---|
| `line` | `rounded` | `h-4 w-full` | Text line, table cell |
| `block` | `rounded-lg` | `h-16 w-full` | Content area, button, value pill |
| `circle` | `rounded-full` | `h-10 w-10` | Avatar / icon |

Design decisions worth recording:

- **Explicit dimensions replace the preset rather than being appended.** Emitting `h-4` and `h-5`
  together would leave the winner to the ordering of Tailwind's generated CSS rather than to the
  call site — a silent sizing bug. `skeletonClassName` therefore returns `height || shape.height`,
  and `tests/skeleton.test.js` asserts the preset is absent when an override is passed.
- **An unknown or missing variant falls back to `line`** instead of throwing or rendering an
  unstyled div.
- **Every shape is a static Tailwind class string.** Nothing is composed at runtime, so Tailwind v4's
  source scanner emits all of it (verified in the built stylesheet — section 9).
- **The table mirrors `AppointmentList`'s five columns** (Date, Time, Doctor/Patient, Status,
  Actions): the third cell becomes two stacked lines (name + secondary detail) and the last cell a
  button-sized block, so a skeleton row is as tall as the real row. `skeletonColumnKind` encodes that
  convention and degrades safely (`columns <= 0`, `NaN` → plain lines).

### Animation

- `animate-pulse` — Tailwind's built-in fade. No custom keyframes, no animation library, no new
  dependency, and therefore nothing new for the bundler to resolve.
- `motion-reduce:animate-none` — under `prefers-reduced-motion: reduce` the pulse stops, while the
  shapes stay visible because they are plain `bg-slate-200` blocks. A user who disables animation
  still sees an unambiguous "content is loading" layout.
- `bg-slate-200` keeps the placeholder neutral against the app's slate palette (cards are white,
  page background `slate-50`).
- The pulse is a fade rather than a travelling gradient shimmer: the issue asked for restraint and
  for the existing utilities, and a shimmer would require custom keyframes in `index.css`.

## 4. Patient Dashboard Changes

`frontend/src/pages/patient/PatientDashboard.jsx`:

1. The `PageHeader` (title, subtitle, "Find a doctor" action) was extracted into a `header` const
   that **both** branches render. It depends only on the signed-in user, not on the requests, so
   showing the real header during loading removes the biggest jump — and the title/action can no
   longer drift between the two states.
2. `if (appts.loading || waiting.loading) return <Spinner />` became a skeleton layout:

```jsx
if (appts.loading || waiting.loading) {
  return (
    <div>
      {header}
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading dashboard…</span>
        <SkeletonStatGrid count={4} />
        <h2 className="mb-3 text-lg font-semibold">Upcoming appointments</h2>
        <SkeletonTable rows={5} columns={5} />
      </div>
    </div>
  );
}
```

3. `rows={5}`/`columns={5}` are not arbitrary: the loaded branch renders
   `<AppointmentList appointments={upcoming.slice(0, 5)} role="patient" />`, whose table has five
   columns. The section heading is the real `<h2>`, so the spacing around it is identical in both
   states.
4. The data itself, the two `useFetch` calls, the `loading`/`error`/empty handling and the rest of
   the render are untouched (the diff is limited to the import, the header extraction and the
   loading branch).

## 5. Doctor Dashboard Changes

`frontend/src/pages/doctor/DoctorDashboard.jsx` gets the same treatment, adapted to its own content:

- the same shared `header` const (`Welcome, Dr. …`, "Manage availability");
- the same `SkeletonStatGrid count={4}` (the loaded branch also renders four `StatCard`s:
  Today's appointments, Upcoming booked, Open availability windows, Patients waiting);
- the real section heading ("Next appointments") and `SkeletonTable rows={5} columns={5}`, matching
  its `AppointmentList … slice(0, 5)` with `role="doctor"`;
- the three-request gate (`appts.loading || avail.loading || waiting.loading`), the three `useFetch`
  calls, the error `Alert`, the sorting/filtering and the table are unchanged.

The two dashboards share the skeleton component instead of copying markup: the only duplication left
is the four-line loading block itself, which differs per page in its gate, heading and header.

## 6. Loading, Error and Empty States

The three states stay clearly separated, in the original order:

| State | Behaviour (unchanged unless noted) |
|---|---|
| **Loading** | Skeleton layout, inside one `role="status" aria-busy="true"` region. Placed exactly where the previous `Spinner` early-return was, so it shows only while a request is in flight. |
| **Error** | The early return is skipped as soon as `loading` is false, so the existing `<Alert>{…error}</Alert>` renders the same message as before. Skeletons are never shown after a failed request, and while loading there is no alert (`Alert` returns `null` for empty children). |
| **Empty** | Untouched. The patient dashboard keeps its "No upcoming appointments. Browse doctors…" card; the Doctor dashboard keeps `AppointmentList` → `DataTable` → `EmptyState` ("No appointments found"). |
| **Success** | Untouched: the real `StatCard`s and `AppointmentList` table. |

No request was added, no `useEffect`/dependency array was touched, and no new state was introduced,
so loading cannot become infinite and no extra API call or re-render is triggered. The skeletons
disappear on the same state transition that previously hid the spinner.

## 7. Accessibility and Responsiveness

**Accessibility.** A skeleton layout is decorative, so every shape is `aria-hidden="true"`. Hiding
43 individual blocks and instead exposing a *single* live region is what keeps screen-reader output
useful:

```jsx
<div role="status" aria-busy="true">
  <span className="sr-only">Loading dashboard…</span>
  <SkeletonStatGrid count={4} />
  <SkeletonTable rows={5} columns={5} />
</div>
```

Without `aria-hidden`, a screen reader would announce dozens of empty containers; with it, the state
is announced once ("Loading dashboard…") and `aria-busy` marks the region as updating. This was
verified in the rendered markup (section 9): each dashboard's loading branch contains exactly one
`role="status"`, one `sr-only` node and 49 `aria-hidden` nodes (43 shapes + 6 layout containers) — and
zero shapes are left visible to assistive technology.

**Responsiveness.** The skeleton reuses the *same* layout classes as the content it replaces, so it
inherits the app's existing breakpoints instead of re-implementing them:

- stat grid: `mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4` → 1 column on mobile, 2 on tablet, 4 on
  desktop, identical gaps and margins to the loaded row;
- table: identical container (`overflow-x-auto rounded-xl border …`), `th` header row and `td`
  padding, so narrow screens scroll the skeletons inside the card exactly as they scroll the real
  table, with no page-level horizontal overflow (measured — section 9);
- heights are matched to the real elements (heading sizes, card padding via `.card`, `th`/`td`
  padding via those component classes) so the swap to real content shifts as little as possible.

## 8. Files Added or Modified

| File | Change | Why |
|---|---|---|
| `frontend/src/components/common/Skeleton.jsx` | **Added.** `Skeleton` + `SkeletonStatCard` / `SkeletonStatGrid` / `SkeletonTable`. | The reusable component the issue asks for. |
| `frontend/src/components/common/skeletonStyles.js` | **Added.** Pure class/layout helpers. | Keeps the arithmetic testable by the existing Node runner (no DOM harness, no new test framework). |
| `frontend/src/pages/patient/PatientDashboard.jsx` | **Modified:** import, shared `header` const, skeleton loading branch. | Replaces the text-only placeholder with a layout matching the dashboard. |
| `frontend/src/pages/doctor/DoctorDashboard.jsx` | **Modified:** same three edits, adapted to the Doctor content. | Same, for the Doctor dashboard. |
| `frontend/tests/skeleton.test.js` | **Added.** 7 tests. | Locks the reduced-motion/size class contract and the table-column mapping. |

Nothing else changed: no `package.json`, no lockfile, no `index.css`, no `Spinner.jsx`, no routing,
no API module, and no other page. Both `dist/` and the temporary verification harness described in
section 9 were removed from the tree (`git status` shows only the five files above).

## 9. Commands Executed and Actual Results

**Environment note (honest reporting).** This machine has no `node`/`npm` on `PATH` (checked:
`command -v node`, `command -v npm`, and the Windows `PATH` entries). Node was run from the portable
official **v24.21.0** build already unpacked outside the repository
(`%TEMP%\node-portable\node-v24.21.0-win-x64`, the same runtime used for issue #5). `frontend/node_modules`
was already installed, so no install step ran and no lockfile changed. Because `npm` is unavailable,
the scripts were run through their underlying commands — `npm test` is
`node --test tests/*.test.js` and `npm run build` is `vite build`, invoked as
`node node_modules/vite/bin/vite.js build`.

| Command | Location | Result |
|---|---|---|
| `node --test tests/skeleton.test.js` | `frontend/` | **7 tests, 7 passed, 0 failed** (exit 0) |
| `node --test tests/*.test.js` | `frontend/` | **61 tests, 61 passed, 0 failed** (exit 0) — 54 pre-existing + 7 new |
| `node node_modules/vite/bin/vite.js build` | `frontend/` | **Succeeded (exit 0)**, `✓ built in 606ms`, 718 modules (716 before → +2 for the two new modules); only the pre-existing `>500 kB` chunk-size advisory |
| `grep` over `dist/assets/index-*.css` | `frontend/` | The new utilities are really emitted: `.animate-pulse{animation:var(--animate-pulse)}`, `bg-slate-200`, `sr-only`, `.h-4/.h-5/.h-10/.h-16/.w-10/.w-16/.w-20/.w-24/.w-28`, `.rounded-full`, `.rounded-lg`, and `@media (prefers-reduced-motion:reduce){.motion-reduce\:animate-none{animation:none}}` |
| Temporary SSR render harness (`vite build --ssr` of a throwaway entry + a throwaway `useFetch` alias) | `frontend/` | **112 assertions, 0 failures, exit 0 in all three modes**: 45 checks with `loading`, 33 with `empty`, 34 with `error` |
| Browser inspection of the real loading markup with the inlined production CSS | Preview tab | Desktop 1280×900 and mobile 390×844; results in the paragraph below |

**What the render harness proved.** `renderToStaticMarkup` runs no effects and the real `useFetch`
initialises `loading: true`, so server-rendering the two dashboards rendered their genuine first
paint. A temporary Vite config aliased `../../hooks/useFetch` to a mock that reports the requested
state, which is how the `empty` and `error` branches were reached too:

- **loading:** per dashboard exactly 4 stat cards, 43 animated shapes (8 stat + 35 table) inside 49
  `aria-hidden` nodes, one `role="status"`, one `sr-only` node, table = 5 header cells + 25 body
  cells in 6 rows, zero `animate-spin` left behind, zero error alerts;
- **empty:** 0 animated shapes on both dashboards, no status region, and the empty copy is intact —
  "No upcoming appointments." (patient) and "No appointments found" (doctor);
- **error:** 0 animated shapes, exactly one `role="alert"` per dashboard, and the message preserved
  verbatim (`Cannot reach the server. Is the API running?`) — skeletons never outlive a failed
  request;
- **primitive/composition checks:** `line` renders exactly one hidden div with class
  `animate-pulse bg-slate-200 motion-reduce:animate-none rounded h-4 w-full`; `circle` →
  `rounded-full h-10 w-10`; an override (`h-5 w-28`) replaces the preset instead of joining it;
  `className="mt-2"` is appended; an unknown variant renders identically to `line`.

**What the browser inspection proved.** The loading markup was served with the production stylesheet
and inspected at 1280×900 and 390×844:

- 98/98 placeholder shapes had non-zero dimensions (the skeletons are visible, not collapsed);
- computed `animation-name` was `pulse`, and all 86 pulsing shapes also carried
  `motion-reduce:animate-none`;
- placeholder background computed to `oklch(0.929 0.013 255.508)` (Tailwind `slate-200`), with the
  card wrappers white — neutral, on-palette;
- corner radii in use: `4px` (`rounded`, text lines), `8px` (`rounded-lg`, value pills and action
  blocks), `12px` (`rounded-xl`, cards/table container) — as intended;
- at 390 px there was **no page-level horizontal overflow** (`documentElement.scrollWidth === clientWidth === 374`)
  while the table scrolled inside its own container (324 px viewport vs 592 px content), and the stat
  cards stacked to one column — matching the loaded dashboard's behaviour.

**Lint: not run — not supported by this repository.** Neither `frontend/package.json` nor
`backend/package.json` declares a `lint` script, and there is no ESLint/Biome/Prettier configuration
or linter binary in the tree. Reported as unavailable, not as a pass.

**Backend tests: not run.** This change touches only files under `frontend/`, so the backend suite
(`backend/`) is unaffected.

## 10. Remaining Issues and Limitations

1. **The committed test suite covers the helpers, not the JSX.** `frontend/tests/skeleton.test.js`
   exercises `skeletonStyles.js`; the component and dashboard rendering was verified with a
   temporary SSR harness that was deleted afterwards. The project has no `jsdom` or React Testing
   Library dependency, and adding one was out of scope, so CI will not catch a future regression that
   only misuses the component (e.g. a wrong `rows` prop) rather than breaking the helpers.
2. **The skeleton row count is fixed** (`rows={5}`), chosen to match the `slice(0, 5)` both dashboards
   render. A dashboard showing more or fewer appointments will differ in height while loading; the
   count is a prop, so a caller with a different page size can pass its own.
3. **`SkeletonTable`'s column shape is a convention, not a prop.** Three specific columns are treated
   as "stacked" and "action" to mirror `AppointmentList`. A table with a different structure would
   need a further prop or its own composition.
4. **Only the two dashboards were migrated.** `Spinner` is still used by ~20 other pages
   (`AdminDashboard`, `AnalyticsDashboard`, the admin/patient/doctor list pages, `Sessions`,
   session-check and detail views). That is deliberate — the issue names the Patient and Doctor
   dashboards — but it leaves the app's loading UI inconsistent between pages.
5. **The animation is a fade, not a shimmer.** A travelling gradient would need custom keyframes
   added to `index.css`; the issue preferred the existing utilities and no new dependency.
6. **`prefers-reduced-motion` was verified statically, not by emulating the OS setting.** The
   Tailwind rule is emitted in the built CSS and every animated shape carries the variant class, but
   the browser tooling available here cannot force the media query, so the reduced-motion rendering
   itself was not observed.
7. **Real network latency was not exercised.** The state branches were driven by rendering the
   dashboards with the request state fixed; running the app against the live API and MongoDB (and a
   logged-in patient/doctor account) to watch the skeleton-to-content transition was not possible in
   this environment.
