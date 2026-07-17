-- P0-R3.2: Independent Cloud Sweeper — pg_cron every 1 min
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- The sweep function is SECURITY DEFINER; cron runs as postgres which owns it.
GRANT EXECUTE ON FUNCTION public.sweep_stale_agent_runs() TO postgres;

-- Unschedule any previous copy to keep this migration idempotent.
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid, jobname FROM cron.job WHERE jobname = 'sentinel-sweep-stale-runs' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'sentinel-sweep-stale-runs',
  '* * * * *',
  $cron$ SELECT public.sweep_stale_agent_runs(); $cron$
);