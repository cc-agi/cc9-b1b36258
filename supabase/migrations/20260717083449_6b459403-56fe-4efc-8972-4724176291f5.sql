
DO $$
DECLARE
  target_id uuid;
BEGIN
  SELECT id INTO target_id FROM public.agent_runs
    WHERE id::text LIKE '4267089a%' AND status = 'blocked' LIMIT 1;
  IF target_id IS NULL THEN RETURN; END IF;

  PERFORM set_config('sentinel.allow_terminal_reopen', 'on', true);

  UPDATE public.agent_runs
     SET status = 'queued',
         error_code = NULL,
         last_error = NULL,
         completed_at = NULL,
         worker_id = NULL,
         heartbeat_at = NULL,
         lease_expires_at = NULL,
         timed_out_at = NULL,
         cancel_requested_at = NULL,
         started_at = NULL,
         created_at = now(),
         updated_at = now()
   WHERE id = target_id;
END $$;
