
CREATE TABLE public.user_recovery_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_recovery_codes_user ON public.user_recovery_codes(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_recovery_codes TO authenticated;
GRANT ALL ON public.user_recovery_codes TO service_role;

ALTER TABLE public.user_recovery_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own recovery codes"
  ON public.user_recovery_codes
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
