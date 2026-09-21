"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { recordEvent } from "@/lib/analytics/record-event";
import { persistGeneratedPlan } from "@/lib/plan-generation/persist";
import type { GeneratedPlan, TopicType } from "@/lib/plan-generation/types";
import "../../signal-deck.css";
import "../onboarding.css";
import "./manual.css";
import "../../fixed-layer-safety.css";

const DAYS = [[0, "MON"], [1, "TUE"], [2, "WED"], [3, "THU"], [4, "FRI"], [5, "SAT"], [6, "SUN"]] as const;
const TOPIC_TYPES: Array<{ value: TopicType | ""; label: string }> = [
  { value: "", label: "None" },
  { value: "dsa", label: "DSA" },
  { value: "backend", label: "Backend" },
  { value: "database", label: "Database" },
  { value: "system_design", label: "System design" },
];

type DraftCategory = {
  key: string;
  label: string;
  days: number[];
  scoreWeight: number;
  topicType: TopicType | "";
  tasks: DraftTask[];
  taskDraft: string;
  topics: DraftTopic[];
  topicDraft: string;
  topicParentKey: string;
};

type DraftTask = { key: string; text: string; topicKey: string | null };
type DraftTopic = { key: string; label: string; parentKey: string | null };

function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "subject";
}

function newCategory(): DraftCategory {
  return {
    key: crypto.randomUUID(),
    label: "",
    days: [0, 1, 2, 3, 4],
    scoreWeight: 50,
    topicType: "",
    tasks: [],
    taskDraft: "",
    topics: [],
    topicDraft: "",
    topicParentKey: "",
  };
}

export default function SignalDeckManualSetupPage() {
  const router = useRouter();
  const [appName, setAppName] = useState("");
  const [goalLine, setGoalLine] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [categories, setCategories] = useState<DraftCategory[]>([newCategory()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateCategory = (key: string, patch: Partial<DraftCategory>) => {
    setCategories((current) => current.map((category) => (category.key === key ? { ...category, ...patch } : category)));
  };

  const toggleDay = (key: string, day: number) => {
    setCategories((current) =>
      current.map((category) => {
        if (category.key !== key) return category;
        const days = category.days.includes(day)
          ? category.days.filter((value) => value !== day)
          : [...category.days, day].sort((a, b) => a - b);
        return { ...category, days };
      }),
    );
  };

  const addTask = (key: string) => {
    setCategories((current) =>
      current.map((category) => {
        if (category.key !== key) return category;
        const task = category.taskDraft.trim();
        if (!task) return category;
        return { ...category, tasks: [...category.tasks, { key: crypto.randomUUID(), text: task, topicKey: null }], taskDraft: "" };
      }),
    );
  };

  const removeTask = (key: string, index: number) => {
    setCategories((current) =>
      current.map((category) =>
        category.key === key ? { ...category, tasks: category.tasks.filter((_, i) => i !== index) } : category,
      ),
    );
  };

  const addTopic = (key: string) => {
    setCategories((current) => current.map((category) => {
      if (category.key !== key) return category;
      const label = category.topicDraft.trim();
      if (!label) return category;
      return {
        ...category,
        topics: [...category.topics, { key: crypto.randomUUID(), label, parentKey: category.topicParentKey || null }],
        // A task may only point at a leaf. If this new topic turns a prior
        // leaf into a parent, leave that task honestly unassigned instead of
        // persisting an invalid taxonomy relationship.
        tasks: category.topicParentKey
          ? category.tasks.map((task) => task.topicKey === category.topicParentKey ? { ...task, topicKey: null } : task)
          : category.tasks,
        topicDraft: "",
        topicParentKey: "",
      };
    }));
  };

  const assignTaskTopic = (categoryKey: string, taskKey: string, topicKey: string) => {
    setCategories((current) => current.map((category) => category.key === categoryKey
      ? { ...category, tasks: category.tasks.map((task) => task.key === taskKey ? { ...task, topicKey: topicKey || null } : task) }
      : category));
  };

  const removeCategory = (key: string) => {
    setCategories((current) => current.filter((category) => category.key !== key));
  };

  const canSubmit =
    goalLine.trim().length > 4 &&
    categories.length > 0 &&
    categories.every((category) => category.label.trim().length > 0 && category.days.length > 0 && category.tasks.length > 0);

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setError(null);
    setSubmitting(true);

    // Auto-dedupe slugified names ("SQL" and "Sql" would otherwise collide
    // and fail the categories.name unique index at insert time with a raw
    // Postgres error instead of a clear one).
    const usedNames = new Set<string>();
    const plan: GeneratedPlan = {
      app_name: appName.trim() || "MTDO",
      goal_line: goalLine.trim(),
      categories: categories.map((category) => {
        let name = slugify(category.label);
        while (usedNames.has(name)) name = `${name}_2`;
        usedNames.add(name);
        return {
          name,
          label: category.label.trim(),
          days: category.days,
          min_blocks: 1,
          score_weight: category.scoreWeight,
          topic_type: category.topicType || undefined,
          // One task per inner list -- persist.ts buckets week_index by
          // floor(dayListIndex / daysPerWeek), so this lands every task in
          // the right week automatically without this screen needing to
          // think in week/day terms at all.
          // Topics are created below through create_topic(), after the plan
          // gives us real category ids. Keep these plain strings so
          // persistGeneratedPlan does not create a second, flat taxonomy.
          curriculum: category.tasks.map((task) => [task.text]),
        };
      }),
    };

    try {
      const supabase = createClient();
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError || !user) throw new Error("No authenticated session. Refresh and try again.");

      const persisted = await persistGeneratedPlan(supabase, user.id, plan);
      if (targetDate || categories.some((category) => category.topics.length > 0)) {
        for (const [categoryIndex, category] of categories.entries()) {
          const persistedCategory = persisted.categories[categoryIndex];
          if (!persistedCategory) throw new Error("The saved subject could not be found for its topics.");
          const topicIdByKey = new Map<string, string>();
          const createTopic = async (topic: DraftTopic, sortOrder: number): Promise<void> => {
            if (topicIdByKey.has(topic.key)) return;
            if (topic.parentKey) {
              const parent = category.topics.find((candidate) => candidate.key === topic.parentKey);
              if (!parent) throw new Error("A topic parent is missing. Please try again.");
              await createTopic(parent, category.topics.indexOf(parent));
            }
            const parentId = topic.parentKey ? topicIdByKey.get(topic.parentKey) : undefined;
            const siblingName = category.topics
              .slice(0, sortOrder + 1)
              .filter((candidate) => candidate.parentKey === topic.parentKey && candidate.label === topic.label).length;
            const { data, error: topicError } = await supabase.rpc("create_topic", {
              p_category_id: persistedCategory.id,
              p_name: `${slugify(topic.label)}_${siblingName}`,
              p_label: topic.label,
              ...(parentId ? { p_parent_topic_id: parentId } : {}),
              p_sort_order: sortOrder,
            });
            if (topicError || !data) throw new Error(`Couldn't create topic “${topic.label}”: ${topicError?.message ?? "no row returned"}`);
            topicIdByKey.set(topic.key, data.id);
          };
          for (const [topicIndex, topic] of category.topics.entries()) await createTopic(topic, topicIndex);

          if (category.tasks.some((task) => task.topicKey)) {
            const { data: items, error: itemsError } = await supabase
              .from("curriculum_items")
              .select("id, position")
              .eq("category_id", persistedCategory.id)
              .order("position");
            if (itemsError || !items || items.length !== category.tasks.length) {
              throw new Error(`Couldn't attach topics to ${persistedCategory.label}: ${itemsError?.message ?? "item count mismatch"}`);
            }
            for (const [taskIndex, task] of category.tasks.entries()) {
              if (!task.topicKey) continue;
              const topicId = topicIdByKey.get(task.topicKey);
              const item = items[taskIndex];
              if (!topicId || !item) throw new Error("A task must be assigned to a leaf topic.");
              const { error: assignmentError } = await supabase.from("curriculum_items").update({ topic_id: topicId }).eq("id", item.id);
              if (assignmentError) throw new Error(`Couldn't attach the topic to “${task.text}”: ${assignmentError.message}`);
            }
          }
        }
        if (targetDate) {
          const { error: dateError } = await supabase.rpc("set_plan_target_date", {
            p_plan_id: persisted.planId,
            p_target_date: targetDate,
          });
          if (dateError) throw new Error(`Your route was saved, but its target date could not be saved: ${dateError.message}`);
        }
      }
      await recordEvent(supabase, "goal_created", { method: "manual", categoryCount: persisted.categories.length });
      try {
        window.localStorage.setItem("mtdo-active-plan", JSON.stringify(persisted));
      } catch {
        // Convenience cache only -- the persisted Supabase plan is authoritative.
      }
      router.push("/architecture-02?deck=work");
    } catch (submitError) {
      console.error("[manual setup] failed to persist plan:", submitError);
      setError(submitError instanceof Error ? submitError.message : "We couldn't save your route. Try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="a02-shell a02-onboarding-shell">
      <div className="a02-grid-glow" />
      <header className="a02-onboarding-header">
        <Link href="/architecture-02" className="a02-wordmark">
          mtdo<span>◒</span>
        </Link>
        <span>ROUTE SETUP / MANUAL</span>
        <Link href="/architecture-02/onboarding">Exit setup ×</Link>
      </header>
      <section className="a02-onboarding-layout">
        <aside className="a02-onboarding-aside">
          <span className="a02-eyebrow">SIGNAL DECK / MANUAL SETUP</span>
          <h1>
            Build it
            <br />
            <em>by hand.</em>
          </h1>
          <p>Full control: your own subjects, your own rhythm, your own tasks. No AI involved.</p>
        </aside>
        <section className="a02-onboarding-panel" aria-live="polite">
          <section className="a02-onboarding-step a02-manual-step">
            <span className="a02-eyebrow">DEFINE THE ROUTE</span>
            <h2>
              What are you
              <br />
              <em>working toward?</em>
            </h2>
            <label>
              YOUR GOAL
              <textarea value={goalLine} onChange={(event) => setGoalLine(event.target.value)} placeholder="e.g. Get fluent in SQL joins for interviews" />
            </label>
            <label>
              NAME THIS ROUTE <span>OPTIONAL</span>
              <input value={appName} onChange={(event) => setAppName(event.target.value)} placeholder="e.g. Autumn interview sprint" />
            </label>
            <label>
              TARGET DATE <span>OPTIONAL</span>
              <input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
              <small className="a02-manual-field-note">Leave blank when this route has no deadline.</small>
            </label>

            <div className="a02-manual-categories">
              {categories.map((category, index) => (
                <article className="a02-manual-category" key={category.key}>
                  <header>
                    <span>SUBJECT {String(index + 1).padStart(2, "0")}</span>
                    {categories.length > 1 && (
                      <button type="button" onClick={() => removeCategory(category.key)} aria-label={`Remove subject ${index + 1}`}>
                        Remove ×
                      </button>
                    )}
                  </header>
                  <label>
                    LABEL
                    <input
                      value={category.label}
                      onChange={(event) => updateCategory(category.key, { label: event.target.value })}
                      placeholder="e.g. SQL Joins"
                    />
                  </label>
                  <fieldset>
                    <legend>WHICH DAYS</legend>
                    <div className="a02-day-options">
                      {DAYS.map(([day, label]) => (
                        <button
                          type="button"
                          key={day}
                          className={category.days.includes(day) ? "is-selected" : ""}
                          onClick={() => toggleDay(category.key, day)}
                          aria-pressed={category.days.includes(day)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <div className="a02-manual-row">
                    <label>
                      TOPIC TYPE <span>OPTIONAL</span>
                      <select
                        value={category.topicType}
                        onChange={(event) => updateCategory(category.key, { topicType: event.target.value as TopicType | "" })}
                      >
                        {TOPIC_TYPES.map((option) => (
                          <option key={option.value || "none"} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      SCORE WEIGHT
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={category.scoreWeight}
                        onChange={(event) => updateCategory(category.key, { scoreWeight: Number(event.target.value) || 0 })}
                      />
                    </label>
                  </div>
                  <fieldset className="a02-manual-topics">
                    <legend>TOPICS <span>OPTIONAL</span></legend>
                    <p>Fine-grained route topics are separate from the coaching topic type above.</p>
                    <div className="a02-chip-field">
                      <input
                        value={category.topicDraft}
                        onChange={(event) => updateCategory(category.key, { topicDraft: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addTopic(category.key);
                          }
                        }}
                        placeholder="e.g. BFS"
                      />
                      <select
                        aria-label="Parent topic"
                        value={category.topicParentKey}
                        onChange={(event) => updateCategory(category.key, { topicParentKey: event.target.value })}
                      >
                        <option value="">No parent (top-level)</option>
                        {category.topics.map((topic) => <option key={topic.key} value={topic.key}>{topic.label}</option>)}
                      </select>
                      <button type="button" onClick={() => addTopic(category.key)}>Add topic</button>
                    </div>
                    {category.topics.length > 0 && (
                      <ul className="a02-manual-topics-list">
                        {category.topics.map((topic) => (
                          <li key={topic.key}>{topic.parentKey ? `${category.topics.find((parent) => parent.key === topic.parentKey)?.label ?? "Topic"} → ` : ""}{topic.label}</li>
                        ))}
                      </ul>
                    )}
                  </fieldset>
                  <label>
                    TASKS
                    <div className="a02-chip-field">
                      <input
                        value={category.taskDraft}
                        onChange={(event) => updateCategory(category.key, { taskDraft: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addTask(category.key);
                          }
                        }}
                        placeholder="Add a task"
                      />
                      <button type="button" onClick={() => addTask(category.key)}>
                        Add
                      </button>
                    </div>
                  </label>
                  {category.tasks.length > 0 && (
                    <ol className="a02-manual-tasks">
                      {category.tasks.map((task, taskIndex) => {
                        const leafTopics = category.topics.filter((topic) => !category.topics.some((candidate) => candidate.parentKey === topic.key));
                        return (
                        <li key={task.key}>
                          <span>{task.text}</span>
                          <select aria-label={`Topic for ${task.text}`} value={task.topicKey ?? ""} onChange={(event) => assignTaskTopic(category.key, task.key, event.target.value)}>
                            <option value="">No topic</option>
                            {leafTopics.map((topic) => <option key={topic.key} value={topic.key}>{topic.label}</option>)}
                          </select>
                          <button type="button" onClick={() => removeTask(category.key, taskIndex)} aria-label={`Remove task "${task.text}"`}>
                            ×
                          </button>
                        </li>
                      )})}
                    </ol>
                  )}
                </article>
              ))}
            </div>

            <button type="button" className="a02-manual-add-category" onClick={() => setCategories((current) => [...current, newCategory()])}>
              + Add another subject
            </button>

            {error && (
              <p className="a02-onboarding-error" role="alert">
                {error}
              </p>
            )}
            <div className="a02-onboarding-actions">
              <Link href="/architecture-02/onboarding">← Back</Link>
              <button type="button" className="a02-onboarding-primary" disabled={!canSubmit || submitting} onClick={() => void submit()}>
                {submitting ? "Saving…" : "Create my route"} <i>↗</i>
              </button>
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}
