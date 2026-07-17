
-- Pairing hash
ALTER TABLE public.worker_pairing_codes
  ADD COLUMN IF NOT EXISTS code_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS worker_pairing_codes_hash_uniq
  ON public.worker_pairing_codes (code_hash) WHERE code_hash IS NOT NULL;

-- Pair attempts bucket
CREATE TABLE IF NOT EXISTS public.worker_pair_attempts (
  ip TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  failures INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  PRIMARY KEY (ip)
);
GRANT ALL ON public.worker_pair_attempts TO service_role;
ALTER TABLE public.worker_pair_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "worker_pair_attempts service only"
  ON public.worker_pair_attempts FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Worker token expiry
ALTER TABLE public.worker_tokens
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days');

CREATE OR REPLACE FUNCTION public.verify_worker_token(_hash TEXT)
RETURNS TABLE(user_id UUID, worker_id TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
    SELECT wt.user_id, wt.worker_id FROM public.worker_tokens wt
     WHERE wt.token_hash = _hash
       AND wt.revoked_at IS NULL
       AND (wt.expires_at IS NULL OR wt.expires_at > now())
     LIMIT 1;
END $$;
GRANT EXECUTE ON FUNCTION public.verify_worker_token(TEXT) TO service_role;

-- Intent/result idempotency
ALTER TABLE public.agent_step_intents
  ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS lease_version INT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS agent_step_intents_run_attempt_seq_uniq
  ON public.agent_step_intents (run_id, attempt, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS agent_step_intents_run_idem_uniq
  ON public.agent_step_intents (run_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.agent_step_results
  ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS agent_step_results_intent_uniq
  ON public.agent_step_results (intent_id);

-- Runtime config
CREATE TABLE IF NOT EXISTS public.runtime_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.runtime_config TO authenticated, service_role;
GRANT ALL ON public.runtime_config TO service_role;
ALTER TABLE public.runtime_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "runtime_config readable" ON public.runtime_config
  FOR SELECT TO authenticated, service_role USING (true);
INSERT INTO public.runtime_config (key, value) VALUES
  ('min_helper_version', '"0.3.0"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Owner-request cancel
CREATE OR REPLACE FUNCTION public.request_cancel_agent_run(_run_id UUID)
RETURNS public.agent_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.agent_runs;
BEGIN
  UPDATE public.agent_runs
     SET cancel_requested_at = now(), updated_at = now()
   WHERE id = _run_id AND user_id = auth.uid()
     AND status IN ('queued','claimed','running','blocked')
   RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_terminal'; END IF;
  RETURN r;
END $$;
GRANT EXECUTE ON FUNCTION public.request_cancel_agent_run(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.request_cancel_agent_run(UUID) FROM anon, PUBLIC;
