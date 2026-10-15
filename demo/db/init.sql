CREATE SCHEMA harbor;

CREATE TABLE public.sailors (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handle text NOT NULL UNIQUE,
  home_port text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.vessels (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  captain_id integer REFERENCES public.sailors(id),
  launched_on date
);

CREATE TABLE harbor.voyages (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vessel_id integer NOT NULL REFERENCES public.vessels(id),
  destination text NOT NULL,
  departed_at timestamptz
);

CREATE VIEW public.active_fleet AS
SELECT v.id, v.name, s.handle AS captain
FROM public.vessels v
LEFT JOIN public.sailors s ON s.id = v.captain_id;

CREATE FUNCTION harbor.port_label(port_name text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT '⚓ ' || port_name $$;

INSERT INTO public.sailors (handle, home_port) VALUES
  ('redclaw', 'Lisbon'), ('mooncrab', 'Hamburg'), ('kelpkeeper', 'Oslo');

INSERT INTO public.vessels (name, captain_id, launched_on) VALUES
  ('The Sideways', 1, '2024-05-12'),
  ('Shell Runner', 2, '2025-03-21'),
  ('Pearl Current', 3, '2023-09-07');

INSERT INTO harbor.voyages (vessel_id, destination, departed_at) VALUES
  (1, 'Azores', '2026-06-01 09:00+00'),
  (2, 'Heligoland', '2026-07-14 12:30+00'),
  (3, 'Bergen', NULL);

CREATE TABLE public.vessel_classes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  max_crew integer NOT NULL,
  max_cargo_kg numeric(12,2) NOT NULL
);

ALTER TABLE public.vessels ADD COLUMN class_id integer REFERENCES public.vessel_classes(id);

CREATE TABLE harbor.ports (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  region text NOT NULL,
  country text NOT NULL
);

ALTER TABLE harbor.voyages
  ADD COLUMN port_id integer REFERENCES harbor.ports(id),
  ADD COLUMN status text NOT NULL DEFAULT 'planned',
  ADD COLUMN arrived_at timestamptz;

CREATE TABLE harbor.berths (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  port_id integer NOT NULL REFERENCES harbor.ports(id),
  code text NOT NULL,
  max_length_m numeric(8,2) NOT NULL,
  occupied_by integer REFERENCES public.vessels(id),
  UNIQUE (port_id, code)
);

CREATE TABLE public.crew_assignments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sailor_id integer NOT NULL REFERENCES public.sailors(id),
  vessel_id integer NOT NULL REFERENCES public.vessels(id),
  role text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE TABLE public.sailor_certifications (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sailor_id integer NOT NULL REFERENCES public.sailors(id),
  certificate text NOT NULL,
  issued_on date NOT NULL,
  expires_on date
);

CREATE TABLE public.vessel_maintenance (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vessel_id integer NOT NULL REFERENCES public.vessels(id),
  task text NOT NULL,
  due_on date NOT NULL,
  completed_on date,
  estimated_cost numeric(12,2)
);

CREATE TABLE public.provision_orders (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vessel_id integer NOT NULL REFERENCES public.vessels(id),
  supplier text NOT NULL,
  ordered_on date NOT NULL,
  status text NOT NULL,
  total_cost numeric(12,2)
);

CREATE TABLE harbor.voyage_stops (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  voyage_id integer NOT NULL REFERENCES harbor.voyages(id),
  port_id integer NOT NULL REFERENCES harbor.ports(id),
  stop_order integer NOT NULL,
  eta timestamptz,
  arrived_at timestamptz,
  UNIQUE (voyage_id, stop_order)
);

CREATE TABLE harbor.cargo (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  voyage_id integer NOT NULL REFERENCES harbor.voyages(id),
  description text NOT NULL,
  weight_kg numeric(12,2) NOT NULL,
  declared_value numeric(12,2),
  status text NOT NULL DEFAULT 'loaded'
);

CREATE TABLE harbor.cargo_events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cargo_id integer NOT NULL REFERENCES harbor.cargo(id),
  event_type text NOT NULL,
  happened_at timestamptz NOT NULL,
  notes text
);

CREATE TABLE harbor.weather_reports (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  port_id integer NOT NULL REFERENCES harbor.ports(id),
  observed_at timestamptz NOT NULL,
  wind_knots numeric(6,2),
  wave_height_m numeric(6,2),
  conditions text
);

CREATE TABLE harbor.tide_observations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  port_id integer NOT NULL REFERENCES harbor.ports(id),
  observed_at timestamptz NOT NULL,
  height_m numeric(6,2) NOT NULL,
  phase text NOT NULL
);

CREATE TABLE harbor.port_fees (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  port_id integer NOT NULL REFERENCES harbor.ports(id),
  vessel_class_id integer NOT NULL REFERENCES public.vessel_classes(id),
  fee_per_day numeric(10,2) NOT NULL,
  currency text NOT NULL DEFAULT 'EUR'
);

CREATE VIEW public.maintenance_due AS
SELECT m.id, v.name AS vessel, m.task, m.due_on, m.estimated_cost
FROM public.vessel_maintenance m
JOIN public.vessels v ON v.id = m.vessel_id
WHERE m.completed_on IS NULL;

CREATE VIEW harbor.voyage_manifest AS
SELECT y.id AS voyage_id, v.name AS vessel, p.name AS destination_port,
  count(c.id)::integer AS cargo_items,
  coalesce(sum(c.weight_kg), 0)::numeric(12,2) AS total_weight_kg
FROM harbor.voyages y
JOIN public.vessels v ON v.id = y.vessel_id
LEFT JOIN harbor.ports p ON p.id = y.port_id
LEFT JOIN harbor.cargo c ON c.voyage_id = y.id
GROUP BY y.id, v.name, p.name;

CREATE FUNCTION harbor.cargo_label(cargo_name text, weight_kg numeric)
RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT cargo_name || ' · ' || weight_kg::text || ' kg' $$;

CREATE FUNCTION harbor.is_heavy_cargo(weight_kg numeric)
RETURNS boolean LANGUAGE sql IMMUTABLE
AS $$ SELECT weight_kg >= 1000 $$;

INSERT INTO public.sailors (handle, home_port) VALUES
  ('brineshell', 'Bergen'), ('tideturner', 'Porto');

INSERT INTO public.vessel_classes (name, max_crew, max_cargo_kg) VALUES
  ('Cutter', 8, 8000), ('Sloop', 5, 3000), ('Freighter', 18, 50000);

INSERT INTO public.vessels (name, captain_id, class_id, launched_on) VALUES
  ('Briny Venture', 4, 1, '2022-06-14'),
  ('Tide Hopper', 5, 2, '2026-01-19');

UPDATE public.vessels SET class_id = CASE id WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3 ELSE class_id END;

INSERT INTO harbor.ports (code, name, region, country) VALUES
  ('LIS', 'Lisbon', 'Atlantic', 'Portugal'),
  ('HEL', 'Heligoland', 'North Sea', 'Germany'),
  ('BGO', 'Bergen', 'North Sea', 'Norway'),
  ('PDL', 'Azores', 'Atlantic', 'Portugal'),
  ('OSL', 'Oslo', 'North Sea', 'Norway');

UPDATE harbor.voyages SET port_id = CASE id WHEN 1 THEN 4 WHEN 2 THEN 2 WHEN 3 THEN 3 END,
  status = CASE id WHEN 1 THEN 'arrived' WHEN 2 THEN 'arrived' ELSE 'planned' END,
  arrived_at = CASE id WHEN 1 THEN '2026-06-06 14:00+00'::timestamptz WHEN 2 THEN '2026-07-16 08:00+00'::timestamptz END;

INSERT INTO harbor.voyages (vessel_id, port_id, destination, status, departed_at) VALUES
  (4, 5, 'Oslo', 'departed', '2026-08-03 10:00+00'),
  (5, 1, 'Lisbon', 'planned', NULL);

INSERT INTO harbor.berths (port_id, code, max_length_m, occupied_by) VALUES
  (1, 'A-1', 80, 5), (2, 'N-2', 45, NULL), (3, 'B-7', 120, 3);

INSERT INTO public.crew_assignments (sailor_id, vessel_id, role, assigned_at) VALUES
  (1, 1, 'captain', '2025-01-01'), (2, 2, 'captain', '2025-04-01'),
  (3, 3, 'captain', '2024-01-01'), (4, 4, 'captain', '2024-08-01');

INSERT INTO public.sailor_certifications (sailor_id, certificate, issued_on, expires_on) VALUES
  (1, 'Navigation', '2024-01-10', '2027-01-10'),
  (2, 'Radio', '2025-05-12', '2028-05-12'),
  (3, 'Cargo safety', '2023-11-02', '2027-11-02');

INSERT INTO public.vessel_maintenance (vessel_id, task, due_on, completed_on, estimated_cost) VALUES
  (1, 'Inspect port engine', '2026-11-15', NULL, 1200),
  (2, 'Replace rigging', '2026-09-01', '2026-08-20', 850),
  (3, 'Check cargo crane', '2026-12-10', NULL, 2400);

INSERT INTO public.provision_orders (vessel_id, supplier, ordered_on, status, total_cost) VALUES
  (1, 'Crab & Compass', '2026-05-20', 'delivered', 620),
  (3, 'North Quay Supply', '2026-07-02', 'pending', 1450);

INSERT INTO harbor.voyage_stops (voyage_id, port_id, stop_order, eta, arrived_at) VALUES
  (1, 1, 1, '2026-06-02 12:00+00', '2026-06-02 13:00+00'),
  (1, 4, 2, '2026-06-06 12:00+00', '2026-06-06 14:00+00'),
  (2, 2, 1, '2026-07-16 08:00+00', '2026-07-16 08:00+00');

INSERT INTO harbor.cargo (voyage_id, description, weight_kg, declared_value, status) VALUES
  (1, 'Coffee beans', 1200, 6800, 'delivered'),
  (1, 'Brass compasses', 180, 5400, 'delivered'),
  (2, 'Salted kelp', 900, 2100, 'delivered'),
  (4, 'Rope coils', 1400, 3200, 'loaded');

INSERT INTO harbor.cargo_events (cargo_id, event_type, happened_at, notes) VALUES
  (1, 'loaded', '2026-06-01 07:00+00', 'Lisbon quay'),
  (1, 'delivered', '2026-06-06 15:00+00', 'Azores warehouse'),
  (4, 'loaded', '2026-08-03 08:00+00', 'Before departure');

INSERT INTO harbor.weather_reports (port_id, observed_at, wind_knots, wave_height_m, conditions) VALUES
  (1, '2026-08-03 08:00+00', 12, 0.8, 'clear'),
  (2, '2026-08-03 08:00+00', 20, 1.5, 'breezy');

INSERT INTO harbor.tide_observations (port_id, observed_at, height_m, phase) VALUES
  (1, '2026-08-03 08:00+00', 2.4, 'rising'),
  (2, '2026-08-03 08:00+00', 1.1, 'falling');

INSERT INTO harbor.port_fees (port_id, vessel_class_id, fee_per_day) VALUES
  (1, 1, 180), (2, 2, 90), (3, 3, 420);

CREATE TYPE harbor.cargo_risk AS ENUM ('low', 'moderate', 'high');
CREATE DOMAIN harbor.positive_weight AS numeric(12,2) CHECK (VALUE > 0);
ALTER TABLE harbor.cargo ADD COLUMN risk harbor.cargo_risk NOT NULL DEFAULT 'low';

CREATE TABLE harbor.cargo_inspections (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cargo_id integer NOT NULL REFERENCES harbor.cargo(id),
  measured_weight harbor.positive_weight NOT NULL,
  inspected_at timestamptz NOT NULL,
  inspector text NOT NULL
);

INSERT INTO harbor.cargo_inspections (cargo_id, measured_weight, inspected_at, inspector) VALUES
  (1, 1201.5, '2026-06-01 07:30+00', 'redclaw'),
  (4, 1398.0, '2026-08-03 08:30+00', 'brineshell');
