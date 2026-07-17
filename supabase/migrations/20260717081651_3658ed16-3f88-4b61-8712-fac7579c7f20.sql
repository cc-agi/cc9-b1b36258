ALTER TABLE public.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE public.agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status = ANY (ARRAY['queued','claimed','running','succeeded','failed','blocked','cancelled','timed_out']));