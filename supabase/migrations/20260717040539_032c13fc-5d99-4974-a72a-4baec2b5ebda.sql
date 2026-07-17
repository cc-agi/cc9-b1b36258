REVOKE ALL ON FUNCTION public.claim_next_agent_run(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_agent_run(uuid, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.verify_worker_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_worker_token(text) TO service_role;

REVOKE ALL ON FUNCTION public.request_cancel_agent_run(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_cancel_agent_run(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;