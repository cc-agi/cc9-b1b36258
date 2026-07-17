
REVOKE EXECUTE ON FUNCTION public.sweep_stale_agent_runs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_stale_agent_runs() TO service_role;
