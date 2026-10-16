-- Verbatim copy of firstsun-dev/windmill-flows db/migrations/20260904003000_blog_analytics_clarity.sql (test fixture only).
-- Microsoft Clarity Data Export API is an aggregate, rolling-window API.
-- Keep each API response immutable in clarity_fetch_runs and derive rows from
-- that source of truth, rather than treating this schema as a session store.

CREATE SCHEMA blog_analytics;

CREATE TABLE blog_analytics.clarity_query_definitions (
    query_key  TEXT PRIMARY KEY,
    dimensions TEXT[] NOT NULL,
    num_days   SMALLINT NOT NULL DEFAULT 1 CHECK (num_days BETWEEN 1 AND 3),
    priority   SMALLINT NOT NULL,
    enabled    BOOLEAN NOT NULL DEFAULT true,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (cardinality(dimensions) <= 3)
);

CREATE TABLE blog_analytics.clarity_fetch_runs (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_key         TEXT NOT NULL,
    query_key           TEXT NOT NULL REFERENCES blog_analytics.clarity_query_definitions (query_key),
    scheduled_at        TIMESTAMPTZ NOT NULL,
    fetched_at          TIMESTAMPTZ,
    num_days            SMALLINT NOT NULL CHECK (num_days BETWEEN 1 AND 3),
    window_start_at     TIMESTAMPTZ,
    window_end_at       TIMESTAMPTZ,
    logical_date        DATE NOT NULL,
    attempt_no          SMALLINT NOT NULL CHECK (attempt_no > 0),
    http_status         INTEGER,
    status              TEXT NOT NULL CHECK (status IN (
        'pending', 'success', 'partial', 'truncated', 'fetch_failed',
        'normalize_failed', 'auth_failed', 'rate_limited'
    )),
    metric_count        INTEGER,
    row_count           INTEGER,
    truncated_suspected BOOLEAN NOT NULL DEFAULT false,
    duration_ms         INTEGER,
    response_sha256     TEXT,
    raw_payload         JSONB,
    error_code          TEXT,
    error_message       TEXT,
    normalizer_version  INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((window_start_at IS NULL) = (window_end_at IS NULL)),
    CHECK (response_sha256 IS NULL OR raw_payload IS NOT NULL)
);

CREATE INDEX idx_clarity_fetch_runs_project_logical_date
    ON blog_analytics.clarity_fetch_runs (project_key, logical_date DESC);

CREATE TABLE blog_analytics.clarity_metric_rows (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fetch_run_id       BIGINT NOT NULL REFERENCES blog_analytics.clarity_fetch_runs (id) ON DELETE CASCADE,
    project_key        TEXT NOT NULL,
    query_key          TEXT NOT NULL,
    logical_date       DATE NOT NULL,
    metric_name        TEXT NOT NULL,
    browser            TEXT,
    device             TEXT,
    country_region     TEXT,
    os                 TEXT,
    source             TEXT,
    medium             TEXT,
    campaign           TEXT,
    channel            TEXT,
    url_raw            TEXT,
    url_normalized     TEXT,
    query_class        TEXT,
    dimension_hash     TEXT NOT NULL,
    row_hash           TEXT NOT NULL,
    metric_values      JSONB NOT NULL,
    normalizer_version INTEGER NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (fetch_run_id, metric_name, dimension_hash, row_hash)
);

CREATE INDEX idx_clarity_metric_rows_logical_date
    ON blog_analytics.clarity_metric_rows (logical_date DESC);
CREATE INDEX idx_clarity_metric_rows_query_logical_date
    ON blog_analytics.clarity_metric_rows (query_key, logical_date DESC);
CREATE INDEX idx_clarity_metric_rows_url_logical_date
    ON blog_analytics.clarity_metric_rows (url_normalized, logical_date DESC);
CREATE INDEX idx_clarity_metric_rows_source_medium_logical_date
    ON blog_analytics.clarity_metric_rows (source, medium, logical_date DESC);
CREATE INDEX idx_clarity_metric_rows_fetch_run
    ON blog_analytics.clarity_metric_rows (fetch_run_id);

INSERT INTO blog_analytics.clarity_query_definitions (query_key, dimensions, priority, description)
VALUES
    ('site_overall', ARRAY[]::TEXT[], 1, 'Whole-site aggregate baseline'),
    ('page', ARRAY['URL'], 2, 'Page-level analytics'),
    ('page_device', ARRAY['URL', 'Device'], 3, 'Page analytics by device'),
    ('acquisition', ARRAY['Source', 'Medium', 'Channel'], 4, 'Acquisition breakdown'),
    ('technology', ARRAY['Device', 'OS', 'Browser'], 5, 'Technology breakdown'),
    ('geo_device', ARRAY['Country/Region', 'Device'], 6, 'Geographic/device breakdown'),
    ('page_source', ARRAY['URL', 'Source'], 7, 'Page acquisition breakdown');
