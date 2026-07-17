
-- ============================================================
-- 1. Secret 加密存储表
-- ============================================================
CREATE TABLE IF NOT EXISTS public.mcp_connection_secrets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID,
  ciphertext TEXT NOT NULL,           -- AES-256-GCM 加密后的 JSON { url?, headers?, tokens? }
  algo TEXT NOT NULL DEFAULT 'aes-256-gcm',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.mcp_connection_secrets TO service_role;
-- 明确不给 authenticated / anon 任何权限
REVOKE ALL ON public.mcp_connection_secrets FROM authenticated, anon;

ALTER TABLE public.mcp_connection_secrets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON public.mcp_connection_secrets
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 2. mcp_connections: 拆分 base_url / secret_ref / rotation
-- ============================================================
ALTER TABLE public.mcp_connections
  ADD COLUMN IF NOT EXISTS base_url TEXT,
  ADD COLUMN IF NOT EXISTS secret_ref UUID REFERENCES public.mcp_connection_secrets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS has_credentials BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rotation_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

-- 迁移现有 url：剥离 query 中的 secret 参数到加密 blob
-- 这里保守处理：把整个 url 写入加密存储，base_url = origin+path 无 query
DO $$
DECLARE
  r RECORD;
  parsed_base TEXT;
  is_browserbase BOOLEAN;
BEGIN
  FOR r IN SELECT id, user_id, url FROM public.mcp_connections WHERE url IS NOT NULL LOOP
    BEGIN
      -- 简易解析：截断 ? 之前作为 base
      parsed_base := split_part(r.url, '?', 1);
      is_browserbase := r.url ILIKE '%browserbase%';

      -- 有 query（含凭据）
      IF position('?' in r.url) > 0 OR position('@' in split_part(r.url, '://', 2)) > 0 THEN
        UPDATE public.mcp_connections
          SET base_url = parsed_base,
              has_credentials = true,
              rotation_required = COALESCE(is_browserbase, false),
              disabled_reason = CASE WHEN is_browserbase THEN 'CREDENTIAL_ROTATION_REQUIRED' ELSE NULL END,
              state = CASE WHEN is_browserbase THEN 'disabled' ELSE state END
          WHERE id = r.id;
        -- 注意：明文 secret 的加密 blob 需要在应用层通过 backfill 脚本写入
        -- （数据库层没有 aes-gcm 便携实现），此处只做元数据迁移。
      ELSE
        UPDATE public.mcp_connections
          SET base_url = parsed_base,
              has_credentials = false
          WHERE id = r.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.mcp_connections
        SET rotation_required = true,
            disabled_reason = 'MIGRATION_PARSE_FAILED',
            state = 'disabled'
        WHERE id = r.id;
    END;
  END LOOP;
END $$;

-- ============================================================
-- 3. Agent runs 状态机
-- ============================================================
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

-- 先规范化历史 status
UPDATE public.agent_runs SET status = 'blocked' WHERE status NOT IN
  ('queued','claimed','running','succeeded','failed','blocked','cancelled','paused');
UPDATE public.agent_runs SET status = 'blocked' WHERE status = 'paused';

ALTER TABLE public.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('queued','claimed','running','succeeded','failed','blocked','cancelled'));

-- 状态转换触发器
CREATE OR REPLACE FUNCTION public.enforce_agent_run_transition()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- 终态不可回退
    IF OLD.status IN ('succeeded','failed','cancelled') THEN
      RAISE EXCEPTION 'invalid_transition: terminal state % cannot change to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    -- 合法转换白名单
    IF NOT (
      (OLD.status = 'queued'   AND NEW.status IN ('claimed','cancelled','blocked')) OR
      (OLD.status = 'claimed'  AND NEW.status IN ('running','blocked','cancelled','failed')) OR
      (OLD.status = 'running'  AND NEW.status IN ('succeeded','failed','blocked','cancelled')) OR
      (OLD.status = 'blocked'  AND NEW.status IN ('queued','cancelled')) OR   -- 只有显式 retry
      (OLD.status = 'failed'   AND NEW.status IN ('queued','cancelled'))
    ) THEN
      RAISE EXCEPTION 'invalid_transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_agent_run_transition ON public.agent_runs;
CREATE TRIGGER trg_enforce_agent_run_transition
  BEFORE UPDATE ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_run_transition();

-- ============================================================
-- 4. Agent events sequence
-- ============================================================
ALTER TABLE public.agent_events
  ADD COLUMN IF NOT EXISTS sequence BIGINT;

-- 回填 sequence = step_index
UPDATE public.agent_events SET sequence = step_index WHERE sequence IS NULL;
ALTER TABLE public.agent_events ALTER COLUMN sequence SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agent_events_run_seq_uniq
  ON public.agent_events (run_id, sequence);

-- ============================================================
-- 5. Worker 配对与心跳
-- ============================================================
CREATE TABLE IF NOT EXISTS public.worker_pairing_codes (
  code TEXT NOT NULL PRIMARY KEY,      -- 6-8 位随机大写字母数字
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_worker_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.worker_pairing_codes TO authenticated;
GRANT ALL ON public.worker_pairing_codes TO service_role;
ALTER TABLE public.worker_pairing_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pairing codes" ON public.worker_pairing_codes
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.worker_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- sha256(token)
  label TEXT,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, worker_id)
);
GRANT SELECT, UPDATE ON public.worker_tokens TO authenticated;  -- Owner 可查看/撤销自己的
GRANT ALL ON public.worker_tokens TO service_role;
ALTER TABLE public.worker_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own worker tokens" ON public.worker_tokens
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS worker_tokens_hash_idx ON public.worker_tokens(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.worker_heartbeats (
  worker_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version TEXT,
  platform TEXT,
  state TEXT NOT NULL DEFAULT 'idle',   -- idle | working | error | offline
  cdp_reachable BOOLEAN,
  current_run_id UUID,
  last_error_code TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, worker_id)
);
GRANT SELECT ON public.worker_heartbeats TO authenticated;
GRANT ALL ON public.worker_heartbeats TO service_role;
ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own worker heartbeats" ON public.worker_heartbeats
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE INDEX IF NOT EXISTS worker_heartbeats_last_seen ON public.worker_heartbeats(user_id, last_seen_at DESC);

-- ============================================================
-- 6. 原子 claim RPC（SKIP LOCKED）
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_next_agent_run(
  _user_id UUID,
  _worker_id TEXT,
  _lease_seconds INT DEFAULT 120
) RETURNS SETOF public.agent_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
          last_error = NULL
      WHERE id = target_id
      RETURNING *;
END $$;

GRANT EXECUTE ON FUNCTION public.claim_next_agent_run(UUID, TEXT, INT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.claim_next_agent_run(UUID, TEXT, INT) FROM authenticated, anon, PUBLIC;

-- ============================================================
-- 7. 更新 sweep 函数：使用新状态机（blocked 而非无脑重试 running）
-- ============================================================
CREATE OR REPLACE FUNCTION public.sweep_stale_agent_runs()
RETURNS TABLE(swept_id UUID, previous_status TEXT, new_status TEXT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- queued 超过 5 分钟无人认领 -> blocked (WORKER_OFFLINE_TIMEOUT)
  RETURN QUERY
  UPDATE public.agent_runs
     SET status = 'blocked',
         error_code = 'WORKER_OFFLINE_TIMEOUT',
         last_error = 'no_worker_claimed_within_5_minutes',
         updated_at = now()
   WHERE status = 'queued' AND created_at < now() - interval '5 minutes'
  RETURNING id, 'queued'::text, 'blocked'::text, 'no_worker_claimed'::text;

  -- claimed/running 心跳超时 -> blocked (LEASE_EXPIRED_REVIEW_REQUIRED)
  -- 副作用未知，默认不自动重试
  RETURN QUERY
  UPDATE public.agent_runs
     SET status = 'blocked',
         error_code = 'LEASE_EXPIRED_REVIEW_REQUIRED',
         last_error = 'worker_heartbeat_timeout',
         worker_id = NULL,
         lease_expires_at = NULL,
         updated_at = now()
   WHERE status IN ('claimed','running')
     AND (
       (heartbeat_at IS NOT NULL AND heartbeat_at < now() - interval '2 minutes')
       OR (lease_expires_at IS NOT NULL AND lease_expires_at < now())
     )
  RETURNING id, 'running'::text, 'blocked'::text, 'lease_expired'::text;
END $$;
