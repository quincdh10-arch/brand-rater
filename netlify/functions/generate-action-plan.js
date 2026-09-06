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

const ACTION_PLAN_VERSION = "1.4.0";

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
   RECOMMENDATION GUARDRAILS
========================================================= */

function buildRecommendationGuardrails(assessment) {
  const categories =
    Array.isArray(assessment.categories)
      ? assessment.categories
      : [];

  const primaryPriority =
    assessment.diagnostics?.priority || null;

  const primaryCategoryId =
    primaryPriority?.categoryId ||
    primaryPriority?.category ||
    "";

  const categoryRanking =
    categories
      .map(category => ({
        id: category.id,
        name: category.name,
        score:
          typeof category.score === "number"
            ? category.score
            : null,
        confidence:
          category.confidence || "unknown",
      }))
      .filter(category =>
        typeof category.score === "number"
      )
      .sort(
        (a, b) =>
          a.score - b.score
      );

  const secondaryCategoryPreference =
    categoryRanking
      .filter(category =>
        category.id !== primaryCategoryId &&
        category.score < 75
      )
      .slice(0, 3);

  /*
    If every non-primary category is already strong, still provide
    the lowest-scoring alternatives. This gives the model context
    without forcing it to invent a weakness in a strong category.
  */
  const secondaryFallback =
    secondaryCategoryPreference.length
      ? []
      : categoryRanking
          .filter(category =>
            category.id !== primaryCategoryId
          )
          .slice(0, 2);

  const strongCategories =
    categoryRanking
      .filter(category =>
        category.score >= 75
      );

  const weakObservedSubcriteria =
    categories
      .flatMap(category =>
        Array.isArray(category.subcriteria)
          ? category.subcriteria.map(item => ({
              categoryId: category.id,
              categoryName: category.name,
              criterionId: item.id,
              criterionName: item.name,
              score:
                typeof item.score === "number"
                  ? item.score
                  : null,
              confidence:
                item.confidence || "unknown",
              assessed:
                Boolean(item.assessed),
              evidence:
                item.evidence || "",
              businessImpact:
                item.businessImpact || "",
              priorityScore:
                typeof item.priorityScore === "number"
                  ? item.priorityScore
                  : null,
            }))
          : []
      )
      .filter(item =>
        item.assessed &&
        typeof item.score === "number" &&
        item.score <= 3
      )
      .sort((a, b) => {
        const priorityA =
          typeof a.priorityScore === "number"
            ? a.priorityScore
            : -1;

        const priorityB =
          typeof b.priorityScore === "number"
            ? b.priorityScore
            : -1;

        if (priorityA !== priorityB) {
          return priorityB - priorityA;
        }

        return a.score - b.score;
      })
      .slice(0, 10);

  return {
    primaryPriority,
    primaryCategoryId,
    categoryRanking,
    secondaryCategoryPreference,
    secondaryFallback,
    strongCategories,
    weakObservedSubcriteria,
    thresholds: {
      strongCategoryScore: 75,
      weakSubcriterionMaxScore: 3,
    },
  };
}

function getBusinessMaturityScore(assessment) {
  const maturity =
    assessment.diagnostics?.businessMaturity;

  if (typeof maturity === "number") {
    return maturity;
  }

  if (
    maturity &&
    typeof maturity === "object"
  ) {
    const candidates = [
      maturity.score,
      maturity.total,
      maturity.value,
      maturity.businessMaturityScore,
    ];

    const match =
      candidates.find(value =>
        typeof value === "number"
      );

    if (typeof match === "number") {
      return match;
    }
  }

  return null;
}

function buildStrategicDecisionContext({
  business,
  assessment,
  recommendationGuardrails,
}) {
  const categories =
    Array.isArray(assessment.categories)
      ? assessment.categories
      : [];

  const primaryCategory =
    categories.find(category =>
      category.id ===
      recommendationGuardrails.primaryCategoryId
    ) || null;

  const strategicText =
    [
      recommendationGuardrails.primaryPriority,
      assessment.biggestOpportunity,
      assessment.freeRecommendation,
      primaryCategory,
    ]
      .map(value =>
        typeof value === "string"
          ? value
          : JSON.stringify(value || {})
      )
      .join(" ")
      .toLowerCase();

  const positioningLed =
    /position|differentiat|value proposition|brand strategy|strategic direction|ownable|distinctive messaging/.test(
      strategicText
    );

  const maturityScore =
    getBusinessMaturityScore(
      assessment
    );

  const traction =
    cleanString(
      business.traction
    ).toLowerCase();

  const yearsInBusiness =
    cleanString(
      business.yearsInBusiness
    ).toLowerCase();

  const teamSize =
    cleanString(
      business.teamSize
    ).toLowerCase();

  const goal =
    cleanString(
      business.twelveMonthGoal
    ).toLowerCase();

  const establishedByContext =
    [
      "established",
      "mature",
    ].some(term =>
      traction.includes(term)
    ) ||
    /4-7|8\+|8-plus|8 plus|8 or more/.test(
      yearsInBusiness
    ) ||
    /6-10|11-25|25\+|25-plus/.test(
      teamSize
    );

  const growthGoal =
    /grow|growth|larger|higher-value|higher value|upmarket|expand|expansion|increase|premium|enterprise|new market|new location|more clients|bigger clients|average project|average engagement/.test(
      goal
    );

  const highStakesStrategicDecision =
    positioningLed &&
    (
      establishedByContext ||
      growthGoal ||
      (
        typeof maturityScore === "number" &&
        maturityScore >= 60
      )
    );

  let supportBias =
    "No special support bias. Match the recommendation to the actual complexity of the work.";

  if (highStakesStrategicDecision) {
    supportBias =
      "Professional is strongly preferred for the foundational strategic decision. DIY may support research and preparation, and a freelancer may support execution after the strategic direction is established.";
  }
  else if (positioningLed) {
    supportBias =
      "Treat this as a strategic decision, not merely a copywriting task. Prefer Professional when uncertainty or business consequences are meaningful; use DIY only when the positioning decision is already substantially clear.";
  }

  return {
    positioningLed,
    maturityScore,
    establishedByContext,
    growthGoal,
    highStakesStrategicDecision,
    supportBias,
    sequencingPrinciple:
      positioningLed
        ? "Strategy -> Expression -> Proof/Application. Fix Next should usually make the positioning usable in customer-facing messaging before adding unrelated secondary tactics."
        : "Foundation -> Next dependent capability -> Apply/Test. Strategic dependency outranks simply choosing the next-lowest category.",
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
    title: {
      type: "string",
    },

    whyItMatters: {
      type: "string",
    },

    whatToDo: {
      type: "string",
    },

    expectedImpact: {
      type: "string",
    },

    effort: {
      type: "string",
      enum: [
        "Easy",
        "Moderate",
        "Significant",
      ],
    },

    investment: {
      type: "string",
      enum: [
        "$",
        "$$",
        "$$$",
      ],
    },

    bestOwner: {
      type: "string",
      enum: [
        "DIY",
        "Freelancer",
        "Professional",
      ],
    },

    evidence: {
      type: "string",
    },
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
    title: {
      type: "string",
    },

    action: {
      type: "string",
    },

    why: {
      type: "string",
    },
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
    focus: {
      type: "string",
    },

    actions: {
      type: "array",
      minItems: 2,
      maxItems: 4,

      items: {
        type: "string",
      },
    },

    successSignal: {
      type: "string",
    },
  },
};

const ACTION_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,

  required: [
    "actionPlanTheme",
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
    actionPlanTheme: {
      type: "string",
    },

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
        headline: {
          type: "string",
        },

        summary: {
          type: "string",
        },

        whyNow: {
          type: "string",
        },
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
        title: {
          type: "string",
        },

        reason: {
          type: "string",
        },

        revisitWhen: {
          type: "string",
        },
      },
    },

    budgetGuidance: {
      type: "object",
      additionalProperties: false,

      required: [
        "recommendedPath",
        "recommendedReason",
        "nextDollar",
        "diy",
        "freelancer",
        "professional",
      ],

      properties: {
        recommendedPath: {
          type: "string",

          enum: [
            "DIY",
            "Freelancer",
            "Professional",
          ],
        },

        recommendedReason: {
          type: "string",
        },

        nextDollar: {
          type: "string",
        },

        diy: {
          type: "string",
        },

        freelancer: {
          type: "string",
        },

        professional: {
          type: "string",
        },
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
        days1to30:
          ROADMAP_PHASE_SCHEMA,

        days31to60:
          ROADMAP_PHASE_SCHEMA,

        days61to90:
          ROADMAP_PHASE_SCHEMA,
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
  const recommendationGuardrails =
    buildRecommendationGuardrails(
      assessment
    );

  const strategicDecisionContext =
    buildStrategicDecisionContext({
      business,
      assessment,
      recommendationGuardrails,
    });

  const prompt = `
You are the Brand Action Plan strategist for Brand Rater by Milky Minds Creative.

Your role is to turn an EXISTING Brand Rater assessment into a practical 90-day action plan for a founder or small marketing team.

IMPORTANT:
You are NOT re-scoring the brand and you are NOT analyzing new images.
The assessment below is the source of truth.

BUSINESS CONTEXT
${JSON.stringify(business, null, 2)}

VERIFIED BRAND RATER ASSESSMENT
${JSON.stringify(assessment, null, 2)}

RECOMMENDATION GUARDRAILS
${JSON.stringify(recommendationGuardrails, null, 2)}

STRATEGIC DECISION CONTEXT
${JSON.stringify(strategicDecisionContext, null, 2)}

CORE PRODUCT PROMISE

The customer should finish this report knowing:

- the single strategic theme that should guide the next 90 days,
- what is actually holding the brand back,
- what to fix first,
- what to fix next,
- what they can improve quickly,
- what NOT to spend money on yet,
- where their next dollar should go,
- and what to do over the next 90 days.

NON-NEGOTIABLE RULES

1. Treat Brand Rater scores, category scores, Brand Pattern, Brand Gap,
maturity, priority, and observed evidence as fixed facts.

Do not change or reinterpret them.

2. Never claim the live website was inspected unless the assessment
explicitly contains evidence from it.

3. Never invent reviews, revenue, customer counts, locations, awards,
services, competitors, visual details, or performance metrics.

4. Every major recommendation must connect to specific evidence
contained in the assessment whenever that evidence exists.

5. Recommendations must answer four questions:

- What should change?
- Where should it change?
- Why does it matter?
- What should the business owner actually do?

6. Avoid recommendations that could apply to almost any small business.

Prefer concrete references to observed:

- typography,
- color usage,
- CTA phrasing,
- contact information,
- logo placement,
- messaging hierarchy,
- trust proof,
- imagery,
- or other supplied evidence.

7. Do not recommend a full rebrand unless the evidence clearly
demonstrates that the current identity/system is itself the primary
strategic problem.

8. Be willing to say the logo is NOT the problem when another issue
deserves investment first.

9. FIX FIRST must be the single highest-leverage improvement based on:

- the existing priority,
- Brand Gap,
- business goal,
- and observed evidence.

10. FIX NEXT must solve a meaningfully different problem from FIX FIRST.

Do not split one recommendation into two differently worded versions.

11. QUICK WINS must be genuinely quick.

Every Quick Win should:

- describe ONE concrete action,
- require little or no spending,
- generally take approximately 30–90 minutes,
- be possible within one week,
- and not require a full redesign, strategy project, or outside
  discovery process.

12. Good Quick Win scope includes things like:

- standardizing one CTA phrase,
- creating one contact-information format,
- defining one logo placement rule,
- rewriting one headline,
- selecting one consistent typography treatment.

Only recommend these when supported by the assessment.

13. DON'T PRIORITIZE must identify a realistic brand expense, project,
or activity the customer might otherwise spend money on.

Explain why delaying it is strategically smarter right now.

Do not choose a trivial task.

When supported by the assessment, be willing to explicitly say things
such as:

- "Your logo is not the problem."
- "A full rebrand is not the best use of your next dollar."
- "Do not rebuild the website yet."

14. BUDGET GUIDANCE must make a decision, not simply present options.

Choose exactly ONE recommendedPath:

- DIY
- Freelancer
- Professional

Then explain why that path best fits the current highest-priority
problem.

15. The customer should finish Budget Guidance knowing:

- what level of help to pay for right now,
- what they can reasonably DIY,
- what a freelancer could execute,
- and what would justify professional strategic support.

16. THE 90-DAY ROADMAP MUST HAVE THREE DISTINCT JOBS.

Do not repeat essentially the same recommendation across all three
phases.

17. DAYS 1–30 = FIX THE FOUNDATION.

Resolve the highest-priority foundational issue.

Keep the focus narrow rather than trying to solve every brand problem
at once.

18. DAYS 31–60 = BUILD ON THE FOUNDATION.

Use the improved foundation to strengthen the next strategic issue.

Examples may include:

- messaging,
- credibility,
- recognition,
- differentiation,
- customer proof,
- or another issue supported by the assessment.

19. DAYS 61–90 = APPLY, TEST, AND REVIEW.

Roll the improvements across relevant customer-facing materials.

Check consistency.

Gather useful feedback where appropriate.

Identify the next brand decision based on what has been improved.

20. Each roadmap phase must contain:

- one clear focus,
- 2–4 concrete actions,
- and one observable success signal.

21. Use founder-friendly language.

Avoid unexplained branding jargon, consultant filler, and generic AI
phrasing.

22. Be decisive.

Prioritize decisions over education.

Tell the customer what to do and what not to do.

23. Keep this valuable enough to justify a paid $39 report, but do not
turn it into a full agency scope of work.

24. The finished report should feel valuable because it saves the
business owner from spending time or money on the wrong problem.

25. Create an actionPlanTheme: one short strategic sentence that acts
as the thesis for the entire report.

The theme should:

- be specific to the diagnosis,
- express a clear strategic tradeoff or sequence,
- be no more than roughly 12 words,
- avoid scores, jargon, and generic encouragement,
- and make the rest of the report feel like one coherent plan.

GOOD EXAMPLES:

- "Build consistency before investing in a bigger redesign."
- "Clarify the message before expanding the visual identity."
- "Strengthen trust before spending more on acquisition."
- "Turn strong visuals into a more distinctive, ownable brand."

Do not copy these examples unless they genuinely fit the assessment.

26. Avoid unnecessary repetition across sections.

The core priority may appear throughout the report, but each section
must do a different job:

- actionPlanTheme = the strategic thesis.
- executiveSummary = the situation and overall direction.
- diagnosis = what is wrong and why it matters.
- Fix First = the first project to execute.
- Fix Next = the second distinct problem to address.
- Quick Wins = immediate small actions, not restatements of Fix First.
- Budget Guidance = the spending decision.
- Roadmap = sequencing and rollout.

Do not repeatedly restate the same typography, color, messaging, or
credibility observation using slightly different words.

27. DAYS 1–30 should define the smallest useful foundation, not an
oversized brand-system project.

When the priority involves visual consistency, prefer a minimum viable
brand guide or compact working standard over a full brand guideline
project unless the assessment clearly supports greater scope.

A minimum viable guide may include only what is necessary to execute
consistently, such as:

- primary and secondary type choices,
- a limited color palette,
- basic logo-use rules,
- simple CTA or messaging conventions,
- and the highest-priority customer-facing examples.

28. Success Signals must be observable and practical.

Avoid vague success signals such as:

- "the brand feels stronger,"
- "customers trust the business more,"

unless the report identifies a concrete observable indicator.

Prefer signals such as:

- priority materials use the same type and color rules,
- the same CTA appears across selected touchpoints,
- testimonial/proof content is present in agreed locations,
- updated materials pass a simple consistency review,
- or customer-facing copy clearly communicates the selected value
  proposition.

29. FIX NEXT must respect category weakness, business relevance, AND
strategic dependency.

Use the RECOMMENDATION GUARDRAILS and STRATEGIC DECISION CONTEXT above.

Category ranking is useful, but it is not the final decision rule.

Ask:
"What must become true after Fix First for the brand to actually benefit
from that work?"

Fix Next should usually be that next necessary capability.

In general:
- prefer a meaningfully different job from Fix First,
- prefer one of secondaryCategoryPreference when it is both supported
  AND logically follows Fix First,
- but do not choose a lower-scoring category merely because it is the
  next weakness on the list.

Strategic dependency outranks simple weakness ranking.

30. When FIX FIRST is POSITIONING, DIFFERENTIATION, VALUE PROPOSITION,
or another foundational strategy decision, use this default sequence:

STRATEGY -> EXPRESSION -> PROOF / APPLICATION

That usually means:

- Fix First defines the position, differentiator, value proposition,
  audience choice, or strategic promise.
- Fix Next translates that decision into distinctive customer-facing
  messaging, offer framing, case-study framing, sales language, or
  another expression of the new strategy.
- Proof, testimonials, case studies, broader rollout, and validation
  follow after the strategic direction can actually be communicated.

Do not jump directly from "define the positioning" to an unrelated
secondary weakness if the new positioning has not yet been expressed.

31. CUSTOMER PROOF is not automatically the next step after strategy.

Do not recommend testimonials, reviews, awards, guarantees, case
studies, or other credibility-building work simply because Credibility
is below another category.

Customer proof may become Fix Next only when:
- credibility or purchase confidence is itself the primary business
  barrier,
- the assessment explicitly identifies missing proof as a material
  reason customers may hesitate,
- AND adding proof does not skip a more necessary strategic dependency.

If the core problem is weak differentiation, first make the
differentiation clear enough to communicate. Then use proof to support
that differentiated position.

32. Do NOT create Fix Next from a category scoring 75 or higher merely
because that category offers an easy recommendation.

A strong category may become Fix Next only when:
- a specific assessed subcriterion inside it is genuinely weak,
- the assessment contains direct evidence for that weakness,
- fixing it clearly matters to the stated business goal,
- and it logically follows Fix First.

If no secondary weakness is strongly supported, deepen the next
business-relevant capability required to make Fix First successful
instead of inventing a new problem.

33. QUICK WINS must respect the same priority hierarchy as the main
recommendations.

At least TWO of the three Quick Wins should directly advance Fix First
or Fix Next.

The third may support another issue only when it is explicitly grounded
in assessment evidence.

Do not pull a Quick Win from a category scoring 75 or higher unless a
specific assessed subcriterion in that category is weak and the action
directly addresses that evidence.

34. The three Quick Wins must be meaningfully different micro-actions.

Do not create two Quick Wins that are simply different placements or
versions of the same idea.

For example:
- "Add the tagline to social profiles"
- and "Add the tagline beside the logo"

are too similar to count as two separate Quick Wins.

A better set would address three distinct immediate actions such as:
- one research or strategic-preparation action,
- one messaging/hierarchy action,
- and one evidence-supported implementation cleanup.

35. Examples in this prompt are NOT default recommendations.

Do not recommend:
- logo placement rules,
- typography rules,
- CTA changes,
- testimonials,
- social profile updates,
- or any other example

unless the assessment actually supports that action.

36. The RECOMMENDATION GUARDRAILS are decision support, not new scores.

Do not alter Brand Rater scoring based on them.

Use:
- primaryPriority to anchor Fix First,
- secondaryCategoryPreference as supporting context rather than an
  automatic Fix Next,
- strongCategories to avoid unnecessary work,
- and weakObservedSubcriteria to ground smaller recommendations.

37. RECOMMENDED PATH must reflect the TYPE OF DECISION, not merely the
amount of execution work.

Use STRATEGIC DECISION CONTEXT.

When highStakesStrategicDecision is true:
- strongly prefer Professional for the foundational strategic decision,
- especially when the business is established, is moving upmarket,
  wants larger/higher-value clients, is expanding, or needs an ownable
  market position,
- because a poor positioning decision affects future messaging, sales,
  marketing, case studies, and investment decisions.

Do NOT reduce a positioning problem to "some copy needs rewriting."

DIY may still be useful for:
- gathering customer/client feedback,
- documenting strongest outcomes,
- auditing competitor/category language,
- listing reasons customers choose the business,
- and preparing internal inputs.

Freelancer may still be useful for:
- copywriting,
- design refinement,
- implementation,
- and translating an already-decided strategy into materials.

Professional is appropriate for:
- choosing the positioning territory,
- deciding what the business should be known for,
- resolving competing audience/value-proposition choices,
- defining an ownable strategic promise,
- or another foundational decision where being wrong creates meaningful
  downstream cost.

When highStakesStrategicDecision is false, continue using the normal
DIY / Freelancer / Professional decision rules.

38. THE ROADMAP must follow dependencies, not category order.

For positioning-led plans, strongly prefer:

DAYS 1-30 = DEFINE
Make the strategic decision.

DAYS 31-60 = EXPRESS
Translate the decision into customer-facing messaging and selected
priority touchpoints.

DAYS 61-90 = PROVE, APPLY, TEST, AND REVIEW
Support the position with relevant proof, roll it out consistently,
and validate whether customers understand the intended difference.

For non-positioning plans, use:

FOUNDATION -> NEXT DEPENDENT CAPABILITY -> APPLY / TEST

Do not make Days 31-60 a disconnected cleanup project simply because
another category has a lower score.

SPECIFICITY STANDARD

BAD:

"Improve brand consistency."

BETTER:

"The supplied materials use inconsistent typography and color
treatments, so customers may not immediately recognize them as coming
from the same business."

BEST:

Name the specific customer-facing element that was observed and
explain exactly what should change, where it should change, and why
it matters.

Do not claim specificity that the assessment does not actually contain.

EFFORT

Easy:
Can usually be completed quickly with limited coordination.

Moderate:
Requires planning, rewriting, design refinement, or several touchpoints.

Significant:
Requires strategic decisions, system changes, or professional support.

INVESTMENT

$:
Mostly DIY / minimal spend.

$$:
Likely freelancer or focused professional help.

$$$:
Meaningful strategic/design investment.

BEST OWNER

DIY:
Reasonable for the founder/team to execute themselves.

Freelancer:
Execution help is useful but senior strategic direction is not
essential.

Professional:
Strategy, positioning, identity systems, complex web/brand work, or
high-stakes decisions need experienced support.

RECOMMENDED PATH DECISION

Choose exactly one recommendedPath for Budget Guidance.

Choose DIY when:

- the priority is narrow,
- the risk is relatively low,
- the required decision is already clear,
- and the owner/team can realistically execute it with direction.

Choose Freelancer when:

- the strategy is sufficiently clear,
- but focused design, writing, or implementation help would materially
  improve the result.

Choose Professional when:

- the business needs strategic positioning,
- the business must decide what it should be known for,
- differentiation or value proposition requires a foundational choice,
- a broader identity/system decision is required,
- a complex website or brand change is required,
- or another high-stakes decision where experienced senior guidance
  materially reduces risk.

When STRATEGIC DECISION CONTEXT says highStakesStrategicDecision is
true, Professional should be the default recommendation unless the
assessment clearly shows the strategic decision has already been made
and only execution remains.

Do not default to the most expensive option.

Match the recommendation to the actual complexity of the problem and
the evidence available.

BUDGET GUIDANCE OUTPUT

recommendedPath:
Choose exactly one of DIY, Freelancer, or Professional.

recommendedReason:
Explain in plain language why this is the right level of support for
the business right now.

nextDollar:
State specifically where the next incremental brand dollar should go.

diy:
Explain the portion of the current plan the owner/team can reasonably
execute themselves.

freelancer:
Explain what focused execution work would make sense to delegate to a
freelancer.

professional:
Explain what future condition or level of complexity would justify
hiring a senior brand strategist, agency, or other professional.

The three descriptions should NOT make all three choices sound equally
recommended.

QUICK WIN QUALITY CHECK

Before returning each Quick Win, mentally verify:

- Could the owner realistically start this today?
- Could it usually be completed in approximately 30–90 minutes?
- Does it require little or no spending?
- Is the action specific enough that the owner knows exactly what to
  change?
- Is it supported by the assessment?

If not, replace it with a smaller, more concrete action.

ROADMAP QUALITY CHECK

Before returning the roadmap, mentally verify:

- Is Days 1–30 the smallest useful foundation rather than an oversized
  system project?
- Does each phase have a different strategic job?
- Are success signals observable rather than subjective?

Then verify:

Days 1–30:
Are we fixing the foundation?

Days 31–60:
Are we building something new on top of that foundation?

Days 61–90:
Are we applying, testing, reviewing, or extending the work?

If two phases are essentially saying the same thing, rewrite them.

FINAL QUALITY CHECK

Before returning the report, verify:

- actionPlanTheme clearly expresses the strategic thesis in one short
  sentence.
- The same core issue is not redundantly repeated across every section.
- Fix First follows the assessment's primary priority.
- Fix Next is the next logical strategic dependency after Fix First,
  not merely the next-lowest scoring category.
- Fix Next comes from a genuinely relevant supported issue rather than
  a generic best practice.
- Fix Next does not unnecessarily target a category scoring 75+.
- If Fix First is positioning/differentiation, Fix Next usually
  expresses that strategy before introducing unrelated secondary work.
- Customer proof is recommended only when the assessment actually
  supports a credibility gap AND proof does not skip a more necessary
  strategic dependency.
- If highStakesStrategicDecision is true, Budget Guidance strongly
  prefers Professional unless only execution remains.
- At least two Quick Wins directly advance Fix First or Fix Next.
- The three Quick Wins are distinct from one another.
- No Quick Win was borrowed from a strong category without specific
  weak-subcriterion evidence.
- Major recommendations reference actual evidence where possible.
- Quick Wins are truly small.
- Don't Prioritize protects the customer from a plausible unnecessary
  expense.
- Budget Guidance clearly recommends one path.
- The 90-day roadmap progresses rather than repeats.
- The report sounds specific to THIS business.
- No unsupported facts have been invented.

Write concise but specific recommendations.

The report should feel like a strategist looked at THIS business, not
like a generic branding checklist.

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

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          model:
            ACTION_PLAN_MODEL,

          store:
            false,

          max_output_tokens:
            3500,

          input: [
            {
              role: "user",

              content: [
                {
                  type:
                    "input_text",

                  text:
                    prompt,
                },
              ],
            },
          ],

          text: {
            format: {
              type:
                "json_schema",

              name:
                "brand_action_plan_v1_4",

              strict:
                true,

              schema:
                ACTION_PLAN_SCHEMA,
            },
          },
        }),
      }
    );

  const raw =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(raw);
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
    return JSON.parse(
      outputText
    );
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

exports.handler =
  async function (event) {

    if (
      event.httpMethod !== "POST"
    ) {
      return {
        statusCode: 200,

        headers: {
          "Content-Type":
            "application/json",

          "Cache-Control":
            "no-store",
        },

        body:
          JSON.stringify({
            success: true,

            version:
              ACTION_PLAN_VERSION,

            message:
              "Brand Action Plan generator is ready. POST an existing Brand Rater assessment and business context.",
          }),
      };
    }

    try {
      let body;

      try {
        body =
          JSON.parse(
            event.body || "{}"
          );
      }
      catch {
        return {
          statusCode: 400,

          body:
            JSON.stringify({
              error:
                "The request body was not valid JSON.",
            }),
        };
      }

      if (
        !process.env.OPENAI_API_KEY
      ) {
        return {
          statusCode: 500,

          body:
            JSON.stringify({
              error:
                "OPENAI_API_KEY is missing from Netlify.",
            }),
        };
      }

      const validationError =
        validateAssessment(
          body.assessment
        );

      if (validationError) {
        return {
          statusCode: 400,

          body:
            JSON.stringify({
              error:
                validationError,
            }),
        };
      }

      const ip =
        getClientIp(event);

      if (
        !checkRateLimit(ip)
      ) {
        return {
          statusCode: 429,

          body:
            JSON.stringify({
              error:
                "Too many Action Plan requests. Please try again later.",
            }),
        };
      }

      const business =
        normalizeBusiness(
          body.business
        );

      const assessment =
        compactAssessment(
          body.assessment
        );

      const generated =
        await generateActionPlan({
          business,
          assessment,
        });

      const result = {
        version:
          ACTION_PLAN_VERSION,

        generatedAt:
          new Date()
            .toISOString(),

        sourceAssessment: {
          scoringVersion:
            assessment.version ||
            "2.0.0",

          brandHealth:
            assessment.brandHealth,

          brandPattern:
            assessment.brandPattern,

          brandGap:
            assessment.brandGap,
        },

        business: {
          name:
            business.name,

          twelveMonthGoal:
            business
              .twelveMonthGoal,

          brandConcern:
            business
              .brandConcern,
        },

        ...generated,

        meta: {
          model:
            ACTION_PLAN_MODEL,

          generatorVersion:
            ACTION_PLAN_VERSION,
        },
      };

      return {
        statusCode: 200,

        headers: {
          "Content-Type":
            "application/json",

          "Cache-Control":
            "no-store",
        },

        body:
          JSON.stringify(
            result
          ),
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
          "Content-Type":
            "application/json",

          "Cache-Control":
            "no-store",
        },

        body:
          JSON.stringify({
            error:
              error.message ||
              "Something went wrong generating the Brand Action Plan.",
          }),
      };
    }
  };
