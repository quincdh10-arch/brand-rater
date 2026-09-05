const rateLimitStore = new Map();

/*
  Brand Rater V2 — Brand Action Plan Generator
  ------------------------------------------------------------
  Purpose:
  - Accept an already-completed Brand Rater V2 assessment.
  - Reuse the assessment evidence, scores, diagnosis, gap, pattern,
    priority, and diagnostics.
  - Generate a practical paid-style Brand Action Plan WITHOUT
    re-analyzing images.

  Current phase:
  - Internal/testing endpoint.
  - No Stripe verification yet.
  - Lightweight IP rate limit included to control accidental abuse.

  Environment variables:
  - OPENAI_API_KEY
  - OPENAI_ACTION_PLAN_MODEL (optional)
*/

const ACTION_PLAN_MODEL =
  process.env.OPENAI_ACTION_PLAN_MODEL ||
  "gpt-4.1-mini";

const ACTION_PLAN_VERSION = "1.0.0";

/* =========================================================
   HELPERS
========================================================= */

function getClientIp(event) {
  return (
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["client-ip"] ||
    event.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const maxRequests = 5;

  const record =
    rateLimitStore.get(ip) || {
      count: 0,
      resetAt: now + windowMs,
    };

  if (now > record.resetAt) {
    rateLimitStore.set(ip, {
      count: 1,
      resetAt: now + windowMs,
    });

    return true;
  }

  if (record.count >= maxRequests) {
    return false;
  }

  record.count += 1;
  rateLimitStore.set(ip, record);

  return true;
}

function cleanString(value) {
  return String(value || "").trim();
}

function normalizeBusiness(input) {
  const business =
    input && typeof input === "object"
      ? input
      : {};

  return {
    name: cleanString(business.name),
    website: cleanString(business.website),
    description: cleanString(business.description),
    audience: cleanString(business.audience),
    yearsInBusiness: cleanString(business.yearsInBusiness),
    teamSize: cleanString(business.teamSize),
    traction: cleanString(business.traction),
    brandConcern: cleanString(business.brandConcern),
    twelveMonthGoal: cleanString(business.twelveMonthGoal),
  };
}

function validateAssessment(assessment) {
  if (!assessment || typeof assessment !== "object") {
    return "A Brand Rater assessment is required.";
  }

  if (
    !assessment.brandHealth ||
    typeof assessment.brandHealth.score !== "number"
  ) {
    return "The assessment is missing Brand Health data.";
  }

  if (!Array.isArray(assessment.categories)) {
    return "The assessment is missing category scores.";
  }

  if (!assessment.diagnostics) {
    return "The assessment is missing diagnostics required to build the Action Plan.";
  }

  return null;
}

function compactAssessment(assessment) {
  const diagnostics = assessment.diagnostics || {};
  const rubric = diagnostics.categoryRubric || {};

  const categories =
    Array.isArray(assessment.categories)
      ? assessment.categories.map(category => ({
          id: category.id,
          name: category.name,
          score: category.score,
          confidence: category.confidence,
          summary: category.summary,
          subcriteria:
            Array.isArray(rubric?.[category.id]?.subcriteria)
              ? rubric[category.id].subcriteria.map(item => ({
                  id: item.id,
                  name: item.name,
                  score: item.score,
                  assessed: item.assessed,
                  confidence: item.confidence,
                  evidence: item.evidence,
                  reasoning: item.reasoning,
                  businessImpact: item.businessImpact,
                  priorityScore: item.priorityScore,
                }))
              : [],
        }))
      : [];

  return {
    version: assessment.version,
    brandHealth: assessment.brandHealth,
    brandPattern: assessment.brandPattern,
    brandGap: assessment.brandGap,
    categories,
    biggestStrength: assessment.biggestStrength,
    biggestOpportunity: assessment.biggestOpportunity,
    evidence: assessment.evidence,
    freeRecommendation: assessment.freeRecommendation,
    diagnostics: {
      businessMaturity: diagnostics.businessMaturity,
      businessSignals: diagnostics.businessSignals,
      priority: diagnostics.priority,
      strongestSignal: diagnostics.strongestSignal,
    },
  };
}

/* =========================================================
   STRUCTURED OUTPUT SCHEMA
========================================================= */

const PRIORITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "whyItMatters",
    "whatToDo",
    "expectedImpact",
    "effort",
    "investment",
    "bestOwner",
    "evidence",
  ],
  properties: {
    title: { type: "string" },
    whyItMatters: { type: "string" },
    whatToDo: { type: "string" },
    expectedImpact: { type: "string" },
    effort: {
      type: "string",
      enum: ["Easy", "Moderate", "Significant"],
    },
    investment: {
      type: "string",
      enum: ["$", "$$", "$$$"],
    },
    bestOwner: {
      type: "string",
      enum: ["DIY", "Freelancer", "Professional"],
    },
    evidence: { type: "string" },
  },
};

const QUICK_WIN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "action",
    "why",
  ],
  properties: {
    title: { type: "string" },
    action: { type: "string" },
    why: { type: "string" },
  },
};

const ROADMAP_PHASE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "focus",
    "actions",
    "successSignal",
  ],
  properties: {
    focus: { type: "string" },
    actions: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: { type: "string" },
    },
    successSignal: { type: "string" },
  },
};

const ACTION_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "executiveSummary",
    "diagnosis",
    "fixFirst",
    "fixNext",
    "quickWins",
    "dontPrioritize",
    "budgetGuidance",
    "roadmap",
    "closingAdvice",
  ],
  properties: {
    executiveSummary: {
      type: "string",
    },

    diagnosis: {
      type: "object",
      additionalProperties: false,
      required: [
        "headline",
        "summary",
        "whyNow",
      ],
      properties: {
        headline: { type: "string" },
        summary: { type: "string" },
        whyNow: { type: "string" },
      },
    },

    fixFirst: PRIORITY_SCHEMA,
    fixNext: PRIORITY_SCHEMA,

    quickWins: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: QUICK_WIN_SCHEMA,
    },

    dontPrioritize: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "reason",
        "revisitWhen",
      ],
      properties: {
        title: { type: "string" },
        reason: { type: "string" },
        revisitWhen: { type: "string" },
      },
    },

    budgetGuidance: {
      type: "object",
      additionalProperties: false,
      required: [
        "nextDollar",
        "diy",
        "freelancer",
        "professional",
      ],
      properties: {
        nextDollar: { type: "string" },
        diy: { type: "string" },
        freelancer: { type: "string" },
        professional: { type: "string" },
      },
    },

    roadmap: {
      type: "object",
      additionalProperties: false,
      required: [
        "days1to30",
        "days31to60",
        "days61to90",
      ],
      properties: {
        days1to30: ROADMAP_PHASE_SCHEMA,
        days31to60: ROADMAP_PHASE_SCHEMA,
        days61to90: ROADMAP_PHASE_SCHEMA,
      },
    },

    closingAdvice: {
      type: "string",
    },
  },
};

/* =========================================================
   OPENAI
========================================================= */

function extractOutputText(data) {
  if (typeof data.output_text === "string") {
    return data.output_text.trim();
  }

  if (!Array.isArray(data.output)) {
    return "";
  }

  return data.output
    .flatMap(item =>
      Array.isArray(item.content)
        ? item.content
        : []
    )
    .map(content =>
      typeof content.text === "string"
        ? content.text
        : ""
    )
    .join("")
    .trim();
}

async function generateActionPlan({
  business,
  assessment,
}) {
  const prompt = `
You are the Brand Action Plan strategist for Brand Rater by Milky Minds Creative.

Your role is to turn an EXISTING Brand Rater assessment into a practical 90-day action plan for a founder or small marketing team.

IMPORTANT: You are NOT re-scoring the brand and you are NOT analyzing new images.
The assessment below is the source of truth.

BUSINESS CONTEXT
${JSON.stringify(business, null, 2)}

VERIFIED BRAND RATER ASSESSMENT
${JSON.stringify(assessment, null, 2)}

CORE PRODUCT PROMISE
The customer should finish this report knowing:
- what is actually holding the brand back,
- what to fix first,
- what to fix next,
- what they can improve quickly,
- what NOT to spend money on yet,
- where their next dollar should go,
- and what to do over the next 90 days.

NON-NEGOTIABLE RULES
1. Treat Brand Rater scores, category scores, Brand Pattern, Brand Gap, maturity, priority, and observed evidence as fixed facts. Do not change them.
2. Never claim the live website was inspected unless the assessment explicitly contains evidence from it.
3. Never invent reviews, revenue, customer counts, locations, awards, services, competitors, or performance metrics.
4. Every major recommendation must connect to evidence contained in the assessment.
5. Do not recommend a full rebrand unless the evidence clearly demonstrates that the current identity/system is itself the primary strategic problem.
6. Be willing to say the logo is NOT the problem when another issue deserves investment first.
7. Fix First and Fix Next must be meaningfully different priorities.
8. Quick Wins must be achievable within roughly one week and should generally require little or no outside spend.
9. Don't Prioritize must identify a plausible brand expense or project the customer should delay—not a trivial task.
10. Budget guidance must distinguish what the owner can DIY, what a freelancer could handle, and what deserves professional strategy/design support.
11. The 90-day roadmap must sequence the work; do not repeat the same recommendation in all three phases.
12. Use founder-friendly language. Avoid unexplained branding jargon.
13. Be decisive. Do not bury recommendations in caveats.
14. Keep this valuable enough to justify a paid $39 report, but do not turn it into a full agency scope of work.

EFFORT
- Easy: can usually be completed quickly with limited coordination.
- Moderate: requires planning, rewriting, design refinement, or several touchpoints.
- Significant: requires strategic decisions, system changes, or professional support.

INVESTMENT
- $: mostly DIY / minimal spend.
- $$: likely freelancer or focused professional help.
- $$$: meaningful strategic/design investment.

BEST OWNER
- DIY: reasonable for the founder/team to execute themselves.
- Freelancer: execution help is useful but senior strategic direction is not essential.
- Professional: strategy, positioning, identity systems, complex web/brand work, or high-stakes decisions need experienced support.

Write concise but specific recommendations. The report should feel like a strategist looked at THIS business, not like a generic branding checklist.

Return only the structured JSON required by the supplied schema.
`;

  const response =
    await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ACTION_PLAN_MODEL,
          store: false,
          max_output_tokens: 3500,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: prompt,
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "brand_action_plan_v1",
              strict: true,
              schema: ACTION_PLAN_SCHEMA,
            },
          },
        }),
      }
    );

  const raw = await response.text();

  let data;

  try {
    data = JSON.parse(raw);
  }
  catch {
    throw new Error(
      `OpenAI returned a non-JSON API response (${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
      `OpenAI API error (${response.status}).`
    );
  }

  const outputText =
    extractOutputText(data);

  if (!outputText) {
    throw new Error(
      "OpenAI returned no usable Action Plan output."
    );
  }

  try {
    return JSON.parse(outputText);
  }
  catch {
    throw new Error(
      "The generated Action Plan could not be parsed."
    );
  }
}

/* =========================================================
   HANDLER
========================================================= */

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        success: true,
        version: ACTION_PLAN_VERSION,
        message:
          "Brand Action Plan generator is ready. POST an existing Brand Rater assessment and business context.",
      }),
    };
  }

  try {
    let body;

    try {
      body = JSON.parse(event.body || "{}");
    }
    catch {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "The request body was not valid JSON.",
        }),
      };
    }

    if (!process.env.OPENAI_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "OPENAI_API_KEY is missing from Netlify.",
        }),
      };
    }

    const validationError =
      validateAssessment(body.assessment);

    if (validationError) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: validationError,
        }),
      };
    }

    const ip = getClientIp(event);

    if (!checkRateLimit(ip)) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          error:
            "Too many Action Plan requests. Please try again later.",
        }),
      };
    }

    const business =
      normalizeBusiness(body.business);

    const assessment =
      compactAssessment(body.assessment);

    const generated =
      await generateActionPlan({
        business,
        assessment,
      });

    const result = {
      version: ACTION_PLAN_VERSION,
      generatedAt:
        new Date().toISOString(),

      sourceAssessment: {
        scoringVersion:
          assessment.version || "2.0.0",

        brandHealth:
          assessment.brandHealth,

        brandPattern:
          assessment.brandPattern,

        brandGap:
          assessment.brandGap,
      },

      business: {
        name: business.name,

        twelveMonthGoal:
          business.twelveMonthGoal,

        brandConcern:
          business.brandConcern,
      },

      ...generated,

      meta: {
        model: ACTION_PLAN_MODEL,

        generatorVersion:
          ACTION_PLAN_VERSION,
      },
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify(result),
    };
  }
  catch (error) {
    console.error(
      "Brand Action Plan error:",
      error
    );

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        error:
          error.message ||
          "Something went wrong generating the Brand Action Plan.",
      }),
    };
  }
};
