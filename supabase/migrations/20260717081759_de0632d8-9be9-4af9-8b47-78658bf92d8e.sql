CREATE OR REPLACE FUNCTION public.get_sweeper_cron_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
DECLARE
  job_row RECORD;
  runs jsonb;
BEGIN
  SELECT jobid, jobname, schedule, active, command
    INTO job_row
    FROM cron.job
    WHERE jobname = 'sentinel-sweep-stale-runs'
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('job', null, 'runs', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.start_time DESC), '[]'::jsonb)
    INTO runs
  FROM (
    SELECT status, return_message, start_time, end_time
      FROM cron.job_run_details
      WHERE jobid = job_row.jobid
      ORDER BY start_time DESC
      LIMIT 10
  ) t;

  RETURN jsonb_build_object(
    'job', jsonb_build_object(
      'jobid', job_row.jobid,
      'jobname', job_row.jobname,
      'schedule', job_row.schedule,
      'active', job_row.active,
      'command', job_row.command
    ),
    'runs', runs
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_sweeper_cron_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sweeper_cron_status() TO service_role;