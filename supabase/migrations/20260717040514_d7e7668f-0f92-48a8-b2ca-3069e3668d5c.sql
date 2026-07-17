REVOKE ALL ON FUNCTION public.enforce_agent_run_transition() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sweep_stale_agent_runs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retry_agent_run(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retry_agent_run(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_stale_agent_runs() TO service_role;