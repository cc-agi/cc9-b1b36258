
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE INDEX IF NOT EXISTS idx_agent_runs_status_time
  ON public.agent_runs (status, updated_at DESC);

CREATE OR REPLACE FUNCTION public.sweep_stale_agent_runs()
RETURNS TABLE(swept_id uuid, previous_status text, new_status text, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- queued 超过 5 分钟无人认领 → failed
  RETURN QUERY
  UPDATE public.agent_runs
     SET status = 'failed',
         last_error = 'no_worker_claimed_within_lease',
         completed_at = now(),
         updated_at = now()
   WHERE status = 'queued'
     AND created_at < now() - interval '5 minutes'
  RETURNING id, 'queued'::text, 'failed'::text, 'no_worker_claimed_within_lease'::text;

  -- running 心跳超时：若还有重试机会，重回 queued；否则 failed
  RETURN QUERY
  WITH stale AS (
    SELECT id, attempts, max_attempts
      FROM public.agent_runs
     WHERE status = 'running'
       AND (
            (heartbeat_at IS NOT NULL AND heartbeat_at < now() - interval '2 minutes')
         OR (heartbeat_at IS NULL AND started_at IS NOT NULL AND started_at < now() - interval '2 minutes')
         OR (lease_expires_at IS NOT NULL AND lease_expires_at < now())
       )
  ),
  retryable AS (
    UPDATE public.agent_runs r
       SET status = 'queued',
           worker_id = NULL,
           heartbeat_at = NULL,
           lease_expires_at = NULL,
           started_at = NULL,
           attempts = r.attempts + 1,
           last_error = 'worker_heartbeat_timeout (retry)',
           updated_at = now()
      FROM stale
     WHERE r.id = stale.id
       AND stale.attempts + 1 < stale.max_attempts
    RETURNING r.id, 'running'::text AS prev, 'queued'::text AS newst, 'worker_heartbeat_timeout_retry'::text AS reason
  ),
  exhausted AS (
    UPDATE public.agent_runs r
       SET status = 'failed',
           last_error = 'worker_heartbeat_timeout',
           attempts = r.attempts + 1,
           completed_at = now(),
           updated_at = now()
      FROM stale
     WHERE r.id = stale.id
       AND stale.attempts + 1 >= stale.max_attempts
    RETURNING r.id, 'running'::text AS prev, 'failed'::text AS newst, 'worker_heartbeat_timeout'::text AS reason
  )
  SELECT id, prev, newst, reason FROM retryable
  UNION ALL
  SELECT id, prev, newst, reason FROM exhausted;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_stale_agent_runs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sweep_stale_agent_runs() TO authenticated, service_role;
