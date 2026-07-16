CREATE TABLE public.user_memory_profile (
  user_id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_memory_profile TO authenticated;
GRANT ALL ON public.user_memory_profile TO service_role;

ALTER TABLE public.user_memory_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own memory profile"
  ON public.user_memory_profile
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER user_memory_profile_set_updated_at
  BEFORE UPDATE ON public.user_memory_profile
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();