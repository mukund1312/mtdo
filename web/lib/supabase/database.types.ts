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
          scheduled_end_at: string | null
          scheduled_start_at: string | null
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
          scheduled_end_at?: string | null
          scheduled_start_at?: string | null
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
          scheduled_end_at?: string | null
          scheduled_start_at?: string | null
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
      calendar_connections: {
        Row: {
          calendar_id: string
          connected_at: string
          id: string
          provider: string
          refresh_token_encrypted: string
          scopes: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          calendar_id?: string
          connected_at?: string
          id?: string
          provider?: string
          refresh_token_encrypted: string
          scopes?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          calendar_id?: string
          connected_at?: string
          id?: string
          provider?: string
          refresh_token_encrypted?: string
          scopes?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      calendar_event_links: {
        Row: {
          block_id: string
          created_at: string
          external_calendar_id: string
          external_event_id: string
          id: string
          provider: string
          synced_at: string
          user_id: string
        }
        Insert: {
          block_id: string
          created_at?: string
          external_calendar_id?: string
          external_event_id: string
          id?: string
          provider?: string
          synced_at?: string
          user_id: string
        }
        Update: {
          block_id?: string
          created_at?: string
          external_calendar_id?: string
          external_event_id?: string
          id?: string
          provider?: string
          synced_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_event_links_block_fk"
            columns: ["block_id", "user_id"]
            isOneToOne: false
            referencedRelation: "blocks"
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
          break_plan: Json | null
          completed_at: string | null
          extended_s: number
          grace_expires_at: string | null
          id: string
          paused_at: string | null
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          total_paused_s: number
          user_id: string
        }
        Insert: {
          block_id?: string | null
          break_plan?: Json | null
          completed_at?: string | null
          extended_s?: number
          grace_expires_at?: string | null
          id?: string
          paused_at?: string | null
          planned_duration_s: number
          room_id?: string | null
          started_at?: string
          state?: string
          total_paused_s?: number
          user_id: string
        }
        Update: {
          block_id?: string | null
          break_plan?: Json | null
          completed_at?: string | null
          extended_s?: number
          grace_expires_at?: string | null
          id?: string
          paused_at?: string | null
          planned_duration_s?: number
          room_id?: string | null
          started_at?: string
          state?: string
          total_paused_s?: number
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
          created_at: string
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
          weekly_target_blocks: number | null
        }
        Insert: {
          coaching_framework?: Json
          created_at?: string
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
          weekly_target_blocks?: number | null
        }
        Update: {
          coaching_framework?: Json
          created_at?: string
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
          weekly_target_blocks?: number | null
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
      weekly_plan_changes: {
        Row: {
          change_type: string
          created_at: string
          decided_at: string | null
          id: string
          new_value: number | null
          old_value: number | null
          plan_id: string
          reason: string
          signal: string
          status: string
          target_category_id: string | null
          user_id: string
          weekly_plan_id: string
        }
        Insert: {
          change_type: string
          created_at?: string
          decided_at?: string | null
          id?: string
          new_value?: number | null
          old_value?: number | null
          plan_id: string
          reason: string
          signal: string
          status?: string
          target_category_id?: string | null
          user_id: string
          weekly_plan_id: string
        }
        Update: {
          change_type?: string
          created_at?: string
          decided_at?: string | null
          id?: string
          new_value?: number | null
          old_value?: number | null
          plan_id?: string
          reason?: string
          signal?: string
          status?: string
          target_category_id?: string | null
          user_id?: string
          weekly_plan_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_plan_changes_category_fk"
            columns: ["target_category_id", "plan_id"]
            isOneToOne: false
            referencedRelation: "plan_categories"
            referencedColumns: ["id", "plan_id"]
          },
          {
            foreignKeyName: "weekly_plan_changes_plan_fk"
            columns: ["weekly_plan_id", "user_id"]
            isOneToOne: false
            referencedRelation: "weekly_plans"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      weekly_plans: {
        Row: {
          created_at: string
          effective_iso_week: string
          generated_by: string
          id: string
          iso_week: string
          metrics: Json
          plan_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          effective_iso_week: string
          generated_by?: string
          id?: string
          iso_week: string
          metrics: Json
          plan_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          effective_iso_week?: string
          generated_by?: string
          id?: string
          iso_week?: string
          metrics?: Json
          plan_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weekly_plans_plan_fk"
            columns: ["plan_id", "user_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      abandon_session: {
        Args: {
          p_block_outcome?: string
          p_id: string
          p_leftover_note?: string
        }
        Returns: {
          block_id: string | null
          break_plan: Json | null
          completed_at: string | null
          extended_s: number
          grace_expires_at: string | null
          id: string
          paused_at: string | null
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          total_paused_s: number
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "focus_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      accept_all_weekly_plan_changes: {
        Args: { p_weekly_plan_id: string }
        Returns: Json
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
      apply_weekly_plan_change: {
        Args: { p_change_id: string; p_decision: string; p_new_value?: number }
        Returns: {
          change_type: string
          created_at: string
          decided_at: string | null
          id: string
          new_value: number | null
          old_value: number | null
          plan_id: string
          reason: string
          signal: string
          status: string
          target_category_id: string | null
          user_id: string
          weekly_plan_id: string
        }
        SetofOptions: {
          from: "*"
          to: "weekly_plan_changes"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      complete_session: {
        Args: {
          p_block_outcome?: string
          p_id: string
          p_leftover_note?: string
        }
        Returns: {
          block_id: string | null
          break_plan: Json | null
          completed_at: string | null
          extended_s: number
          grace_expires_at: string | null
          id: string
          paused_at: string | null
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          total_paused_s: number
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
      extend_session: {
        Args: { p_additional_s: number; p_id: string }
        Returns: {
          block_id: string | null
          break_plan: Json | null
          completed_at: string | null
          extended_s: number
          grace_expires_at: string | null
          id: string
          paused_at: string | null
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          total_paused_s: number
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "focus_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      iso_week_start: { Args: { p_iso_week: string }; Returns: string }
      pause_session: {
        Args: { p_id: string; p_reason?: string }
        Returns: {
          block_id: string | null
          break_plan: Json | null
          completed_at: string | null
          extended_s: number
          grace_expires_at: string | null
          id: string
          paused_at: string | null
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          total_paused_s: number
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "focus_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      pick_curriculum_item: {
        Args: { p_item_id: string; p_target_date?: string }
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
          scheduled_end_at: string | null
          scheduled_start_at: string | null
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
      refresh_weekly_plan_status: {
        Args: { p_weekly_plan_id: string }
        Returns: undefined
      }
      resume_session: {
        Args: { p_id: string }
        Returns: {
          block_id: string | null
          break_plan: Json | null
          completed_at: string | null
          extended_s: number
          grace_expires_at: string | null
          id: string
          paused_at: string | null
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          total_paused_s: number
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "focus_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_weekly_plan: {
        Args: {
          p_changes: Json
          p_effective_iso_week: string
          p_iso_week: string
          p_metrics: Json
          p_plan_id: string
        }
        Returns: string
      }
      schedule_block: {
        Args: {
          p_block_id: string
          p_date?: string
          p_end_at?: string
          p_start_at?: string
        }
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
          scheduled_end_at: string | null
          scheduled_start_at: string | null
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
      seed_weekly_engine_demo: {
        Args: {
          p_activate?: boolean
          p_anchor_iso_week?: string
          p_user_id: string
        }
        Returns: Json
      }
      session_focus_seconds: {
        Args: {
          p_completed_at: string
          p_planned_duration_s: number
          p_started_at: string
          p_total_paused_s: number
        }
        Returns: number
      }
      settle_block_outcome: {
        Args: {
          p_leftover_note?: string
          p_outcome: string
          p_session_id: string
        }
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
          scheduled_end_at: string | null
          scheduled_start_at: string | null
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
      settle_session: {
        Args: {
          p_block_outcome?: string
          p_id: string
          p_leftover_note?: string
          p_state: string
        }
        Returns: {
          block_id: string | null
          break_plan: Json | null
          completed_at: string | null
          extended_s: number
          grace_expires_at: string | null
          id: string
          paused_at: string | null
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          total_paused_s: number
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
        Args: {
          p_block_id?: string
          p_break_plan?: Json
          p_planned_duration_s?: number
        }
        Returns: {
          block_id: string | null
          break_plan: Json | null
          completed_at: string | null
          extended_s: number
          grace_expires_at: string | null
          id: string
          paused_at: string | null
          planned_duration_s: number
          room_id: string | null
          started_at: string
          state: string
          total_paused_s: number
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
      weekly_performance: {
        Args: { p_iso_week: string; p_plan_id: string }
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
