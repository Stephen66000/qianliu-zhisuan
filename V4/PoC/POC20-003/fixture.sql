BEGIN;

INSERT INTO enterprise(id, name) VALUES
  ('63000000-0000-4000-8000-000000000001', '时区企业 A'),
  ('63000000-0000-4000-8000-000000000002', '时区企业 B');

INSERT INTO operating_bill_period(
  id, enterprise_id, period_month, status, current_version,
  timezone, period_start, period_end, created_at, updated_at
) VALUES
  (
    '63000000-0000-4000-8000-000000000101',
    '63000000-0000-4000-8000-000000000001',
    '2026-05-01', 'DRAFT', 0, 'Asia/Shanghai',
    '2026-05-01 00:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai',
    '2026-06-01 00:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai',
    '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'
  ),
  (
    '63000000-0000-4000-8000-000000000102',
    '63000000-0000-4000-8000-000000000001',
    '2026-06-01', 'DRAFT', 0, 'Asia/Shanghai',
    '2026-06-01 00:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai',
    '2026-07-01 00:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai',
    '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'
  ),
  (
    '63000000-0000-4000-8000-000000000103',
    '63000000-0000-4000-8000-000000000001',
    '2026-09-01', 'DRAFT', 0, 'Asia/Shanghai',
    '2026-09-01 00:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai',
    '2026-10-01 00:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai',
    '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
  ),
  (
    '63000000-0000-4000-8000-000000000104',
    '63000000-0000-4000-8000-000000000001',
    '2026-10-01', 'DRAFT', 0, 'Asia/Shanghai',
    '2026-10-01 00:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai',
    '2026-11-01 00:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai',
    '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'
  ),
  (
    '63000000-0000-4000-8000-000000000105',
    '63000000-0000-4000-8000-000000000001',
    '2026-08-01', 'DRAFT', 0, 'Asia/Shanghai',
    '2026-08-01 00:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai',
    '2026-09-01 00:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai',
    '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
  ),
  (
    '63000000-0000-4000-8000-000000000201',
    '63000000-0000-4000-8000-000000000002',
    '2026-07-01', 'DRAFT', 0, 'America/Los_Angeles',
    '2026-07-01 00:00:00'::timestamp AT TIME ZONE 'America/Los_Angeles',
    '2026-08-01 00:00:00'::timestamp AT TIME ZONE 'America/Los_Angeles',
    '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
  );

COMMIT;
