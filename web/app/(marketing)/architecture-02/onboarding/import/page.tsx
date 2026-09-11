"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { recordEvent } from "@/lib/analytics/record-event";
import { parseGeneratedPlan } from "@/lib/plan-generation/parse";
import { persistGeneratedPlan } from "@/lib/plan-generation/persist";
import { PLAN_SCHEMA_VERSION, PlanGenerationError, type GeneratedPlan } from "@/lib/plan-generation/types";
import "../../signal-deck.css";
import "../onboarding.css";
import "./import-export.css";
import "../../fixed-layer-safety.css";

type Tab = "import" | "export";
type ImportState = "idle" | "previewing" | "importing" | "error";
type ExportState = "idle" | "loading" | "ready" | "error";

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsText(file);
  });
}

export default function SignalDeckImportExportPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("import");

  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<GeneratedPlan | null>(null);
  const [importState, setImportState] = useState<ImportState>("idle");
  const [importError, setImportError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [exportState, setExportState] = useState<ExportState>("idle");
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportJson, setExportJson] = useState("");
  const [copyStatus, setCopyStatus] = useState("");

  const validate = (text: string) => {
    setRaw(text);
    setImportError(null);
    setPreview(null);
    setImportState("idle");
    if (!text.trim()) return;
    try {
      // "any": an imported file isn't bound to onboarding's fixed 2-week AI
      // contract -- see parse.ts's ParseGeneratedPlanOptions.
      const plan = parseGeneratedPlan(text, { weekCount: "any" });
      setPreview(plan);
      setImportState("previewing");
    } catch (err) {
      setImportError(err instanceof PlanGenerationError ? err.message : "That file isn't a valid mtdo.plan.v1 export.");
      setImportState("error");
    }
  };

  const onFile = async (file: File) => {
    try {
      validate(await readFileAsText(file));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Could not read that file.");
      setImportState("error");
    }
  };

  const confirmImport = async () => {
    if (!preview || importState !== "previewing") return;
    setImportState("importing");
    setImportError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError || !user) throw new Error("No authenticated session. Refresh and try again.");

      const persisted = await persistGeneratedPlan(supabase, user.id, preview);
      await recordEvent(supabase, "goal_created", { method: "import", categoryCount: persisted.categories.length });
      try {
        window.localStorage.setItem("mtdo-active-plan", JSON.stringify(persisted));
      } catch {
        // Convenience cache only -- the persisted Supabase plan is authoritative.
      }
      router.push("/architecture-02?deck=work");
    } catch (err) {
      console.error("[import] failed to persist plan:", err);
      setImportError(err instanceof Error ? err.message : "We couldn't save that plan. Try again.");
      setImportState("previewing");
    }
  };

  const runExport = async () => {
    setExportState("loading");
    setExportError(null);
    setCopyStatus("");
    try {
      const supabase = createClient();
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError || !user) throw new Error("No authenticated session. Refresh and try again.");

      const { data: planRow, error: planError } = await supabase
        .from("plans")
        .select("id, app_name, goal_line")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .maybeSingle();
      if (planError) throw new Error(planError.message);
      if (!planRow) throw new Error("You don't have an active route to export yet.");

      const { data: categoryRows, error: categoryError } = await supabase
        .from("plan_categories")
        .select("id, name, label, days, min_blocks, score_weight, topic_type, coaching_framework, sort_order")
        .eq("plan_id", planRow.id)
        .order("sort_order");
      if (categoryError) throw new Error(categoryError.message);

      const categoryIds = (categoryRows ?? []).map((row) => row.id as string);
      const { data: itemRows, error: itemError } =
        categoryIds.length > 0
          ? await supabase
              .from("curriculum_items")
              .select("category_id, week_index, position, task, meta")
              .in("category_id", categoryIds)
              .order("week_index")
              .order("position")
          : { data: [], error: null };
      if (itemError) throw new Error(itemError.message);

      const itemsByCategory = new Map<string, Array<{ task: string; meta: Record<string, unknown> }>>();
      for (const item of itemRows ?? []) {
        const list = itemsByCategory.get(item.category_id as string) ?? [];
        list.push({ task: item.task as string, meta: (item.meta as Record<string, unknown>) ?? {} });
        itemsByCategory.set(item.category_id as string, list);
      }

      const plan = {
        schema_version: PLAN_SCHEMA_VERSION,
        app_name: planRow.app_name,
        goal_line: planRow.goal_line,
        categories: (categoryRows ?? []).map((category) => {
          const items = itemsByCategory.get(category.id as string) ?? [];
          const coachingFramework = (category.coaching_framework as Record<string, unknown>) ?? {};
          return {
            name: category.name,
            label: category.label,
            days: category.days,
            min_blocks: category.min_blocks,
            score_weight: category.score_weight,
            ...(category.topic_type ? { topic_type: category.topic_type } : {}),
            ...(Object.keys(coachingFramework).length > 0 ? { coaching_framework: coachingFramework } : {}),
            // One item per day-list slot -- the exact shape Manual Setup
            // produces, and the closest honest reconstruction available for
            // an AI-generated plan: week_index/position alone don't record
            // which original items shared one day-list entry, so this can't
            // recover a multi-item-per-day grouping byte-for-byte, only the
            // items themselves, correctly ordered and week-bucketed.
            curriculum: items.map(({ task, meta }) =>
              Object.keys(meta).length > 0 ? [{ task, ...meta }] : [task],
            ),
          };
        }),
      };

      setExportJson(JSON.stringify(plan, null, 2));
      setExportState("ready");
    } catch (err) {
      console.error("[export] failed:", err);
      setExportError(err instanceof Error ? err.message : "We couldn't export your route.");
      setExportState("error");
    }
  };

  const copyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportJson);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Couldn't copy automatically -- select the text and copy it by hand.");
    }
  };

  return (
    <main className="a02-shell a02-onboarding-shell">
      <div className="a02-grid-glow" />
      <header className="a02-onboarding-header">
        <Link href="/architecture-02" className="a02-wordmark">
          mtdo<span>◒</span>
        </Link>
        <span>ROUTE SETUP / IMPORT-EXPORT</span>
        <Link href="/architecture-02/onboarding">Exit setup ×</Link>
      </header>
      <section className="a02-onboarding-layout">
        <aside className="a02-onboarding-aside">
          <span className="a02-eyebrow">SIGNAL DECK / IMPORT · EXPORT</span>
          <h1>
            Bring your
            <br />
            <em>own file.</em>
          </h1>
          <p>
            {tab === "import"
              ? `A ${PLAN_SCHEMA_VERSION} JSON file, from a previous export or "mtdo export" on the terminal app.`
              : "A JSON file compatible with the terminal app's own \"mtdo import\"."}
          </p>
        </aside>
        <section className="a02-onboarding-panel" aria-live="polite">
          <section className="a02-onboarding-step a02-import-step">
            <div className="a02-import-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "import"} className={tab === "import" ? "is-selected" : ""} onClick={() => setTab("import")}>
                Import
              </button>
              <button type="button" role="tab" aria-selected={tab === "export"} className={tab === "export" ? "is-selected" : ""} onClick={() => setTab("export")}>
                Export
              </button>
            </div>

            {tab === "import" && (
              <>
                <span className="a02-eyebrow">PASTE OR DROP A FILE</span>
                <h2>
                  Load an
                  <br />
                  <em>existing route.</em>
                </h2>
                <div
                  className={`a02-import-dropzone ${dragOver ? "is-drag-over" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOver(false);
                    const file = event.dataTransfer.files[0];
                    if (file) void onFile(file);
                  }}
                >
                  <p>Drag a .json file here, or</p>
                  <button type="button" onClick={() => fileInputRef.current?.click()}>
                    choose a file
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void onFile(file);
                      event.target.value = "";
                    }}
                  />
                </div>
                <label>
                  OR PASTE JSON
                  <textarea value={raw} onChange={(event) => validate(event.target.value)} placeholder={`{"schema_version":"${PLAN_SCHEMA_VERSION}", "goal_line":"...", "categories":[...]}`} />
                </label>

                {importError && (
                  <p className="a02-onboarding-error" role="alert">
                    {importError}
                  </p>
                )}

                {preview && importState !== "error" && (
                  <div className="a02-import-preview">
                    <span>PREVIEW</span>
                    <p>{preview.goal_line}</p>
                    <ol>
                      {preview.categories.map((category) => (
                        <li key={category.name}>
                          <b>{category.label}</b>
                          <span>{category.curriculum.flat().length} tasks</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                <div className="a02-onboarding-actions">
                  <Link href="/architecture-02/onboarding">← Back</Link>
                  <button
                    type="button"
                    className="a02-onboarding-primary"
                    disabled={!preview || importState === "importing" || importState === "error"}
                    onClick={() => void confirmImport()}
                  >
                    {importState === "importing" ? "Importing…" : "Import this route"} <i>↗</i>
                  </button>
                </div>
              </>
            )}

            {tab === "export" && (
              <>
                <span className="a02-eyebrow">SAVE YOUR ROUTE</span>
                <h2>
                  Take it
                  <br />
                  <em>with you.</em>
                </h2>
                <p>Exports your active route as a {PLAN_SCHEMA_VERSION} JSON file -- re-importable here or on the terminal app.</p>
                <button type="button" className="a02-onboarding-primary" onClick={() => void runExport()} disabled={exportState === "loading"}>
                  {exportState === "loading" ? "Reading your route…" : "Export my route"} <i>↗</i>
                </button>
                {exportError && (
                  <p className="a02-onboarding-error" role="alert">
                    {exportError}
                  </p>
                )}
                {exportState === "ready" && (
                  <div className="a02-import-preview a02-export-result">
                    <span>EXPORTED JSON</span>
                    <textarea readOnly value={exportJson} />
                    <div className="a02-export-actions">
                      <button type="button" onClick={() => void copyExport()}>
                        Copy to clipboard
                      </button>
                      {copyStatus && <small>{copyStatus}</small>}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </section>
      </section>
    </main>
  );
}
