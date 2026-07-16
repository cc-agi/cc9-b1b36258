import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { listConversations, createConversation } from "@/lib/conversations.functions";

export const Route = createFileRoute("/_authenticated/console/")({
  head: () => ({ meta: [{ title: "控制台 · Sentinel OS" }] }),
  component: ConsoleRedirect,
});

function ConsoleRedirect() {
  const navigate = useNavigate();
  const listFn = useServerFn(listConversations);
  const createFn = useServerFn(createConversation);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      try {
        const rows = await listFn();
        let id = rows[0]?.id;
        if (!id) {
          const row = await createFn({ data: { kind: "task" } });
          id = row.id;
        }
        navigate({
          to: "/console/$conversationId",
          params: { conversationId: id },
          replace: true,
        });
      } catch {
        // Fallback: create new
        try {
          const row = await createFn({ data: { kind: "task" } });
          navigate({
            to: "/console/$conversationId",
            params: { conversationId: row.id },
            replace: true,
          });
        } catch {
          /* swallow */
        }
      }
    })();
  }, [listFn, createFn, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        正在打开控制台…
      </div>
    </div>
  );
}
