
-- 1) Backfill attempt for any legacy rows (safety)
UPDATE public.agent_step_intents SET attempt = 1 WHERE attempt IS NULL OR attempt = 0;
ALTER TABLE public.agent_step_intents ALTER COLUMN attempt SET NOT NULL;
ALTER TABLE public.agent_step_intents ALTER COLUMN attempt SET DEFAULT 1;

-- 2) Drop the old (run_id, sequence) unique index; multi-attempt uses (run_id, attempt, sequence)
DROP INDEX IF EXISTS public.agent_step_intents_run_seq_uniq;

-- 3) Owner-only targeted repair of Run 4267089a: blocked -> queued, keep attempts=2, preserve attempt-1 evidence
DO $$
DECLARE
  target_id uuid;
  target_user uuid;
  next_seq bigint;
BEGIN
  SELECT id, user_id INTO target_id, target_user
    FROM public.agent_runs
    WHERE id::text LIKE '4267089a%' AND status = 'blocked'
    LIMIT 1;
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
         updated_at = now()
   WHERE id = target_id;

  SELECT COALESCE(MAX(sequence), 0) + 1 INTO next_seq
    FROM public.agent_events WHERE run_id = target_id;

  INSERT INTO public.agent_events (run_id, user_id, event_type, step_index, sequence, payload)
  VALUES (target_id, target_user, 'run.repair_requeued', next_seq, next_seq,
          jsonb_build_object(
            'previous_status', 'blocked',
            'previous_error', 'INTENT_INSERT_FAILED',
            'attempt', 2,
            'repaired_at', now(),
            'reason', 'dropped_stale_run_seq_uniq_constraint'
          ));
END $$;
