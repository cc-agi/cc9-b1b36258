CREATE OR REPLACE FUNCTION public.sweep_stale_agent_runs()
 RETURNS TABLE(swept_id uuid, previous_status text, new_status text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ACCEPT_PREFIX CONSTANT text := '[SENTINEL_ACCEPTANCE_LAB]';
BEGIN
  -- 1) Queued runs that no Worker ever claimed -> blocked
  RETURN QUERY
  UPDATE public.agent_runs
     SET status = 'blocked',
         error_code = 'WORKER_OFFLINE_TIMEOUT',
         last_error = 'no_worker_claimed_within_5_minutes',
         updated_at = now()
   WHERE status = 'queued' AND created_at < now() - interval '5 minutes'
  RETURNING id, 'queued'::text, 'blocked'::text, 'no_worker_claimed'::text;

  -- 2) LEASE_EXPIRED transitions. Capture pre-update worker/heartbeat so
  --    persisted events retain that evidence after worker_id is nulled.
  CREATE TEMP TABLE IF NOT EXISTS _sweep_lease(
    run_id uuid, user_id uuid, goal text, worker_id text,
    heartbeat_at timestamptz, lease_expires_at timestamptz, attempt int
  ) ON COMMIT DROP;
  TRUNCATE _sweep_lease;

  INSERT INTO _sweep_lease
  SELECT id, user_id, goal, worker_id, heartbeat_at, lease_expires_at, COALESCE(attempts, 1)
    FROM public.agent_runs
   WHERE status IN ('claimed','running')
     AND (
       (heartbeat_at IS NOT NULL AND heartbeat_at < now() - interval '2 minutes')
       OR (lease_expires_at IS NOT NULL AND lease_expires_at < now())
     );

  IF EXISTS (SELECT 1 FROM _sweep_lease) THEN
    -- run.timed_out event (lab runs only, to keep noise low)
    INSERT INTO public.agent_events (run_id, user_id, event_type, step_index, sequence, payload)
    SELECT s.run_id, s.user_id, 'run.timed_out', b.base + 1, b.base + 1,
           jsonb_build_object(
             'attempt', s.attempt,
             'worker_id', s.worker_id,
             'error_code', 'LEASE_EXPIRED',
             'lease_expires_at', s.lease_expires_at,
             'heartbeat_at', s.heartbeat_at,
             'timed_out_at', now()
           )
      FROM _sweep_lease s
      CROSS JOIN LATERAL (
        SELECT COALESCE(MAX(sequence), 0) AS base
          FROM public.agent_events WHERE run_id = s.run_id
      ) b
     WHERE s.goal LIKE (ACCEPT_PREFIX || '%');

    -- acceptance.helper_offline_verified event (lab runs only)
    INSERT INTO public.agent_events (run_id, user_id, event_type, step_index, sequence, payload)
    SELECT s.run_id, s.user_id, 'acceptance.helper_offline_verified', b.base + 1, b.base + 1,
           jsonb_build_object(
             'attempt', s.attempt,
             'worker_id', s.worker_id,
             'last_heartbeat_at', s.heartbeat_at,
             'offline_detected_at', now()
           )
      FROM _sweep_lease s
      CROSS JOIN LATERAL (
        SELECT COALESCE(MAX(sequence), 0) AS base
          FROM public.agent_events WHERE run_id = s.run_id
      ) b
     WHERE s.goal LIKE (ACCEPT_PREFIX || '%');

    RETURN QUERY
    UPDATE public.agent_runs r
       SET status = 'timed_out',
           error_code = 'LEASE_EXPIRED',
           last_error = 'worker_heartbeat_or_lease_timeout',
           worker_id = NULL,
           lease_expires_at = NULL,
           timed_out_at = now(),
           completed_at = now(),
           updated_at = now()
      FROM _sweep_lease s
     WHERE r.id = s.run_id
    RETURNING r.id, 'running'::text, 'timed_out'::text, 'lease_expired'::text;
  END IF;

  -- 3) No-progress timeout (unchanged semantics)
  RETURN QUERY
  UPDATE public.agent_runs r
     SET status = 'timed_out',
         error_code = 'NO_PROGRESS_TIMEOUT',
         last_error = 'no_agent_event_in_3_minutes',
         worker_id = NULL,
         lease_expires_at = NULL,
         timed_out_at = now(),
         completed_at = now(),
         updated_at = now()
   WHERE r.status = 'running'
     AND r.started_at IS NOT NULL
     AND r.started_at < now() - interval '3 minutes'
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_events e
        WHERE e.run_id = r.id AND e.created_at > now() - interval '3 minutes'
     )
  RETURNING r.id, 'running'::text, 'timed_out'::text, 'no_progress'::text;
END $function$;