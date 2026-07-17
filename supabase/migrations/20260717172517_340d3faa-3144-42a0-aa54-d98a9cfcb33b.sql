ALTER TABLE public.worker_heartbeats
  ADD COLUMN IF NOT EXISTS desktop_session_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS desktop_session_id text;