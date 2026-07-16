CREATE TABLE public.user_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cloud','gdrive','local','custom')),
  path text,
  is_active boolean NOT NULL DEFAULT false,
  sort_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_workspaces TO authenticated;
GRANT ALL ON public.user_workspaces TO service_role;

ALTER TABLE public.user_workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own workspaces"
  ON public.user_workspaces
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX user_workspaces_user_idx ON public.user_workspaces(user_id, sort_index);

CREATE TRIGGER user_workspaces_set_updated_at
  BEFORE UPDATE ON public.user_workspaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Storage.objects policies for the 'workspace-cloud' bucket (bucket is created via storage tool).
-- Files live under path: <user_id>/...
CREATE POLICY "Users read own cloud files"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'workspace-cloud' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users upload to own cloud"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'workspace-cloud' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users update own cloud files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'workspace-cloud' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'workspace-cloud' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users delete own cloud files"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'workspace-cloud' AND auth.uid()::text = (storage.foldername(name))[1]);