REVOKE EXECUTE ON FUNCTION public.sweep_stale_agent_runs() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.claim_next_agent_run(uuid, text, integer) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.sweep_stale_agent_runs() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_agent_run(uuid, text, integer) TO service_role;
