-- 046: DB-backed fixed-window rate limiter for the MONEY paths.
--
-- PR2 of proposals/2026-08-28_seller-link-launch_reviewed-2026-08-28_decided-2026-08-29.md.
-- The in-memory limiter (_shared/ratelimit.ts) is per-isolate by its own
-- admission — concurrent requests land in separate empty maps and all pass —
-- which is fine as a speed bump on quote endpoints but not on paths that
-- move money or spend EasyPost quota per call (labels flex confirm,
-- seller-checkout). This table + RPC give those paths one shared counter.
--
-- Fixed-window on purpose (not sliding): one upsert round-trip per check,
-- and the worst-case burst at a window boundary is 2×max — acceptable for
-- abuse control, not for billing.
--
-- Cleanup, two layers (review PR2-#2): each call reclaims ITS key's stale
-- windows (bounded, hot keys stay tidy), and ~1% of calls run a global sweep
-- of rows older than an hour — so keys seen once (one-off viewer IPs) don't
-- accumulate forever. No cron needed at these volumes; register one if the
-- sweep ever shows up in latency.

CREATE TABLE IF NOT EXISTS public.rate_limit_windows (
    key TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (key, window_start)
);

-- No client access of any kind: the table exists only for the RPC below,
-- called by edge functions under the service role.
ALTER TABLE public.rate_limit_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_windows FROM anon;
REVOKE ALL ON public.rate_limit_windows FROM authenticated;

-- Returns TRUE when the call identified by p_key should be REJECTED (i.e. it
-- is request number p_max+1 or later within the current fixed window).
-- Counts rejected requests too — a rejected caller keeps its window full.
CREATE OR REPLACE FUNCTION public.rate_limit_hit(
    p_key TEXT,
    p_window_seconds INTEGER,
    p_max INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_window_start TIMESTAMPTZ := to_timestamp(
        floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds
    );
    v_count INTEGER;
BEGIN
    -- Opportunistic per-key cleanup: bounded (touches only this key's rows),
    -- keeps hot keys from accumulating one row per window forever.
    DELETE FROM rate_limit_windows
    WHERE key = p_key
      AND window_start < v_window_start - make_interval(secs => p_window_seconds);

    -- Probabilistic global sweep: keys seen once (one-off viewer IPs) are
    -- never revisited by the per-key delete, so ~1% of calls reclaim
    -- everything older than an hour. Cheap at these volumes; the primary key
    -- makes it an index range scan.
    IF random() < 0.01 THEN
        DELETE FROM rate_limit_windows
        WHERE window_start < now() - interval '1 hour';
    END IF;

    INSERT INTO rate_limit_windows AS r (key, window_start, count)
    VALUES (p_key, v_window_start, 1)
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = r.count + 1
    RETURNING count INTO v_count;

    RETURN v_count > p_max;
END
$$;

-- Grants per the migration-044 contract: REVOKE FROM PUBLIC is not enough —
-- name anon and authenticated explicitly; service_role is the only caller.
REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER) TO service_role;
