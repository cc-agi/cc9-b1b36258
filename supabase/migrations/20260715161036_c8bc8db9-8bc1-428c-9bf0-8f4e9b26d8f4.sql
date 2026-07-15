CREATE TABLE public.imported_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'cc6',
  source_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mcp','plugin','skill')),
  name text NOT NULL,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, kind, source_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.imported_resources TO authenticated;
GRANT ALL ON public.imported_resources TO service_role;

ALTER TABLE public.imported_resources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own imported_resources"
  ON public.imported_resources FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER set_imported_resources_updated_at
  BEFORE UPDATE ON public.imported_resources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();