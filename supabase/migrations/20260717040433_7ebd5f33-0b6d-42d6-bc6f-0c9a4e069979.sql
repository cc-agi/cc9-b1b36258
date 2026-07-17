ALTER TABLE public.worker_heartbeats
  ADD COLUMN IF NOT EXISTS computer_name text,
  ADD COLUMN IF NOT EXISTS chrome_version text;

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS timed_out_at timestamptz;

CREATE OR REPLACE FUNCTION public.enforce_agent_run_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  allow_terminal_reopen BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    BEGIN
      allow_terminal_reopen := current_setting('sentinel.allow_terminal_reopen', true) = 'on';
    EXCEPTION WHEN OTHERS THEN
      allow_terminal_reopen := false;
    END;

    IF OLD.status IN ('succeeded','cancelled') THEN
      RAISE EXCEPTION 'invalid_transition: terminal state % cannot change to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.status IN ('failed','blocked','timed_out') AND NEW.status = 'queued' AND NOT allow_terminal_reopen THEN
      RAISE EXCEPTION 'invalid_transition: % -> queued must go through retry_agent_run()', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT (
      (OLD.status = 'queued'    AND NEW.status IN ('claimed','cancelled','blocked','timed_out')) OR
      (OLD.status = 'claimed'   AND NEW.status IN ('running','blocked','cancelled','failed','timed_out')) OR
      (OLD.status = 'running'   AND NEW.status IN ('succeeded','failed','blocked','cancelled','timed_out')) OR
      (OLD.status = 'blocked'   AND NEW.status IN ('queued','cancelled','timed_out')) OR
      (OLD.status = 'failed'    AND NEW.status IN ('queued','cancelled','timed_out')) OR
      (OLD.status = 'timed_out' AND NEW.status IN ('queued','cancelled'))
    ) THEN
      RAISE EXCEPTION 'invalid_transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

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
   WHERE id = _run_id
   RETURNING * INTO target;

  SELECT COALESCE(MAX(sequence), 0) + 1 INTO next_seq
    FROM public.agent_events WHERE run_id = _run_id;
  INSERT INTO public.agent_events (run_id, user_id, event_type, step_index, sequence, payload)
  VALUES (_run_id, target.user_id, 'run.retry_requested', next_seq, next_seq,
          jsonb_build_object('attempt', next_attempt, 'previous_error_code', target.error_code));

  RETURN target;
END $function$;

CREATE OR REPLACE FUNCTION public.sweep_stale_agent_runs()
 RETURNS TABLE(swept_id uuid, previous_status text, new_status text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  UPDATE public.agent_runs
     SET status = 'blocked',
         error_code = 'WORKER_OFFLINE_TIMEOUT',
         last_error = 'no_worker_claimed_within_5_minutes',
         updated_at = now()
   WHERE status = 'queued' AND created_at < now() - interval '5 minutes'
  RETURNING id, 'queued'::text, 'blocked'::text, 'no_worker_claimed'::text;

  RETURN QUERY
  UPDATE public.agent_runs
     SET status = 'timed_out',
         error_code = 'LEASE_EXPIRED',
         last_error = 'worker_heartbeat_or_lease_timeout',
         worker_id = NULL,
         lease_expires_at = NULL,
         timed_out_at = now(),
         completed_at = now(),
         updated_at = now()
   WHERE status IN ('claimed','running')
     AND (
       (heartbeat_at IS NOT NULL AND heartbeat_at < now() - interval '2 minutes')
       OR (lease_expires_at IS NOT NULL AND lease_expires_at < now())
     )
  RETURNING id, 'running'::text, 'timed_out'::text, 'lease_expired'::text;

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