export const examples = [
  { label: 'Fleet join', cursorAfter: 'SELECT s.', sql: `-- Press Ctrl+Enter (⌘+Enter on Mac) after SELECT, FROM, or an alias dot.
SELECT s.handle, v.name, y.destination
FROM public.sailors s
JOIN public.vessels v ON v.captain_id = s.id
JOIN harbor.voyages y ON y.vessel_id = v.id
WHERE s.home_port = 'Lisbon';` },
  { label: 'Chained CTEs', cursorAfter: 'SELECT va.', sql: `WITH cargo_totals AS (
  SELECT c.voyage_id, count(*) AS cargo_items, sum(c.weight_kg) AS total_weight_kg
  FROM harbor.cargo c
  GROUP BY c.voyage_id
),
voyage_activity AS (
  SELECT y.id AS voyage_id, v.name AS vessel_name, p.name AS port_name,
    coalesce(ct.cargo_items, 0) AS cargo_items
  FROM harbor.voyages y
  JOIN public.vessels v ON v.id = y.vessel_id
  LEFT JOIN harbor.ports p ON p.id = y.port_id
  LEFT JOIN cargo_totals ct ON ct.voyage_id = y.id
)
SELECT va.vessel_name, va.port_name, va.cargo_items
FROM voyage_activity va
WHERE va.cargo_items > 0;` },
  { label: 'Start a CTE', cursorAfter: 'WITH acs AS (', sql: `WITH acs AS (
  SELECT s.id, s.handle
  FROM public.sailors s
)
SELECT a.handle FROM acs a;` },
  { label: 'Correlated subqueries', cursorAfter: 'AND c.', sql: `SELECT s.handle, v.name
FROM public.sailors s
JOIN public.vessels v ON v.captain_id = s.id
WHERE EXISTS (
  SELECT 1
  FROM harbor.voyages y
  JOIN harbor.ports p ON p.id = y.port_id
  WHERE y.vessel_id = v.id AND p.region = 'North Sea'
    AND EXISTS (
      SELECT 1 FROM harbor.cargo c
      WHERE c.voyage_id = y.id AND c.weight_kg > 1000
    )
);` },
  { label: 'Derived table', cursorAfter: 'SELECT recent.', sql: `SELECT recent.vessel_name, recent.destination, recent.departed_at
FROM (
  SELECT v.name AS vessel_name, y.destination, y.departed_at
  FROM public.vessels v
  JOIN harbor.voyages y ON y.vessel_id = v.id
  WHERE y.departed_at IS NOT NULL
) recent
JOIN harbor.ports p ON p.name = recent.destination
WHERE p.region = 'Atlantic';` },
  { label: 'Type declarations', cursorAfter: 'risk harbor.', sql: `CREATE TABLE harbor.cargo_checks (
  id integer,
  risk harbor.cargo_risk,
  measured_weight harbor.positive_weight
);` },
  { label: 'JOIN USING', cursorAfter: 'USING (', sql: `SELECT s.handle, v.name
FROM public.sailors s
JOIN public.vessels v USING (id)
WHERE s.id > 0;` },
  { label: 'UNION ORDER BY', cursorAfter: 'ORDER BY ', sql: `SELECT handle AS display_name FROM public.sailors
UNION ALL
SELECT destination FROM harbor.voyages
ORDER BY display_name;` },
  { label: 'Draft table', cursorAfter: 'SELECT n.', sql: `CREATE TABLE harbor.crab_notes (
  id integer,
  note text
);
SELECT n.note FROM harbor.crab_notes n;` },
  { label: 'Table function', cursorAfter: 'SELECT g.', sql: `SELECT g.generate_series
FROM generate_series(1, 5) AS g;` }
];
