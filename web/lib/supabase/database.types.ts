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
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activity_events: {
        Row: {
          id: number
          kind: string
          occurred_at: string
          payload: Json
          room_id: string | null
          session_id: string | null
          user_id: string
        }
        Insert: {
          id?: never
          kind: string
          occurred_at?: string
          payload?: Json
          room_id?: string | null
          session_id?: string | null
          user_id: string
        }
        Update: {
          id?: never
          kind?: string
          occurred_at?: string
          payload?: Json
          room_id?: string | null
          session_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      ai_generations: {
        Row: {
          created_at: string
          error_code: string | null
          id: string
          input_tokens: number | null
          kind: string
          model: string
          output_tokens: number | null
          provider: string
          user_id: string
          valid: boolean
        }
        Insert: {
          created_at?: string
          error_code?: string | null
          id?: string
          input_tokens?: number | null
          kind: string
          model: string
          output_tokens?: number | null
          provider: string
          user_id: string
          valid: boolean
        }
        Update: {
          created_at?: string
          error_code?: string | null
          id?: string
          input_tokens?: number | null
          kind?: string
          model?: string
          output_tokens?: number | null
          provider?: string
          user_id?: string
          valid?: boolean
        }
        Relationships: []
      }
      ai_provider_settings: {
        Row: {
          coaching_model: string | null
          endpoint: string | null
          planning_model: string | null
          provider: string
          updated_at: string
          user_id: string
        }
        Insert: {
          coaching_model?: string | null
          endpoint?: string | null
          planning_model?: string | null
          provider?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          coaching_model?: string | null
          endpoint?: string | null
          planning_model?: string | null
          provider?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      blocks: {
        Row: {
          category_id: string
          claimed: boolean
          coaching: Json | null
          completed_at: string | null
          curriculum_item_id: string | null
          date: string
          elapsed_seconds: number
          estimated_minutes: number | null
          id: string
          notes: string | null
          plan_id: string
          position: number
          priority: string
          started_at: string | null
          status: string
          text: string
          user_id: string
        }
        Insert: {
          category_id: string
          claimed?: boolean
          coaching?: Json | null
          completed_at?: string | null
          curriculum_item_id?: string | null
          date: string
          elapsed_seconds?: number
          estimated_minutes?: number | null
          id?: string
          notes?: string | null
          plan_id: string
          position: number
          priority?: string
          started_at?: string | null
          status?: string
          text: string
          user_id: string
        }
        Update: {
          category_id?: string
          claimed?: boolean
          coaching?: Json | null
          completed_at?: string | null
          curriculum_item_id?: string | null
          date?: string
          elapsed_seconds?: number
          estimated_minutes?: number | null
          id?: string
          notes?: string | null
          plan_id?: string
          position?: number
          priority?: string
          started_at?: string | null
          status?: string
          text?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocks_category_fk"
            columns: ["category_id", "plan_id"]
            isOneToOne: false
            referencedRelation: "plan_categories"
            referencedColumns: ["id", "plan_id"]
          },
          {
            foreignKeyName: "blocks_curriculum_item_fk"
            columns: ["curriculum_item_id", "category_id"]
            isOneToOne: false
            referencedRelation: "curriculum_items"
            referencedColumns: ["id", "category_id"]
          },
          {
            foreignKeyName: "blocks_plan_fk"
            columns: ["plan_id", "user_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      companies: {
        Row: {
          date_added: string
          id: string
          name: string
          notes: string | null
          status: string
          user_id: string
        }
        Insert: {
          date_added?: string
          id?: string
          name: string
          notes?: string | null
          status?: string
          user_id: string
        }
        Update: {
          date_added?: string
          id?: string
          name?: string
          notes?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      curriculum_items: {
        Row: {
          category_id: string
          estimated_minutes: number | null
          id: string
          meta: Json
          position: number
          priority: string
          task: string
          week_index: number
        }
        Insert: {
          category_id: string
          estimated_minutes?: number | null
          id?: string
          meta?: Json
          position: number
          priority?: string
          task: string
          week_index: number
        }
        Update: {
          category_id?: string
          estimated_minutes?: number | null
          id?: string
          meta?: Json
          position?: number
          priority?: string
          task?: string
          week_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "curriculum_items_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "plan_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_rollups: {
        Row: {
          blocks_done: number
          computed_at: string
          date: string
          focus_seconds: number
          id: string
          room_id: string | null
          sessions_completed: number
          user_id: string
        }
        Insert: {
          blocks_done?: number
          computed_at?: string
          date: string
          focus_seconds?: number
          id?: string
          room_id?: string | null
          sessions_completed?: number
          user_id: string
        }
        Update: {
          blocks_done?: number
          computed_at?: string
          date?: string
          focus_seconds?: number
          id?: string
          room_id?: string | null
          sessions_completed?: number
          user_id?: string
        }
        Relationships: []
      }
      feedback: {
        Row: {
          created_at: string
          id: string
          message: string
          screen: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message: string
          screen: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          screen?: string
          user_id?: string
        }
        Relationships: []
      }
      focus_sessions: {
        Row: {
          block_id: string | null
          completed_at: string | null
          grace_expires_at: string | null
          id: string
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          user_id: string
        }
        Insert: {
          block_id?: string | null
          completed_at?: string | null
          grace_expires_at?: string | null
          id?: string
          planned_duration_s: number
          room_id?: string | null
          started_at?: string
          state?: string
          user_id: string
        }
        Update: {
          block_id?: string | null
          completed_at?: string | null
          grace_expires_at?: string | null
          id?: string
          planned_duration_s?: number
          room_id?: string | null
          started_at?: string
          state?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "focus_sessions_block_fk"
            columns: ["block_id", "user_id"]
            isOneToOne: false
            referencedRelation: "blocks"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      notes: {
        Row: {
          body: string | null
          created_at: string
          id: string
          tags: string[]
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          tags?: string[]
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          tags?: string[]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      plan_categories: {
        Row: {
          coaching_framework: Json
          days: number[]
          id: string
          label: string
          menu_unlocked_iso_week: string | null
          menu_unlocked_week_index: number
          min_blocks: number
          name: string
          plan_id: string
          score_weight: number
          sort_order: number
          topic_type: string | null
        }
        Insert: {
          coaching_framework?: Json
          days?: number[]
          id?: string
          label: string
          menu_unlocked_iso_week?: string | null
          menu_unlocked_week_index?: number
          min_blocks?: number
          name: string
          plan_id: string
          score_weight?: number
          sort_order?: number
          topic_type?: string | null
        }
        Update: {
          coaching_framework?: Json
          days?: number[]
          id?: string
          label?: string
          menu_unlocked_iso_week?: string | null
          menu_unlocked_week_index?: number
          min_blocks?: number
          name?: string
          plan_id?: string
          score_weight?: number
          sort_order?: number
          topic_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "plan_categories_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          app_name: string
          created_at: string
          goal_line: string
          id: string
          is_active: boolean
          onboarding_answers: Json | null
          planning_mode: string
          user_id: string
        }
        Insert: {
          app_name: string
          created_at?: string
          goal_line: string
          id?: string
          is_active?: boolean
          onboarding_answers?: Json | null
          planning_mode?: string
          user_id: string
        }
        Update: {
          app_name?: string
          created_at?: string
          goal_line?: string
          id?: string
          is_active?: boolean
          onboarding_answers?: Json | null
          planning_mode?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          is_anonymous: boolean
          timezone: string | null
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          is_anonymous?: boolean
          timezone?: string | null
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          is_anonymous?: boolean
          timezone?: string | null
        }
        Relationships: []
      }
      proofs: {
        Row: {
          artifact_url: string | null
          block_id: string | null
          body: string
          created_at: string
          id: string
          session_id: string | null
          user_id: string
          visibility: string
        }
        Insert: {
          artifact_url?: string | null
          block_id?: string | null
          body: string
          created_at?: string
          id?: string
          session_id?: string | null
          user_id: string
          visibility?: string
        }
        Update: {
          artifact_url?: string | null
          block_id?: string | null
          body?: string
          created_at?: string
          id?: string
          session_id?: string | null
          user_id?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "proofs_block_fk"
            columns: ["block_id", "user_id"]
            isOneToOne: false
            referencedRelation: "blocks"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "proofs_session_fk"
            columns: ["session_id", "user_id"]
            isOneToOne: false
            referencedRelation: "focus_sessions"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      tutor_conversations: {
        Row: {
          created_at: string
          id: string
          last_message_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_message_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_message_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tutor_memory_summaries: {
        Row: {
          summarized_through: string
          summary: string
          updated_at: string
          user_id: string
        }
        Insert: {
          summarized_through?: string
          summary?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          summarized_through?: string
          summary?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tutor_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          role: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "tutor_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "tutor_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      abandon_session: {
        Args: { p_id: string }
        Returns: {
          block_id: string | null
          completed_at: string | null
          grace_expires_at: string | null
          id: string
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "focus_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      activate_plan: { Args: { p_plan_id: string }; Returns: undefined }
      append_event: {
        Args: {
          p_kind: string
          p_payload: Json
          p_room_id?: string
          p_session_id?: string
          p_user_id: string
        }
        Returns: {
          id: number
          kind: string
          occurred_at: string
          payload: Json
          room_id: string | null
          session_id: string | null
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "activity_events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      complete_session: {
        Args: { p_id: string }
        Returns: {
          block_id: string | null
          completed_at: string | null
          grace_expires_at: string | null
          id: string
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "focus_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      ensure_curriculum_menu: {
        Args: never
        Returns: {
          category_id: string
          category_label: string
          category_name: string
          category_sort_order: number
          curriculum_item_id: string
          item_position: number
          meta: Json
          task: string
          week_index: number
        }[]
      }
      extend_plan: {
        Args: { p_extension: Json }
        Returns: {
          category_id: string
          estimated_minutes: number | null
          id: string
          meta: Json
          position: number
          priority: string
          task: string
          week_index: number
        }[]
        SetofOptions: {
          from: "*"
          to: "curriculum_items"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      pick_curriculum_item: {
        Args: { p_item_id: string }
        Returns: {
          category_id: string
          claimed: boolean
          coaching: Json | null
          completed_at: string | null
          curriculum_item_id: string | null
          date: string
          elapsed_seconds: number
          estimated_minutes: number | null
          id: string
          notes: string | null
          plan_id: string
          position: number
          priority: string
          started_at: string | null
          status: string
          text: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "blocks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      recompute_daily_rollups: {
        Args: { p_from?: string; p_timezone?: string; p_to?: string }
        Returns: number
      }
      record_event: {
        Args: { p_kind: string; p_payload?: Json }
        Returns: {
          id: number
          kind: string
          occurred_at: string
          payload: Json
          room_id: string | null
          session_id: string | null
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "activity_events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      settle_session: {
        Args: { p_id: string; p_state: string }
        Returns: {
          block_id: string | null
          completed_at: string | null
          grace_expires_at: string | null
          id: string
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "focus_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_session: {
        Args: { p_block_id?: string; p_planned_duration_s?: number }
        Returns: {
          block_id: string | null
          completed_at: string | null
          grace_expires_at: string | null
          id: string
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "focus_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      tutor_context: {
        Args: { p_conversation_id: string; p_recent_limit?: number }
        Returns: {
          recent: Json
          summary: string
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
