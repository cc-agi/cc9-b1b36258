
-- =========================================================
-- 1. Session GUC-guarded 状态机（禁止普通 UPDATE 把终态改回 queued）
-- =========================================================
CREATE OR REPLACE FUNCTION public.enforce_agent_run_transition()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  allow_terminal_reopen BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    BEGIN
      allow_terminal_reopen := current_setting('sentinel.allow_terminal_reopen', true) = 'on';
    EXCEPTION WHEN OTHERS THEN
      allow_terminal_reopen := false;
    END;

    -- succeeded/cancelled 永远不可回退
    IF OLD.status IN ('succeeded','cancelled') THEN
      RAISE EXCEPTION 'invalid_transition: terminal state % cannot change to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    -- failed / blocked → queued 仅允许 SECURITY DEFINER retry RPC
    IF OLD.status IN ('failed','blocked') AND NEW.status = 'queued' AND NOT allow_terminal_reopen THEN
      RAISE EXCEPTION 'invalid_transition: % -> queued must go through retry_agent_run()', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;

    -- 其余合法转换白名单（保留原有）
    IF NOT (
      (OLD.status = 'queued'   AND NEW.status IN ('claimed','cancelled','blocked')) OR
      (OLD.status = 'claimed'  AND NEW.status IN ('running','blocked','cancelled','failed')) OR
      (OLD.status = 'running'  AND NEW.status IN ('succeeded','failed','blocked','cancelled')) OR
      (OLD.status = 'blocked'  AND NEW.status IN ('queued','cancelled')) OR
      (OLD.status = 'failed'   AND NEW.status IN ('queued','cancelled'))
    ) THEN
      RAISE EXCEPTION 'invalid_transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- =========================================================
-- 2. Owner 显式重试 RPC（唯一可让终态回到 queued 的通道）
-- =========================================================
CREATE OR REPLACE FUNCTION public.retry_agent_run(_run_id UUID)
RETURNS public.agent_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  target public.agent_runs;
  next_attempt INT;
  next_seq BIGINT;
BEGIN
  -- 只能重试自己拥有的 run
  SELECT * INTO target FROM public.agent_runs WHERE id = _run_id AND user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found_or_forbidden'; END IF;
  IF target.status NOT IN ('failed','blocked') THEN
    RAISE EXCEPTION 'not_retryable: status=%', target.status;
  END IF;
  next_attempt := COALESCE(target.attempts, 0) + 1;
  IF next_attempt > COALESCE(target.max_attempts, 3) THEN
    RAISE EXCEPTION 'max_attempts_exceeded';
  END IF;

  -- 打开 session GUC，让触发器放行
  PERFORM set_config('sentinel.allow_terminal_reopen', 'on', true);

  UPDATE public.agent_runs
     SET status = 'queued',
         attempts = next_attempt,
         worker_id = NULL,
         started_at = NULL,
         heartbeat_at = NULL,
         lease_expires_at = NULL,
         completed_at = NULL,
         cancel_requested_at = NULL
         -- 保留 last_error / error_code 作为上一轮证据
   WHERE id = _run_id
   RETURNING * INTO target;

  -- 写重试事件
  SELECT COALESCE(MAX(sequence), 0) + 1 INTO next_seq
    FROM public.agent_events WHERE run_id = _run_id;
  INSERT INTO public.agent_events (run_id, user_id, event_type, step_index, sequence, payload)
  VALUES (_run_id, target.user_id, 'run.retry_requested', next_seq, next_seq,
          jsonb_build_object('attempt', next_attempt, 'previous_error_code', target.error_code));

  RETURN target;
END $$;

GRANT EXECUTE ON FUNCTION public.retry_agent_run(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.retry_agent_run(UUID) FROM anon, PUBLIC;

-- =========================================================
-- 3. 步骤意图 / 结果表（Cloud ↔ Worker 之间的白名单 tool call 传递）
-- =========================================================
CREATE TABLE IF NOT EXISTS public.agent_step_intents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL,
  tool_name TEXT NOT NULL,       -- 只能是 Cloud 允许的白名单
  arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivered','executing','completed','failed','cancelled')),
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_step_intents_run_seq_uniq
  ON public.agent_step_intents (run_id, sequence);
CREATE INDEX IF NOT EXISTS agent_step_intents_pending_idx
  ON public.agent_step_intents (run_id, status) WHERE status = 'pending';

GRANT SELECT ON public.agent_step_intents TO authenticated;
GRANT ALL ON public.agent_step_intents TO service_role;
ALTER TABLE public.agent_step_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own step intents read" ON public.agent_step_intents
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.agent_step_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  intent_id UUID NOT NULL REFERENCES public.agent_step_intents(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ok BOOLEAN NOT NULL,
  result JSONB,             -- 已脱敏
  error_code TEXT,
  error_message TEXT,
  latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.agent_step_results TO authenticated;
GRANT ALL ON public.agent_step_results TO service_role;
ALTER TABLE public.agent_step_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own step results read" ON public.agent_step_results
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- =========================================================
-- 4. Worker Token 校验 helper（可选，方便未来 SQL 内查）
-- =========================================================
CREATE OR REPLACE FUNCTION public.verify_worker_token(_hash TEXT)
RETURNS TABLE(user_id UUID, worker_id TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
    SELECT wt.user_id, wt.worker_id FROM public.worker_tokens wt
     WHERE wt.token_hash = _hash AND wt.revoked_at IS NULL
     LIMIT 1;
END $$;
GRANT EXECUTE ON FUNCTION public.verify_worker_token(TEXT) TO service_role;
