
CREATE OR REPLACE FUNCTION public.claim_next_agent_run(_user_id uuid, _worker_id text, _lease_seconds integer DEFAULT 120)
 RETURNS SETOF public.agent_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target_id UUID;
  lease_expiry TIMESTAMPTZ := now() + make_interval(secs => _lease_seconds);
BEGIN
  SELECT id INTO target_id
    FROM public.agent_runs
    WHERE user_id = _user_id AND status = 'queued'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

  IF target_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    UPDATE public.agent_runs
      SET status = 'claimed',
          worker_id = _worker_id,
          started_at = now(),
          heartbeat_at = now(),
          lease_expires_at = lease_expiry,
          -- P0-R3.3: first execution must be attempt >= 1. Retry sets attempts
          -- explicitly (2, 3, ...) so we only bump the initial 0 -> 1 case.
          attempts = GREATEST(COALESCE(attempts, 0), 1),
          last_error = NULL
      WHERE id = target_id
      RETURNING *;
END $function$;

-- P0-R3.3: Active-run lease renewal, called from Worker heartbeat.
-- Extends heartbeat_at + lease_expires_at only when the caller is the
-- current lease holder and the run is still active. Any other Worker
-- attempting to renew a run they do not hold gets a NULL row and MUST
-- treat this as "lease lost" and abandon execution.
CREATE OR REPLACE FUNCTION public.renew_agent_run_lease(
  _run_id uuid,
  _user_id uuid,
  _worker_id text,
  _lease_seconds integer DEFAULT 120
)
 RETURNS public.agent_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r public.agent_runs;
  lease_expiry TIMESTAMPTZ;
BEGIN
  IF _lease_seconds IS NULL OR _lease_seconds < 30 OR _lease_seconds > 1800 THEN
    RAISE EXCEPTION 'invalid_lease_seconds' USING ERRCODE = 'check_violation';
  END IF;
  lease_expiry := now() + make_interval(secs => _lease_seconds);

  UPDATE public.agent_runs
     SET heartbeat_at = now(),
         lease_expires_at = lease_expiry
   WHERE id = _run_id
     AND user_id = _user_id
     AND worker_id = _worker_id
     AND status IN ('claimed','running')
   RETURNING * INTO r;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lease_not_held' USING ERRCODE = 'check_violation';
  END IF;
  RETURN r;
END $function$;
