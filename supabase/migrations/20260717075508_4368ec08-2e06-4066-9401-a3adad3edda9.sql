
REVOKE ALL ON FUNCTION public.renew_agent_run_lease(uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renew_agent_run_lease(uuid, uuid, text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_agent_run_lease(uuid, uuid, text, integer) TO service_role;
