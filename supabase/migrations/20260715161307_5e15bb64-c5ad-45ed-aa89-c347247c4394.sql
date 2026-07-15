ALTER TABLE public.imported_resources
  ADD COLUMN IF NOT EXISTS version text,
  ADD COLUMN IF NOT EXISTS synced_at timestamptz;