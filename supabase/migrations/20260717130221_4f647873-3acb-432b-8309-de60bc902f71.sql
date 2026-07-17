
-- 1) Restrict runtime_config SELECT to Sentinel Owner + service_role only.
DROP POLICY IF EXISTS "runtime_config readable" ON public.runtime_config;
CREATE POLICY "runtime_config owner or service read"
  ON public.runtime_config
  FOR SELECT
  TO authenticated, service_role
  USING (
    (auth.jwt() ->> 'email') = 'aosenbearing@gmail.com'
  );

-- 2) Rewrite Owner-only SECURITY DEFINER helpers so signed-in users cannot
--    execute them directly. Callers pass their user id explicitly and the
--    app only reaches them via service_role.

CREATE OR REPLACE FUNCTION public.request_cancel_agent_run(_run_id uuid, _actor_user_id uuid)
 RETURNS public.agent_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.agent_runs;
BEGIN
  IF _actor_user_id IS NULL THEN RAISE EXCEPTION 'missing_actor'; END IF;
  UPDATE public.agent_runs
     SET cancel_requested_at = now(), updated_at = now()
   WHERE id = _run_id AND user_id = _actor_user_id
     AND status IN ('queued','claimed','running','blocked')
   RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_terminal'; END IF;
  RETURN r;
END $function$;

-- Drop the old single-arg overload if present.
DROP FUNCTION IF EXISTS public.request_cancel_agent_run(uuid);

REVOKE ALL ON FUNCTION public.request_cancel_agent_run(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_cancel_agent_run(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.retry_agent_run(_run_id uuid, _actor_user_id uuid)
 RETURNS public.agent_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.agent_runs;
  next_attempt INT;
  next_seq BIGINT;
BEGIN
  IF _actor_user_id IS NULL THEN RAISE EXCEPTION 'missing_actor'; END IF;
  SELECT * INTO target FROM public.agent_runs WHERE id = _run_id AND user_id = _actor_user_id;
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

DROP FUNCTION IF EXISTS public.retry_agent_run(uuid);

REVOKE ALL ON FUNCTION public.retry_agent_run(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_agent_run(uuid, uuid) TO service_role;
