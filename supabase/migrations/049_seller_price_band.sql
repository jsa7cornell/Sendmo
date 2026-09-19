-- 049: the seller link's public price band + its refresh sweep.
--
-- PR10 of proposals/2026-08-28_seller-link-launch_reviewed-2026-08-28_decided-2026-08-29.md
-- (§2.3, Option A decided): a stranger on a Marketplace post must see a
-- shipping price BEFORE surrendering their address/phone/email. The band is
-- computed once per link against three representative destination ZIPs —
-- cost bounded by links created, not traffic — and refreshed by a daily
-- sweep (Round-2 amendment: recompute on cron, never on the anonymous GET,
-- which the OG middleware amplifies on every page view).

ALTER TABLE public.sendmo_links
    ADD COLUMN IF NOT EXISTS est_min_cents INTEGER,
    ADD COLUMN IF NOT EXISTS est_max_cents INTEGER,
    ADD COLUMN IF NOT EXISTS est_computed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.sendmo_links.est_min_cents IS
    'Seller-link price band, low end (cents): cheapest displayed option across three representative contiguous-US destinations, computed at creation + refreshed by seller-band-sweep. NULL = not computed (band simply not shown). "Typically" copy — never a quote.';
COMMENT ON COLUMN public.sendmo_links.est_computed_at IS
    'When the band was last computed. The sweep refreshes active seller links older than 14 days.';

-- ── Register the refresh sweep (migration-036 idiom: unschedule-if-exists →
--    schedule; vault-sourced url + service_role_key — the key is seeded by
--    John per 036, never here). 05:30 UTC, after the money sweeps.
DO $unsched$
BEGIN
  PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'seller-band-sweep-daily';
END
$unsched$;

SELECT cron.schedule(
  'seller-band-sweep-daily',
  '30 5 * * *',
  $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/seller-band-sweep',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $cron$
);
