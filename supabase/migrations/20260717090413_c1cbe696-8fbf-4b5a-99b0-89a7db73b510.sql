-- P0-R3.5: Lock created_at as immutable. Use queued_at for queue-wait timeouts.
--
-- 1) Add queued_at column, backfill from created_at
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;

UPDATE public.agent_runs SET queued_at = created_at WHERE queued_at IS NULL;

ALTER TABLE public.agent_runs
  ALTER COLUMN queued_at SET DEFAULT now(),
  ALTER COLUMN queued_at SET NOT NULL;

-- 2) Trigger: created_at is immutable; auto-maintain queued_at on requeue.
CREATE OR REPLACE FUNCTION public.enforce_agent_run_created_at_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'created_at is immutable' USING ERRCODE = 'check_violation';
    END IF;
    -- Whenever the row enters/returns to 'queued' (retry, repair requeue),
    -- refresh queued_at so queue-wait timers restart from zero. created_at stays.
    IF NEW.status = 'queued' AND OLD.status IS DISTINCT FROM 'queued' THEN
      NEW.queued_at := now();
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_agent_runs_created_at_immutable ON public.agent_runs;
CREATE TRIGGER trg_agent_runs_created_at_immutable
  BEFORE UPDATE ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_run_created_at_immutable();

-- 3) Rewrite sweep_stale_agent_runs to use queued_at (not created_at) for the
--    WORKER_OFFLINE_TIMEOUT check. running/claimed timeout logic is unchanged
--    and still relies only on lease_expires_at / heartbeat_at / worker_id / status.
CREATE OR REPLACE FUNCTION public.sweep_stale_agent_runs()
 RETURNS TABLE(swept_id uuid, previous_status text, new_status text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ACCEPT_PREFIX CONSTANT text := '[SENTINEL_ACCEPTANCE_LAB]';
BEGIN
  -- 1) Queued runs no Worker claimed within 5 min of being queued.
  --    Uses queued_at (reset on retry/repair), NOT created_at (immutable).
  RETURN QUERY
  UPDATE public.agent_runs
     SET status = 'blocked',
         error_code = 'WORKER_OFFLINE_TIMEOUT',
         last_error = 'no_worker_claimed_within_5_minutes',
         updated_at = now()
   WHERE status = 'queued' AND queued_at < now() - interval '5 minutes'
  RETURNING id, 'queued'::text, 'blocked'::text, 'no_worker_claimed'::text;

  -- 2) LEASE_EXPIRED transitions (unchanged; capture pre-update worker/heartbeat).
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

  -- 3) No-progress timeout (unchanged).
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

-- 4) retry_agent_run: keep created_at as-is; trigger auto-refreshes queued_at.
CREATE OR REPLACE FUNCTION public.retry_agent_run(_run_id uuid)
 RETURNS agent_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.agent_runs;
  next_attempt INT;
  next_seq BIGINT;
BEGIN
  SELECT * INTO target FROM public.agent_runs WHERE id = _run_id AND user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_forbidden'; END IF;
  IF target.status NOT IN ('failed','blocked','timed_out') THEN
    RAISE EXCEPTION 'not_retryable: status=%', target.status;
  END IF;
  next_attempt := COALESCE(target.attempts, 0) + 1;
  IF next_attempt > COALESCE(target.max_attempts, 3) THEN
    RAISE EXCEPTION 'max_attempts_exceeded';
  END IF;

  PERFORM set_config('sentinel.allow_terminal_reopen', 'on', true);

  UPDATE public.agent_runs
     SET status = 'queued',
         attempts = next_attempt,
         worker_id = NULL,
         started_at = NULL,
         heartbeat_at = NULL,
         lease_expires_at = NULL,
         completed_at = NULL,
         timed_out_at = NULL,
         cancel_requested_at = NULL
         -- created_at intentionally left untouched; queued_at is refreshed by trigger.
   WHERE id = _run_id
   RETURNING * INTO target;

  SELECT COALESCE(MAX(sequence), 0) + 1 INTO next_seq
    FROM public.agent_events WHERE run_id = _run_id;
  INSERT INTO public.agent_events (run_id, user_id, event_type, step_index, sequence, payload)
  VALUES (_run_id, target.user_id, 'run.retry_requested', next_seq, next_seq,
          jsonb_build_object('attempt', next_attempt, 'previous_error_code', target.error_code));

  RETURN target;
END $function$;

-- 5) Order queue by queued_at so requeued runs go to the back of the line.
CREATE OR REPLACE FUNCTION public.claim_next_agent_run(_user_id uuid, _worker_id text, _lease_seconds integer DEFAULT 120)
 RETURNS SETOF agent_runs
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
    ORDER BY queued_at
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
          attempts = GREATEST(COALESCE(attempts, 0), 1),
          last_error = NULL
      WHERE id = target_id
      RETURNING *;
END $function$;
