// Onboarding plan generation (docs/architecture/api.md §2): Route Handler ->
// Anthropic API, streamed. Holds ANTHROPIC_API_KEY server-side only -- never
// exposed to the browser (split-plan §1: any Route Handler holding an
// Anthropic key is M's, never J's).
//
// Contract (documented in api.md §2 -- read that before changing this):
//   POST /api/onboarding/plan
//   body: OnboardingAnswers (see lib/plan-generation/types.ts)
//   response: 200 `application/x-ndjson`, one JSON object per line:
//     {"type":"delta","text":string}      -- raw text chunks from the model,
//                                             for a live "building your
//                                             plan..." loading state
//     {"type":"done","usedFallback":bool,"plan":{"planId","appName",
//       "goalLine","categories":[{"id","name","label"}]}}
//     {"type":"error","message":string}   -- only when generation AND the
//                                             static fallback both failed to
//                                             persist; onboarding has nothing
//                                             usable to show
//   400/401 (plain JSON `{"error"}`, not streamed) for a malformed request or
//   no authenticated session -- nothing has been generated yet at that point.
//
// Failure contract (api.md §2 + CLAUDE.md's "never block the core loop"):
// if the Anthropic call fails, times out, or returns something that doesn't
// parse into a valid plan, this falls back to a static starter plan
// (lib/plan-generation/fallback.ts) and still returns a usable "done" event
// with usedFallback: true -- onboarding must never dead-end a new user.

import { createClient } from "@/lib/supabase/server";
import { generateGoalPlan } from "@/lib/ai/service";
import { buildPlanPrompt } from "@/lib/plan-generation/prompt";
import { parseGeneratedPlan } from "@/lib/plan-generation/parse";
import { buildFallbackPlan } from "@/lib/plan-generation/fallback";
import { persistGeneratedPlan } from "@/lib/plan-generation/persist";
import { PlanGenerationError, type OnboardingAnswers } from "@/lib/plan-generation/types";
import { recordEvent } from "@/lib/analytics/record-event";

// This route calls an external streaming API and writes to Postgres -- give
// it real headroom rather than the platform default.
export const maxDuration = 60;

function isValidAnswers(body: unknown): body is OnboardingAnswers {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.goalLine !== "string" || !b.goalLine.trim()) return false;
  if (!Array.isArray(b.focusAreas) || !b.focusAreas.every((f) => typeof f === "string")) {
    return false;
  }
  if (b.focusAreas.length < 1 || b.focusAreas.length > 6) return false;
  if (!["beginner", "intermediate", "advanced"].includes(b.experienceLevel as string)) {
    return false;
  }
  if (
    !Array.isArray(b.weeklyDaysAvailable) ||
    b.weeklyDaysAvailable.length === 0 ||
    !b.weeklyDaysAvailable.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)
  ) {
    return false;
  }
  if (b.appName !== undefined && typeof b.appName !== "string") return false;
  if (b.notes !== undefined && typeof b.notes !== "string") return false;
  return true;
}

function ndjson(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (!isValidAnswers(body)) {
    return Response.json(
      {
        error:
          "Invalid onboarding answers -- expected goalLine (string), focusAreas (1-6 strings), " +
          "experienceLevel ('beginner'|'intermediate'|'advanced'), weeklyDaysAvailable (ints 0-6).",
      },
      { status: 400 },
    );
  }
  const answers = body;

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "No authenticated session." }, { status: 401 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullText = "";
      let usedFallback = false;

      try {
        // The prompt asks for the rich object form (3-5 focus_points, 2-3
        // questions, mistakes/tips/mental_models) across up to 6 categories
        // and up to 14 curriculum slots each -- a compliant response
        // routinely runs past 8000 tokens. Too low a cap here doesn't error,
        // it truncates mid-JSON, parseGeneratedPlan throws, and the route
        // silently falls back to the generic static plan -- the AI
        // personalization feature would just never fire for real multi-
        // subject plans. 16000 (lib/ai/service.ts's generateGoalPlan) gives
        // real headroom without approaching claude-sonnet-5's output ceiling.
        //
        // signal: request.signal ties generation to the request's own
        // lifecycle -- if the client disconnects (tab closed, navigated
        // away), the provider call is cancelled instead of running (and
        // billing) for up to maxDuration with nowhere for its output to go.
        fullText = await generateGoalPlan({
          onDelta: (delta) => controller.enqueue(ndjson({ type: "delta", text: delta })),
          prompt: buildPlanPrompt(answers),
          signal: request.signal,
        });
      } catch (err) {
        if (request.signal.aborted) {
          // The client disconnected -- there's no one left to stream a
          // fallback to, and the ReadableStream is being torn down anyway.
          return;
        }
        // The configured provider (and its Anthropic fallback, per
        // lib/ai/service.ts) both failed (network, auth, rate limit,
        // timeout). Don't surface this to the client as an error yet --
        // fall back below.
        console.error("[onboarding/plan] AI provider call failed:", err);
        fullText = "";
      }

      let plan;
      try {
        if (!fullText) {
          throw new PlanGenerationError("Empty response from the model.");
        }
        plan = parseGeneratedPlan(fullText);
      } catch (err) {
        console.error("[onboarding/plan] falling back to the static plan:", err);
        usedFallback = true;
        plan = buildFallbackPlan(answers);
      }

      try {
        const persisted = await persistGeneratedPlan(supabase, user.id, plan);
        // plan_generated (schema.md §4): fired once, right after the plan
        // that's actually going to be shown to the user is durably persisted
        // -- not before, so a persist failure that falls through to the
        // catch block below doesn't double-count. goal_created is
        // deliberately NOT also fired here: onboarding creates exactly one
        // plan per user at this moment, so goal_created and plan_generated
        // would be two names for the identical fact (schema.md §4 rule 1 --
        // don't create a second, divergeable source of truth). goal_created
        // is reserved for a future distinct "add/create a goal" flow that
        // isn't AI plan generation (e.g. a manual goal editor); wire it there
        // instead of here when that flow exists.
        // Awaited, not fire-and-forget: this Route Handler can be a
        // serverless function instance that's frozen/torn down as soon as
        // controller.close() runs and the response finishes -- a `void`
        // call here would race that teardown and could silently drop the
        // very event this code exists to record.
        await recordEvent(supabase, "plan_generated", {
          usedFallback,
          categoryCount: persisted.categories.length,
        });
        controller.enqueue(
          ndjson({
            type: "done",
            usedFallback,
            plan: persisted,
          }),
        );
      } catch (persistErr) {
        console.error("[onboarding/plan] failed to persist generated plan:", persistErr);
        if (!usedFallback) {
          // The generated plan failed to persist for a reason unrelated to
          // generation itself (e.g. a transient DB error) -- try the static
          // fallback once before giving up entirely.
          try {
            const fallbackPlan = buildFallbackPlan(answers);
            const persisted = await persistGeneratedPlan(supabase, user.id, fallbackPlan);
            await recordEvent(supabase, "plan_generated", {
              usedFallback: true,
              categoryCount: persisted.categories.length,
            });
            controller.enqueue(
              ndjson({ type: "done", usedFallback: true, plan: persisted }),
            );
            controller.close();
            return;
          } catch (fallbackErr) {
            console.error("[onboarding/plan] fallback plan also failed to persist:", fallbackErr);
          }
        }
        controller.enqueue(
          ndjson({
            type: "error",
            message: "Couldn't save a plan. Please try again.",
          }),
        );
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
