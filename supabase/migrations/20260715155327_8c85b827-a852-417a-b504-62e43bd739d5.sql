CREATE TABLE public.mcp_oauth_pending (
  state text PRIMARY KEY,
  user_id uuid NOT NULL,
  server_id text NOT NULL,
  code_verifier text NOT NULL,
  client_registration_ciphertext text NOT NULL,
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.mcp_oauth_pending TO service_role;
ALTER TABLE public.mcp_oauth_pending ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON public.mcp_oauth_pending FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX idx_mcp_oauth_pending_created_at ON public.mcp_oauth_pending(created_at);