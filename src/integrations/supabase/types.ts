export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          payload: Json
          run_id: string
          sequence: number
          step_index: number
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          run_id: string
          sequence: number
          step_index?: number
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          run_id?: string
          sequence?: number
          step_index?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          attempts: number
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          final_output: string | null
          goal: string
          heartbeat_at: string | null
          id: string
          last_error: string | null
          lease_expires_at: string | null
          max_attempts: number
          started_at: string | null
          status: string
          timed_out_at: string | null
          updated_at: string
          user_id: string
          worker_id: string | null
        }
        Insert: {
          attempts?: number
          cancel_requested_at?: string | null
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          final_output?: string | null
          goal: string
          heartbeat_at?: string | null
          id?: string
          last_error?: string | null
          lease_expires_at?: string | null
          max_attempts?: number
          started_at?: string | null
          status?: string
          timed_out_at?: string | null
          updated_at?: string
          user_id: string
          worker_id?: string | null
        }
        Update: {
          attempts?: number
          cancel_requested_at?: string | null
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          final_output?: string | null
          goal?: string
          heartbeat_at?: string | null
          id?: string
          last_error?: string | null
          lease_expires_at?: string | null
          max_attempts?: number
          started_at?: string | null
          status?: string
          timed_out_at?: string | null
          updated_at?: string
          user_id?: string
          worker_id?: string | null
        }
        Relationships: []
      }
      agent_step_intents: {
        Row: {
          arguments: Json
          attempt: number
          completed_at: string | null
          created_at: string
          delivered_at: string | null
          id: string
          idempotency_key: string | null
          lease_version: number
          run_id: string
          sequence: number
          status: string
          tool_name: string
          user_id: string
          worker_id: string | null
        }
        Insert: {
          arguments?: Json
          attempt?: number
          completed_at?: string | null
          created_at?: string
          delivered_at?: string | null
          id?: string
          idempotency_key?: string | null
          lease_version?: number
          run_id: string
          sequence: number
          status?: string
          tool_name: string
          user_id: string
          worker_id?: string | null
        }
        Update: {
          arguments?: Json
          attempt?: number
          completed_at?: string | null
          created_at?: string
          delivered_at?: string | null
          id?: string
          idempotency_key?: string | null
          lease_version?: number
          run_id?: string
          sequence?: number
          status?: string
          tool_name?: string
          user_id?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_step_intents_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_step_results: {
        Row: {
          attempt: number
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          idempotency_key: string | null
          intent_id: string
          latency_ms: number | null
          ok: boolean
          result: Json | null
          run_id: string
          user_id: string
        }
        Insert: {
          attempt?: number
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          intent_id: string
          latency_ms?: number | null
          ok: boolean
          result?: Json | null
          run_id: string
          user_id: string
        }
        Update: {
          attempt?: number
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          intent_id?: string
          latency_ms?: number | null
          ok?: boolean
          result?: Json | null
          run_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_step_results_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "agent_step_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_step_results_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_messages: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          message: Json
          role: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          message: Json
          role: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          message?: Json
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          created_at: string
          id: string
          kind: string
          model: string | null
          provider: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string
          model?: string | null
          provider?: string | null
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          model?: string | null
          provider?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      imported_resources: {
        Row: {
          created_at: string
          description: string | null
          id: string
          kind: string
          metadata: Json
          name: string
          source: string
          source_id: string
          synced_at: string | null
          updated_at: string
          user_id: string
          version: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          kind: string
          metadata?: Json
          name: string
          source?: string
          source_id: string
          synced_at?: string | null
          updated_at?: string
          user_id: string
          version?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          kind?: string
          metadata?: Json
          name?: string
          source?: string
          source_id?: string
          synced_at?: string | null
          updated_at?: string
          user_id?: string
          version?: string | null
        }
        Relationships: []
      }
      mcp_connection_secrets: {
        Row: {
          algo: string
          ciphertext: string
          connection_id: string | null
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          algo?: string
          ciphertext: string
          connection_id?: string | null
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          algo?: string
          ciphertext?: string
          connection_id?: string | null
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      mcp_connections: {
        Row: {
          auth_metadata: Json
          auth_type: string
          base_url: string | null
          created_at: string
          disabled_reason: string | null
          has_credentials: boolean
          id: string
          last_error: string | null
          name: string
          rotation_required: boolean
          secret_ref: string | null
          state: string
          tools_cache: Json
          transport: string
          updated_at: string
          url: string
          user_id: string
        }
        Insert: {
          auth_metadata?: Json
          auth_type?: string
          base_url?: string | null
          created_at?: string
          disabled_reason?: string | null
          has_credentials?: boolean
          id?: string
          last_error?: string | null
          name: string
          rotation_required?: boolean
          secret_ref?: string | null
          state?: string
          tools_cache?: Json
          transport?: string
          updated_at?: string
          url: string
          user_id: string
        }
        Update: {
          auth_metadata?: Json
          auth_type?: string
          base_url?: string | null
          created_at?: string
          disabled_reason?: string | null
          has_credentials?: boolean
          id?: string
          last_error?: string | null
          name?: string
          rotation_required?: boolean
          secret_ref?: string | null
          state?: string
          tools_cache?: Json
          transport?: string
          updated_at?: string
          url?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcp_connections_secret_ref_fkey"
            columns: ["secret_ref"]
            isOneToOne: false
            referencedRelation: "mcp_connection_secrets"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_oauth_pending: {
        Row: {
          client_registration_ciphertext: string
          code_verifier: string
          created_at: string
          redirect_uri: string
          server_id: string
          state: string
          user_id: string
        }
        Insert: {
          client_registration_ciphertext: string
          code_verifier: string
          created_at?: string
          redirect_uri: string
          server_id: string
          state: string
          user_id: string
        }
        Update: {
          client_registration_ciphertext?: string
          code_verifier?: string
          created_at?: string
          redirect_uri?: string
          server_id?: string
          state?: string
          user_id?: string
        }
        Relationships: []
      }
      runtime_config: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      user_memories: {
        Row: {
          content: string
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_memory_profile: {
        Row: {
          content: string
          created_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content?: string
          created_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_recovery_codes: {
        Row: {
          code_hash: string
          created_at: string
          id: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          code_hash: string
          created_at?: string
          id?: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          code_hash?: string
          created_at?: string
          id?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_workspaces: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          kind: string
          name: string
          path: string | null
          sort_index: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          kind: string
          name: string
          path?: string | null
          sort_index?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          kind?: string
          name?: string
          path?: string | null
          sort_index?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      worker_heartbeats: {
        Row: {
          cdp_reachable: boolean | null
          chrome_version: string | null
          computer_name: string | null
          current_run_id: string | null
          last_error_code: string | null
          last_seen_at: string
          platform: string | null
          state: string
          user_id: string
          version: string | null
          worker_id: string
        }
        Insert: {
          cdp_reachable?: boolean | null
          chrome_version?: string | null
          computer_name?: string | null
          current_run_id?: string | null
          last_error_code?: string | null
          last_seen_at?: string
          platform?: string | null
          state?: string
          user_id: string
          version?: string | null
          worker_id: string
        }
        Update: {
          cdp_reachable?: boolean | null
          chrome_version?: string | null
          computer_name?: string | null
          current_run_id?: string | null
          last_error_code?: string | null
          last_seen_at?: string
          platform?: string | null
          state?: string
          user_id?: string
          version?: string | null
          worker_id?: string
        }
        Relationships: []
      }
      worker_pair_attempts: {
        Row: {
          failures: number
          ip: string
          locked_until: string | null
          window_start: string
        }
        Insert: {
          failures?: number
          ip: string
          locked_until?: string | null
          window_start?: string
        }
        Update: {
          failures?: number
          ip?: string
          locked_until?: string | null
          window_start?: string
        }
        Relationships: []
      }
      worker_pairing_codes: {
        Row: {
          code: string
          code_hash: string | null
          created_at: string
          expires_at: string
          used_at: string | null
          used_by_worker_id: string | null
          user_id: string
        }
        Insert: {
          code: string
          code_hash?: string | null
          created_at?: string
          expires_at: string
          used_at?: string | null
          used_by_worker_id?: string | null
          user_id: string
        }
        Update: {
          code?: string
          code_hash?: string | null
          created_at?: string
          expires_at?: string
          used_at?: string | null
          used_by_worker_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      worker_tokens: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          label: string | null
          last_used_at: string | null
          revoked_at: string | null
          token_hash: string
          user_id: string
          worker_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          label?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          token_hash: string
          user_id: string
          worker_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          label?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          token_hash?: string
          user_id?: string
          worker_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_next_agent_run: {
        Args: { _lease_seconds?: number; _user_id: string; _worker_id: string }
        Returns: {
          attempts: number
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          final_output: string | null
          goal: string
          heartbeat_at: string | null
          id: string
          last_error: string | null
          lease_expires_at: string | null
          max_attempts: number
          started_at: string | null
          status: string
          timed_out_at: string | null
          updated_at: string
          user_id: string
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "agent_runs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      renew_agent_run_lease: {
        Args: {
          _lease_seconds?: number
          _run_id: string
          _user_id: string
          _worker_id: string
        }
        Returns: {
          attempts: number
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          final_output: string | null
          goal: string
          heartbeat_at: string | null
          id: string
          last_error: string | null
          lease_expires_at: string | null
          max_attempts: number
          started_at: string | null
          status: string
          timed_out_at: string | null
          updated_at: string
          user_id: string
          worker_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "agent_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      request_cancel_agent_run: {
        Args: { _run_id: string }
        Returns: {
          attempts: number
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          final_output: string | null
          goal: string
          heartbeat_at: string | null
          id: string
          last_error: string | null
          lease_expires_at: string | null
          max_attempts: number
          started_at: string | null
          status: string
          timed_out_at: string | null
          updated_at: string
          user_id: string
          worker_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "agent_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      retry_agent_run: {
        Args: { _run_id: string }
        Returns: {
          attempts: number
          cancel_requested_at: string | null
          completed_at: string | null
          created_at: string
          error_code: string | null
          final_output: string | null
          goal: string
          heartbeat_at: string | null
          id: string
          last_error: string | null
          lease_expires_at: string | null
          max_attempts: number
          started_at: string | null
          status: string
          timed_out_at: string | null
          updated_at: string
          user_id: string
          worker_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "agent_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      sweep_stale_agent_runs: {
        Args: never
        Returns: {
          new_status: string
          previous_status: string
          reason: string
          swept_id: string
        }[]
      }
      verify_worker_token: {
        Args: { _hash: string }
        Returns: {
          user_id: string
          worker_id: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
