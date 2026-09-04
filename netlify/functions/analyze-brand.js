const rateLimitStore = new Map();

/*
  Brand Rater V2
  ------------------------------------------------------------
  Frontend contract:
  - images: [{ name, type, dataUrl }]
  - business: {
      name,
      website,
      description,
      audience,
      yearsInBusiness,
      teamSize,
      traction,
      brandConcern,
      twelveMonthGoal
    }
  - context: legacy fallback string
  - turnstileToken

  Environment variables:
  - OPENAI_API_KEY
  - TURNSTILE_SECRET_KEY
  - OPENAI_ANALYSIS_MODEL (optional)
  - OPENAI_NARRATIVE_MODEL (optional)
  - OPENAI_IMAGE_DETAIL (optional: low | high | auto)
*/

const ANALYSIS_MODEL =
  process.env.OPENAI_ANALYSIS_MODEL ||
  "gpt-4.1-mini";

const NARRATIVE_MODEL =
  process.env.OPENAI_NARRATIVE_MODEL ||
  ANALYSIS_MODEL;

const IMAGE_DETAIL =
  ["low", "high", "auto"].includes(
    process.env.OPENAI_IMAGE_DETAIL
  )
    ? process.env.OPENAI_IMAGE_DETAIL
    : "high";

const SCORING_VERSION = "2.0.0";

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;

/* =========================================================
   RUBRIC
========================================================= */

const RUBRIC = {
  clarity: {
    name: "Clarity",
    overallWeight: 25,
    question:
      "Can the right customer quickly understand what the company does, who it is for, why it matters, and what they should do next?",
    criteria: {
      offerClarity: {
        name: "Offer Clarity",
        weight: 25,
        definition:
          "How quickly a customer-facing asset communicates what the company sells or provides.",
      },
      audienceClarity: {
        name: "Audience Clarity",
        weight: 20,
        definition:
          "How clearly the intended customer can recognize that the offer is relevant to them.",
      },
      valueProposition: {
        name: "Value Proposition",
        weight: 25,
        definition:
          "How clearly the brand communicates the benefit or value customers receive, beyond naming the product or service category.",
      },
      messagingHierarchy: {
        name: "Messaging Hierarchy",
        weight: 15,
        definition:
          "Whether the most important information is prioritized and easy to scan in the order customers need it.",
      },
      ctaClarity: {
        name: "CTA Clarity",
        weight: 15,
        definition:
          "Whether the customer can understand the next action the brand wants them to take.",
      },
    },
  },

  credibility: {
    name: "Credibility",
    overallWeight: 20,
    question:
      "Does the brand create an appropriate level of trust for the company's offering, maturity, and position?",
    criteria: {
      professionalPresentation: {
        name: "Professional Presentation",
        weight: 20,
        definition:
          "Whether execution feels competent, intentional, current, and appropriate for the business.",
      },
      trustEvidence: {
        name: "Trust Evidence",
        weight: 25,
        definition:
          "Whether customer-facing materials visibly use reviews, testimonials, results, case studies, client proof, credentials, awards, guarantees, or other confidence signals.",
      },
      expertiseAuthority: {
        name: "Expertise / Authority",
        weight: 20,
        definition:
          "Whether the brand demonstrates knowledge, experience, expertise, or authority appropriate to the purchase decision.",
      },
      maturityAlignment: {
        name: "Business Maturity Alignment",
        weight: 20,
        definition:
          "Whether the brand presentation feels appropriate for the actual stage and sophistication of the business described in the intake.",
      },
      purchaseConfidence: {
        name: "Purchase Confidence",
        weight: 15,
        definition:
          "Whether the customer-facing experience reduces hesitation rather than introducing avoidable doubt or risk.",
      },
    },
  },

  consistency: {
    name: "Consistency",
    overallWeight: 20,
    question:
      "Do the submitted touchpoints feel like they belong to one recognizable brand system?",
    criteria: {
      visualIdentityConsistency: {
        name: "Visual Identity Consistency",
        weight: 25,
        definition:
          "Consistency in logo usage, graphic devices, shapes, iconography, and overall identity behavior.",
      },
      typographyColorConsistency: {
        name: "Typography & Color Consistency",
        weight: 20,
        definition:
          "Whether typography and color are applied with repeatable, recognizable rules.",
      },
      imageryConsistency: {
        name: "Imagery Consistency",
        weight: 15,
        definition:
          "Whether photography, illustration, product imagery, and image treatment feel intentionally related.",
      },
      messagingVoiceConsistency: {
        name: "Messaging & Voice Consistency",
        weight: 20,
        definition:
          "Whether the language, tone, and messaging style feel like the same brand across submitted materials.",
      },
      crossChannelConsistency: {
        name: "Cross-Channel Consistency",
        weight: 20,
        definition:
          "Whether multiple submitted customer touchpoints feel cohesive rather than like separate brands.",
      },
    },
  },

  distinctiveness: {
    name: "Distinctiveness",
    overallWeight: 20,
    question:
      "Does the brand give customers something meaningful and memorable to associate specifically with this business?",
    criteria: {
      positioningDifferentiation: {
        name: "Positioning Differentiation",
        weight: 25,
        definition:
          "Whether the brand gives the intended customer a meaningful reason to choose this business over alternatives.",
      },
      visualDistinctiveness: {
        name: "Visual Distinctiveness",
        weight: 20,
        definition:
          "Whether the visual language moves beyond obvious category defaults and creates recognizable character.",
      },
      messagingDistinctiveness: {
        name: "Messaging Distinctiveness",
        weight: 20,
        definition:
          "Whether customer-facing language reflects a specific position, audience, philosophy, personality, or benefit instead of generic category language.",
      },
      brandPersonality: {
        name: "Brand Personality",
        weight: 15,
        definition:
          "Whether the brand expresses a recognizable character beyond broad labels such as professional, friendly, or modern.",
      },
      ownableElements: {
        name: "Ownable / Memorable Elements",
        weight: 20,
        definition:
          "Whether the brand uses repeatable verbal or visual assets customers could learn to associate with the business.",
      },
    },
  },

  visualExecution: {
    name: "Visual Execution",
    overallWeight: 15,
    question:
      "How effectively does the visual system communicate the quality, personality, and positioning of the business?",
    criteria: {
      identityQuality: {
        name: "Identity Quality",
        weight: 20,
        definition:
          "Functionality, legibility, appropriateness, versatility, and craft of the visible identity elements.",
      },
      typography: {
        name: "Typography",
        weight: 20,
        definition:
          "Readability, hierarchy, pairing, appropriateness, and execution of typography.",
      },
      color: {
        name: "Color",
        weight: 15,
        definition:
          "Contrast, functional use, hierarchy, appropriateness, and accessibility of color.",
      },
      layoutHierarchy: {
        name: "Layout & Hierarchy",
        weight: 25,
        definition:
          "How effectively layout, spacing, scale, grouping, and hierarchy guide attention and comprehension.",
      },
      imageryCraft: {
        name: "Imagery & Craft",
        weight: 20,
        definition:
          "Quality and execution of photography, illustration, cropping, image treatment, resolution, and finishing details.",
      },
    },
  },
};

const SCORE_ANCHORS = {
  0: "Missing, actively harmful, or unusable where evidence clearly shows the criterion should exist.",
  1: "Very weak. Major problems substantially reduce effectiveness.",
  2: "Needs significant improvement. The basic intent is present, but important weaknesses remain.",
  3: "Functional. It works, but does not create a meaningful advantage.",
  4: "Strong. Clear, intentional, and effective with only limited room for improvement.",
  5: "Exceptional. Highly developed, strategically appropriate, and meaningfully strengthens the brand.",
};

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

/*
  Note: an in-memory Map is only a lightweight protection in a
  serverless environment. It is not guaranteed to persist across
  function instances. Turnstile remains the primary bot control.
*/
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const maxRequests = 3;

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

function getImageSize(dataUrl) {
  const base64 =
    String(dataUrl || "").split(",")[1] || "";

  return Math.ceil((base64.length * 3) / 4);
}

function isAllowedImage(img) {
  const allowedTypes = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
  ]);

  return (
    img &&
    allowedTypes.has(img.type) &&
    typeof img.dataUrl === "string" &&
    img.dataUrl.startsWith("data:image/")
  );
}

function clamp(value, min, max) {
  return Math.min(
    max,
    Math.max(
      min,
      Number(value) || 0
    )
  );
}

function round(value) {
  return Math.round(
    Number(value) || 0
  );
}

function normalizeBusiness(input, legacyContext = "") {
  const business =
    input && typeof input === "object"
      ? input
      : {};

  return {
    name:
      String(business.name || "").trim(),

    website:
      String(business.website || "").trim(),

    description:
      String(
        business.description ||
        legacyContext ||
        ""
      ).trim(),

    audience:
      String(business.audience || "").trim(),

    yearsInBusiness:
      String(
        business.yearsInBusiness || ""
      ).trim(),

    teamSize:
      String(
        business.teamSize || ""
      ).trim(),

    traction:
      String(
        business.traction || ""
      ).trim(),

    brandConcern:
      String(
        business.brandConcern || ""
      ).trim(),

    twelveMonthGoal:
      String(
        business.twelveMonthGoal || ""
      ).trim(),
  };
}

async function verifyTurnstile(token, ip) {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    return {
      success: false,
      message:
        "TURNSTILE_SECRET_KEY is missing from Netlify.",
    };
  }

  if (!token) {
    return {
      success: false,
      message:
        "Turnstile verification is missing.",
    };
  }

  const formData =
    new URLSearchParams();

  formData.append(
    "secret",
    process.env.TURNSTILE_SECRET_KEY
  );

  formData.append(
    "response",
    token
  );

  formData.append(
    "remoteip",
    ip
  );

  const response =
    await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: formData,
      }
    );

  const data =
    await response.json();

  return {
    success:
      data.success === true,

    message:
      data["error-codes"]?.join(", ") ||
      "Turnstile verification failed.",
  };
}

/* =========================================================
   STRUCTURED OUTPUT SCHEMAS
========================================================= */

function buildCriterionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "assessed",
      "score",
      "confidence",
      "evidence",
      "reasoning",
      "businessImpact",
    ],
    properties: {
      assessed: {
        type: "boolean",
      },
      score: {
        type: "integer",
        minimum: 0,
        maximum: 5,
      },
      confidence: {
        type: "string",
        enum: [
          "high",
          "medium",
          "low",
          "none",
        ],
      },
      evidence: {
        type: "string",
      },
      reasoning: {
        type: "string",
      },
      businessImpact: {
        type: "string",
      },
    },
  };
}

function buildRubricSchema() {
  const categoryProperties = {};

  for (
    const [categoryId, category]
    of Object.entries(RUBRIC)
  ) {
    const criterionProperties = {};

    for (
      const criterionId
      of Object.keys(category.criteria)
    ) {
      criterionProperties[criterionId] =
        buildCriterionSchema();
    }

    categoryProperties[categoryId] = {
      type: "object",
      additionalProperties: false,
      required:
        Object.keys(category.criteria),
      properties:
        criterionProperties,
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required:
      Object.keys(RUBRIC),
    properties:
      categoryProperties,
  };
}

function buildSignalSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "assessed",
      "score",
      "confidence",
      "evidence",
    ],
    properties: {
      assessed: {
        type: "boolean",
      },
      score: {
        type: "integer",
        minimum: 0,
        maximum: 100,
      },
      confidence: {
        type: "string",
        enum: [
          "high",
          "medium",
          "low",
          "none",
        ],
      },
      evidence: {
        type: "string",
      },
    },
  };
}

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "rubric",
    "businessSignals",
  ],
  properties: {
    rubric:
      buildRubricSchema(),

    businessSignals: {
      type: "object",
      additionalProperties: false,
      required: [
        "customerProof",
        "growthComplexity",
      ],
      properties: {
        customerProof:
          buildSignalSchema(),

        growthComplexity:
          buildSignalSchema(),
      },
    },
  },
};

const NARRATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "brandHealthSummary",
    "patternSummary",
    "gapSummary",
    "categorySummaries",
    "biggestStrength",
    "biggestOpportunity",
    "evidence",
    "freeRecommendation",
  ],
  properties: {
    brandHealthSummary: {
      type: "string",
    },

    patternSummary: {
      type: "string",
    },

    gapSummary: {
      type: "string",
    },

    categorySummaries: {
      type: "object",
      additionalProperties: false,
      required: [
        "clarity",
        "credibility",
        "consistency",
        "distinctiveness",
        "visualExecution",
      ],
      properties: {
        clarity: {
          type: "string",
        },
        credibility: {
          type: "string",
        },
        consistency: {
          type: "string",
        },
        distinctiveness: {
          type: "string",
        },
        visualExecution: {
          type: "string",
        },
      },
    },

    biggestStrength: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "summary",
      ],
      properties: {
        title: {
          type: "string",
        },
        summary: {
          type: "string",
        },
      },
    },

    biggestOpportunity: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "summary",
      ],
      properties: {
        title: {
          type: "string",
        },
        summary: {
          type: "string",
        },
      },
    },

    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "observation",
          "impact",
        ],
        properties: {
          observation: {
            type: "string",
          },
          impact: {
            type: "string",
          },
        },
      },
    },

    freeRecommendation: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "summary",
      ],
      properties: {
        title: {
          type: "string",
        },
        summary: {
          type: "string",
        },
      },
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
    .flatMap(
      item =>
        Array.isArray(item.content)
          ? item.content
          : []
    )
    .map(content => {
      if (
        content.type === "output_text" &&
        typeof content.text === "string"
      ) {
        return content.text;
      }

      if (typeof content.text === "string") {
        return content.text;
      }

      return "";
    })
    .join("")
    .trim();
}

async function callOpenAI({
  model,
  content,
  schema,
  schemaName,
  maxOutputTokens,
}) {
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

        body:
          JSON.stringify({
            model,
            store: false,

            max_output_tokens:
              maxOutputTokens,

            input: [
              {
                role: "user",
                content,
              },
            ],

            text: {
              format: {
                type: "json_schema",
                name: schemaName,
                strict: true,
                schema,
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
      "OpenAI returned no usable structured output."
    );
  }

  try {
    return JSON.parse(outputText);
  }
  catch {
    throw new Error(
      "OpenAI returned structured output that could not be parsed."
    );
  }
}

/* =========================================================
   ANALYSIS PROMPT
========================================================= */

function rubricPromptText() {
  const lines = [];

  for (
    const [categoryId, category]
    of Object.entries(RUBRIC)
  ) {
    lines.push(
      `${categoryId} — ${category.name}: ${category.question}`
    );

    for (
      const [criterionId, criterion]
      of Object.entries(category.criteria)
    ) {
      lines.push(
        `  ${criterionId} — ${criterion.name}: ${criterion.definition}`
      );
    }
  }

  return lines.join("\n");
}

function buildAnalysisPrompt({
  business,
  imageNames,
}) {
  const scoreAnchors =
    Object.entries(SCORE_ANCHORS)
      .map(
        ([score, definition]) =>
          `${score}: ${definition}`
      )
      .join("\n");

  return `
You are the evidence-analysis layer for Brand Rater V2 by Milky Minds Creative.

Your job is NOT to invent an overall score, a Brand Pattern, a Brand Gap, or a marketing recommendation. The application will calculate those deterministically after your analysis.

Evaluate the submitted CUSTOMER-FACING BRAND MATERIALS against the exact rubric below.

BUSINESS CONTEXT
Business / brand: ${business.name || "Not provided"}
Website URL: ${business.website || "Not provided"}
What the business says it does: ${business.description || "Not provided"}
Primary audience: ${business.audience || "Not provided"}
Years operating: ${business.yearsInBusiness || "Not provided"}
Team size: ${business.teamSize || "Not provided"}
Customer traction: ${business.traction || "Not provided"}
Founder-reported brand concern: ${business.brandConcern || "Not provided"}
12-month goal: ${business.twelveMonthGoal || "Not provided"}

SUBMITTED ASSET FILENAMES
${imageNames.length ? imageNames.join("\n") : "No filenames provided"}

CRITICAL EVIDENCE RULES
1. Separate founder-provided context from observed customer-facing evidence.
2. Do NOT give a high score just because the founder describes the business clearly in the intake. Clarity must be visible in submitted customer-facing material.
3. Do NOT treat claims in the intake as proof that customers can see testimonials, credentials, differentiation, or authority.
4. A website URL alone is NOT evidence that you inspected the website. Do not claim to have visited or analyzed the live website.
5. If a criterion cannot be assessed from the submitted visuals and business context, set:
   - assessed = false
   - score = 0
   - confidence = "none"
   - evidence = a short statement explaining what evidence is missing
6. If assessed = true, evidence must describe something concrete you can actually observe: visible wording, hierarchy, type behavior, color behavior, imagery, CTA treatment, proof, layout, or differences between submitted assets.
7. Avoid generic statements such as "the branding is consistent" unless you specify exactly what is consistent.
8. Do not prescribe a full rebrand simply because execution is imperfect.
9. Judge appropriateness relative to the stated audience, business maturity, offering, and goals.
10. Keep each reasoning, evidence, and businessImpact field concise: usually 1–2 sentences.

SCORING ANCHORS — use only integer scores 0–5
${scoreAnchors}

RUBRIC
${rubricPromptText()}

BUSINESS SIGNALS
Also evaluate:
- customerProof: How much evidence exists in the submitted assets or explicit context that this business has real market/customer proof such as reviews, testimonials, results, client history, case studies, awards, credentials, repeat business, or established traction. Do not confuse "proof exists" with "proof is presented well"; presentation quality belongs under Credibility.
- growthComplexity: How complex the brand is becoming to manage, based on team size, growth goal, number of services/products/locations/audiences visibly or explicitly described, and signs that multiple touchpoints or contributors must stay aligned.

For businessSignals:
- score 0–100.
- If there is not enough evidence, assessed=false, score=0, confidence="none".
- Evidence must identify the specific signal used.

Return only the structured result required by the supplied JSON schema.
`;
}

/* =========================================================
   SCORING ENGINE
========================================================= */

const CONFIDENCE_FACTORS = {
  high: 1,
  medium: 0.82,
  low: 0.62,
  none: 0,
};

function calculateCategoryScores(modelAnalysis) {
  const categories = [];

  for (
    const [categoryId, category]
    of Object.entries(RUBRIC)
  ) {
    const modelCategory =
      modelAnalysis.rubric?.[categoryId] || {};

    let weightedPoints = 0;
    let assessedWeight = 0;
    let confidencePoints = 0;

    const subcriteria = [];

    for (
      const [criterionId, criterion]
      of Object.entries(category.criteria)
    ) {
      const item =
        modelCategory[criterionId] || {};

      const assessed =
        item.assessed === true;

      const score =
        clamp(
          item.score,
          0,
          5
        );

      const confidence =
        CONFIDENCE_FACTORS[
          item.confidence
        ] !== undefined
          ? item.confidence
          : "none";

      const confidenceFactor =
        CONFIDENCE_FACTORS[confidence];

      if (assessed) {
        weightedPoints +=
          (score / 5) *
          criterion.weight;

        assessedWeight +=
          criterion.weight;

        confidencePoints +=
          confidenceFactor *
          criterion.weight;
      }

      subcriteria.push({
        id: criterionId,
        name: criterion.name,

        categoryId,
        categoryName:
          category.name,

        categoryOverallWeight:
          category.overallWeight,

        criterionWeight:
          criterion.weight,

        assessed,
        score,

        score100:
          assessed
            ? round(
                (score / 5) * 100
              )
            : null,

        confidence,

        evidence:
          String(
            item.evidence || ""
          ),

        reasoning:
          String(
            item.reasoning || ""
          ),

        businessImpact:
          String(
            item.businessImpact || ""
          ),
      });
    }

    const hasEvidence =
      assessedWeight > 0;

    const score =
      hasEvidence
        ? round(
            (weightedPoints /
              assessedWeight) *
            100
          )
        : 50;

    const confidenceValue =
      hasEvidence
        ? confidencePoints /
          assessedWeight
        : 0;

    let confidence =
      "insufficient";

    if (confidenceValue >= 0.86) {
      confidence = "high";
    }
    else if (
      confidenceValue >= 0.68
    ) {
      confidence = "medium";
    }
    else if (
      confidenceValue > 0
    ) {
      confidence = "low";
    }

    categories.push({
      id: categoryId,
      name: category.name,
      score,
      confidence,
      assessedWeight,

      overallWeight:
        category.overallWeight,

      subcriteria,
    });
  }

  return categories;
}

function calculateBrandHealth(categories) {
  const assessedCategories =
    categories.filter(
      category =>
        category.assessedWeight > 0
    );

  if (!assessedCategories.length) {
    return {
      score: 50,
      level: "Developing",
      confidence:
        "insufficient",
    };
  }

  const totalWeight =
    assessedCategories.reduce(
      (sum, category) =>
        sum +
        category.overallWeight,
      0
    );

  const weighted =
    assessedCategories.reduce(
      (sum, category) =>
        sum +
        category.score *
        category.overallWeight,
      0
    );

  const score =
    round(
      weighted /
      totalWeight
    );

  const confidenceAverage =
    assessedCategories.reduce(
      (sum, category) => {
        const factor =
          category.confidence === "high"
            ? 1
            : category.confidence === "medium"
              ? 0.78
              : category.confidence === "low"
                ? 0.56
                : 0;

        return sum + factor;
      },
      0
    ) /
    assessedCategories.length;

  const confidence =
    confidenceAverage >= 0.86
      ? "high"
      : confidenceAverage >= 0.68
        ? "medium"
        : "low";

  return {
    score,

    level:
      brandHealthLevel(
        score
      ),

    confidence,
  };
}

function brandHealthLevel(score) {
  if (score >= 90) {
    return "Exceptional";
  }

  if (score >= 80) {
    return "Strong";
  }

  if (score >= 70) {
    return "Established";
  }

  if (score >= 60) {
    return "Developing";
  }

  if (score >= 40) {
    return "Inconsistent";
  }

  return "Critical";
}

/* =========================================================
   BUSINESS MATURITY + BRAND GAP
========================================================= */

const HISTORY_SCORES = {
  "less-than-1": 20,
  "1-3": 40,
  "4-7": 70,
  "8-plus": 90,
};

const TEAM_SCORES = {
  solo: 20,
  "2-5": 40,
  "6-10": 65,
  "11-25": 85,
  "25-plus": 95,
};

const TRACTION_SCORES = {
  early: 25,
  growing: 50,
  established: 75,
  mature: 95,
};

function fallbackGrowthComplexity(
  business
) {
  const base =
    {
      solo: 20,
      "2-5": 35,
      "6-10": 55,
      "11-25": 75,
      "25-plus": 90,
    }[business.teamSize] || 40;

  const combined =
    `${business.brandConcern} ${business.twelveMonthGoal} ${business.description}`
      .toLowerCase();

  let boost = 0;

  if (
    /(expand|expansion|second location|new location|multiple location|franchise|scale|scaling|grow|growth|hire|hiring)/i
      .test(combined)
  ) {
    boost += 12;
  }

  if (
    /(multiple services|multiple products|new product|new service|new market|new audience|national|regional)/i
      .test(combined)
  ) {
    boost += 8;
  }

  return clamp(
    base + boost,
    0,
    100
  );
}

function calculateBusinessMaturity(
  business,
  businessSignals
) {
  const history =
    HISTORY_SCORES[
      business.yearsInBusiness
    ] ?? 40;

  const team =
    TEAM_SCORES[
      business.teamSize
    ] ?? 40;

  const traction =
    TRACTION_SCORES[
      business.traction
    ] ?? 50;

  const proofSignal =
    businessSignals
      ?.customerProof;

  const complexitySignal =
    businessSignals
      ?.growthComplexity;

  const customerProof =
    proofSignal?.assessed
      ? clamp(
          proofSignal.score,
          0,
          100
        )
      : traction;

  const growthComplexity =
    complexitySignal?.assessed
      ? clamp(
          complexitySignal.score,
          0,
          100
        )
      : fallbackGrowthComplexity(
          business
        );

  const score =
    round(
      history * 0.15 +
      team * 0.15 +
      traction * 0.25 +
      customerProof * 0.25 +
      growthComplexity * 0.20
    );

  return {
    score,

    dimensions: {
      operatingHistory:
        history,

      teamScale:
        team,

      marketTraction:
        traction,

      customerProof:
        round(
          customerProof
        ),

      growthComplexity:
        round(
          growthComplexity
        ),
    },
  };
}

function expectedBrandHealth(
  maturityScore
) {
  if (maturityScore < 40) {
    return 50;
  }

  if (maturityScore < 60) {
    return 60;
  }

  if (maturityScore < 75) {
    return 70;
  }

  if (maturityScore < 90) {
    return 80;
  }

  return 85;
}

function calculateBrandGap(
  maturityScore,
  brandHealthScore
) {
  const expected =
    expectedBrandHealth(
      maturityScore
    );

  const difference =
    round(
      expected -
      brandHealthScore
    );

  let level;

  if (difference <= -8) {
    level =
      "Brand Advantage";
  }
  else if (
    difference >= -7 &&
    difference <= 7
  ) {
    level =
      "Aligned";
  }
  else if (
    difference <= 15
  ) {
    level =
      "Moderate Gap";
  }
  else if (
    difference <= 25
  ) {
    level =
      "Significant Gap";
  }
  else {
    level =
      "Critical Gap";
  }

  return {
    businessMaturity:
      maturityScore,

    expectedBrandHealth:
      expected,

    actualBrandHealth:
      brandHealthScore,

    gap:
      difference,

    level,
  };
}

/* =========================================================
   BRAND PATTERN ENGINE
========================================================= */

function categoryMap(categories) {
  return Object.fromEntries(
    categories.map(
      category => [
        category.id,
        category,
      ]
    )
  );
}

function high(value, threshold) {
  if (value <= threshold) {
    return 0;
  }

  return clamp(
    (value - threshold) /
    (100 - threshold),
    0,
    1
  );
}

function low(value, threshold) {
  if (value >= threshold) {
    return 0;
  }

  return clamp(
    (threshold - value) /
    threshold,
    0,
    1
  );
}

function nearOrAbove(
  value,
  threshold,
  spread = 20
) {
  return clamp(
    (
      value -
      (threshold - spread)
    ) /
    spread,
    0,
    1
  );
}

function growthSignal(business) {
  const text =
    `${business.brandConcern} ${business.twelveMonthGoal}`
      .toLowerCase();

  let score = 0.2;

  if (
    /(grow|growth|expand|expansion|scale|scaling|location|hire|hiring|launch|new market|new service|new product)/i
      .test(text)
  ) {
    score += 0.55;
  }

  if (
    [
      "growing",
      "established",
      "mature",
    ].includes(
      business.traction
    )
  ) {
    score += 0.2;
  }

  return clamp(
    score,
    0,
    1
  );
}
function selectBrandPattern({
  categories,
  brandHealth,
  maturity,
  gap,
  business,
  businessSignals,
}) {
  const c =
    categoryMap(categories);

  const clarity =
    c.clarity?.score ?? 50;

  const credibility =
    c.credibility?.score ?? 50;

  const consistency =
    c.consistency?.score ?? 50;

  const distinctiveness =
    c.distinctiveness?.score ?? 50;

  const visual =
    c.visualExecution?.score ?? 50;

  const minCategory =
    Math.min(
      clarity,
      credibility,
      consistency,
      distinctiveness,
      visual
    );

  const maxOtherThanConsistency =
    Math.max(
      clarity,
      credibility,
      distinctiveness,
      visual
    );

  const proof =
    businessSignals?.customerProof?.assessed
      ? businessSignals.customerProof.score
      : TRACTION_SCORES[
          business.traction
        ] || 50;

  const gapPositive =
    Math.max(0, gap.gap);

  const growth =
    growthSignal(business);

  const candidates = [
    {
      id: "STRONG_FOUNDATION",
      name: "The Strong Foundation",
      definition:
        "A mature, well-balanced brand where refinement matters more than major correction.",
      score:
        (
          nearOrAbove(
            brandHealth.score,
            80,
            18
          ) +
          nearOrAbove(
            minCategory,
            70,
            18
          ) +
          low(
            Math.max(
              gapPositive,
              0
            ),
            8
          )
        ) / 3,
    },

    {
      id:
        "HIGH_EXECUTION_LOW_DIFFERENTIATION",
      name:
        "The Polished Generic",
      definition:
        "A professionally executed brand that still relies too heavily on category conventions or generic positioning.",
      score:
        (
          nearOrAbove(
            visual,
            75,
            22
          ) +
          nearOrAbove(
            consistency,
            70,
            22
          ) +
          low(
            distinctiveness,
            65
          )
        ) / 3,
    },

    {
      id:
        "SCALE_CONSISTENCY_GAP",
      name:
        "The Growing Pains",
      definition:
        "The business is becoming more sophisticated than the brand system supporting its growth.",
      score:
        (
          nearOrAbove(
            maturity.score,
            65,
            25
          ) +
          low(
            consistency,
            65
          ) +
          growth +
          nearOrAbove(
            gapPositive,
            8,
            18
          )
        ) / 4,
    },

    {
      id:
        "EARLY_IDENTITY_MATURITY_GAP",
      name:
        "The DIY Ceiling",
      definition:
        "A brand that was sufficient earlier in the business but is now visibly limiting how mature the company appears.",
      score:
        (
          nearOrAbove(
            maturity.score,
            65,
            25
          ) +
          low(
            visual,
            60
          ) +
          low(
            consistency,
            65
          ) +
          nearOrAbove(
            gapPositive,
            16,
            20
          )
        ) / 4,
    },

    {
      id:
        "CLARITY_CREDIBILITY_GAP",
      name:
        "The Trust Gap",
      definition:
        "Customers can understand the offer, but the brand is not providing enough confidence to make the next step feel safe.",
      score:
        (
          nearOrAbove(
            clarity,
            65,
            20
          ) +
          low(
            credibility,
            60
          )
        ) / 2,
    },

    {
      id:
        "LOW_CLARITY",
      name:
        "The Foggy Brand",
      definition:
        "There is value in the business, but customers have to work too hard to understand the offer, audience, or reason to care.",
      score:
        low(
          clarity,
          60
        ),
    },

    {
      id:
        "FRAGMENTED_SYSTEM",
      name:
        "The Patchwork Brand",
      definition:
        "Strong individual pieces are not adding up to one recognizable brand system.",
      score:
        (
          low(
            consistency,
            55
          ) +
          nearOrAbove(
            maxOtherThanConsistency,
            70,
            20
          )
        ) / 2,
    },

    {
      id:
        "MATURITY_PRESENTATION_GAP",
      name:
        "The Hidden Gem",
      definition:
        "The underlying business and customer proof are stronger than the way the brand currently communicates them.",
      score:
        (
          nearOrAbove(
            maturity.score,
            65,
            25
          ) +
          nearOrAbove(
            proof,
            65,
            25
          ) +
          Math.max(
            low(
              clarity,
              65
            ),
            low(
              visual,
              65
            ),
            low(
              credibility,
              65
            )
          ) +
          nearOrAbove(
            gapPositive,
            8,
            18
          )
        ) / 4,
    },
  ];

  const ranked =
    candidates
      .map(candidate => ({
        ...candidate,
        score:
          clamp(
            candidate.score,
            0,
            1
          ),
      }))
      .sort(
        (a, b) =>
          b.score - a.score
      );

  const winner =
    ranked[0];

  if (
    !winner ||
    winner.score < 0.42
  ) {
    return {
      id:
        "UNEVEN_FOUNDATION",
      name:
        "The Uneven Foundation",
      definition:
        "The brand has a workable base, but performance varies enough across key areas that one or two weaknesses are limiting the whole experience.",
      confidence: 0.58,
      secondarySignal: null,
    };
  }

  const secondary =
    ranked[1] &&
    ranked[1].score >= 0.58
      ? {
          id:
            ranked[1].id,

          name:
            ranked[1].name,

          confidence:
            Number(
              ranked[1].score
                .toFixed(2)
            ),
        }
      : null;

  return {
    id:
      winner.id,

    name:
      winner.name,

    definition:
      winner.definition,

    confidence:
      Number(
        winner.score.toFixed(2)
      ),

    secondarySignal:
      secondary,
  };
}

/* =========================================================
   PRIORITY ENGINE
========================================================= */

function categoryRelevance(
  categoryId,
  business
) {
  let relevance = 0.5;

  const concern =
    business.brandConcern
      .toLowerCase();

  const goal =
    business.twelveMonthGoal
      .toLowerCase();

  const boost = amount => {
    relevance += amount;
  };

  if (
    concern.includes("different")
  ) {
    if (
      categoryId ===
      "distinctiveness"
    ) {
      boost(0.38);
    }

    if (
      categoryId === "clarity"
    ) {
      boost(0.22);
    }
  }

  if (
    concern.includes("inconsistent")
  ) {
    if (
      categoryId === "consistency"
    ) {
      boost(0.42);
    }
  }

  if (
    concern.includes("professional") ||
    concern.includes("established")
  ) {
    if (
      categoryId === "credibility"
    ) {
      boost(0.32);
    }

    if (
      categoryId ===
      "visualExecution"
    ) {
      boost(0.25);
    }
  }

  if (
    concern.includes("outgrown")
  ) {
    if (
      categoryId === "consistency"
    ) {
      boost(0.26);
    }

    if (
      categoryId ===
      "visualExecution"
    ) {
      boost(0.2);
    }

    if (
      categoryId === "credibility"
    ) {
      boost(0.18);
    }
  }

  if (
    concern.includes("website")
  ) {
    if (
      categoryId === "clarity" ||
      categoryId === "credibility" ||
      categoryId ===
        "visualExecution"
    ) {
      boost(0.24);
    }
  }

  if (
    /(grow|growth|expand|expansion|scale|scaling|location|hire|hiring)/i
      .test(goal) ||
    concern.includes("growth") ||
    concern.includes("expansion")
  ) {
    if (
      categoryId === "consistency"
    ) {
      boost(0.32);
    }

    if (
      categoryId === "clarity"
    ) {
      boost(0.18);
    }

    if (
      categoryId === "credibility"
    ) {
      boost(0.15);
    }
  }

  return clamp(
    relevance,
    0,
    1
  );
}

function choosePriority(
  categories,
  business
) {
  const candidates = [];

  for (
    const category
    of categories
  ) {
    const relevance =
      categoryRelevance(
        category.id,
        business
      );

    for (
      const item
      of category.subcriteria
    ) {
      if (!item.assessed) {
        continue;
      }

      const deficit =
        (5 - item.score) / 5;

      const categoryImportance =
        category.overallWeight / 25;

      const criterionImportance =
        item.criterionWeight / 25;

      const confidence =
        CONFIDENCE_FACTORS[
          item.confidence
        ] || 0.5;

      const priorityScore =
        (
          deficit * 0.48 +
          relevance * 0.28 +
          categoryImportance * 0.14 +
          criterionImportance * 0.10
        ) *
        confidence;

      candidates.push({
        ...item,

        priorityScore:
          Number(
            priorityScore
              .toFixed(3)
          ),

        businessRelevance:
          Number(
            relevance
              .toFixed(2)
          ),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.priorityScore -
      a.priorityScore
  );

  return (
    candidates[0] || {
      categoryId:
        "clarity",

      categoryName:
        "Clarity",

      id:
        "general",

      name:
        "Clarify the customer-facing brand",

      assessed:
        false,

      score:
        3,

      confidence:
        "low",

      evidence:
        "The assessment did not have enough evidence to identify a stronger priority.",

      businessImpact:
        "A clearer customer-facing brand makes later improvements easier to prioritize.",

      priorityScore:
        0,

      businessRelevance:
        0.5,
    }
  );
}

function chooseStrongestSignal(
  categories
) {
  const candidates =
    categories
      .flatMap(
        category =>
          category.subcriteria
      )
      .filter(
        item =>
          item.assessed
      )
      .map(
        item => ({
          ...item,

          strengthScore:
            (item.score / 5) *
            (
              CONFIDENCE_FACTORS[
                item.confidence
              ] || 0.5
            ),
        })
      )
      .sort(
        (a, b) =>
          b.strengthScore -
          a.strengthScore
      );

  return candidates[0] || null;
}
/* =========================================================
   NARRATIVE
========================================================= */

function categoryEvidenceDigest(
  category
) {
  const assessed =
    category.subcriteria
      .filter(
        item =>
          item.assessed
      )
      .sort(
        (a, b) =>
          a.score - b.score
      );

  if (!assessed.length) {
    return {
      category:
        category.name,

      score:
        category.score,

      confidence:
        category.confidence,

      evidence:
        "Not enough customer-facing evidence was available to assess this category confidently.",
    };
  }

  const weakest =
    assessed[0];

  const strongest =
    assessed[
      assessed.length - 1
    ];

  return {
    category:
      category.name,

    score:
      category.score,

    confidence:
      category.confidence,

    weakest: {
      criterion:
        weakest.name,
      score:
        weakest.score,
      evidence:
        weakest.evidence,
      impact:
        weakest.businessImpact,
    },

    strongest: {
      criterion:
        strongest.name,
      score:
        strongest.score,
      evidence:
        strongest.evidence,
      impact:
        strongest.businessImpact,
    },
  };
}

function buildNarrativePrompt({
  business,
  brandHealth,
  categories,
  maturity,
  gap,
  pattern,
  priority,
  strongest,
  businessSignals,
}) {
  const categoryDigest =
    categories.map(
      categoryEvidenceDigest
    );

  return `
You are the user-facing strategy writer for Brand Rater V2 by Milky Minds Creative.

The scoring engine has already calculated the results. DO NOT change, reinterpret, or invent scores. Your job is to turn the evidence into concise, specific language that sounds like an experienced brand strategist reviewed this particular business.

TARGET USER
Founder-led established businesses that generally have 1–25 employees and do not have dedicated senior brand/creative expertise.

BUSINESS
${JSON.stringify(business, null, 2)}

CALCULATED BRAND HEALTH
${JSON.stringify(brandHealth, null, 2)}

CALCULATED BUSINESS MATURITY
${JSON.stringify(maturity, null, 2)}

CALCULATED BRAND GAP
${JSON.stringify(gap, null, 2)}

CALCULATED BRAND PATTERN
${JSON.stringify(pattern, null, 2)}

CATEGORY EVIDENCE
${JSON.stringify(categoryDigest, null, 2)}

CUSTOMER PROOF / COMPLEXITY SIGNALS
${JSON.stringify(businessSignals, null, 2)}

HIGHEST-PRIORITY SUBCRITERION
${JSON.stringify(priority, null, 2)}

STRONGEST OBSERVED SUBCRITERION
${JSON.stringify(strongest, null, 2)}

WRITING RULES
1. Be specific to this business. Use the business name when natural.
2. Connect the diagnosis to the founder's stated brand concern or 12-month goal when evidence supports it.
3. Do not say you visited or crawled the live website. A URL alone was not analyzed.
4. Never invent reviews, customer counts, locations, awards, claims, services, or visual details that are not present in the supplied evidence.
5. Prefer concrete language over generic AI language.
6. Do not use empty phrases such as:
   - "Your brand has a strong foundation but room to grow"
   - "Your visuals are consistent and professional"
   unless you immediately identify exactly what makes that true.
7. Explain business consequences in founder language, not design jargon.
8. Do not recommend a full rebrand unless the supplied evidence genuinely supports it.
9. The freeRecommendation must be ONE first move, not a long action plan.
10. The biggestOpportunity should explain why that issue matters now for this business.
11. Category summaries should be 1–2 concise sentences and mention concrete evidence where available.
12. If a category has insufficient evidence, say that clearly rather than pretending the score is precise.
13. patternSummary must explain why this exact Brand Pattern fits the evidence.
14. gapSummary must explain whether the brand is ahead of, aligned with, or lagging behind the maturity of the business.
15. Return 3 specific evidence observations when possible. If evidence is limited, use fewer rather than inventing observations.

Return only the structured result required by the supplied JSON schema.
`;
}

/* =========================================================
   FINAL RESPONSE ASSEMBLY
========================================================= */

function buildCategoriesForClient(
  categories,
  narrative
) {
  return categories.map(
    category => ({
      id:
        category.id,

      name:
        category.name,

      score:
        category.score,

      confidence:
        category.confidence,

      summary:
        narrative
          .categorySummaries?.[
            category.id
          ] ||
        "Not enough evidence was available to summarize this category.",
    })
  );
}

function buildDiagnostics(
  categories,
  maturity,
  businessSignals,
  priority,
  strongest
) {
  return {
    scoringVersion:
      SCORING_VERSION,

    categoryRubric:
      Object.fromEntries(
        categories.map(
          category => [
            category.id,
            {
              score:
                category.score,

              confidence:
                category.confidence,

              subcriteria:
                category.subcriteria,
            },
          ]
        )
      ),

    businessMaturity:
      maturity,

    businessSignals:
      businessSignals,

    priority:
      priority,

    strongestSignal:
      strongest,
  };
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

        body:
          JSON.stringify({
            success: true,
            version:
              SCORING_VERSION,
            message:
              "Brand Rater V2 function is ready. Send a POST request with images, business context, and a Turnstile token.",
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

      const {
        images,
        context,
        turnstileToken,
      } = body;

      const business =
        normalizeBusiness(
          body.business,
          context
        );

      const ip =
        getClientIp(event);

      /*
        Verify the human challenge before consuming an analysis attempt.
      */
      const turnstile =
        await verifyTurnstile(
          turnstileToken,
          ip
        );

      if (!turnstile.success) {
        return {
          statusCode: 403,

          body:
            JSON.stringify({
              error:
                turnstile.message,
            }),
        };
      }

      if (!checkRateLimit(ip)) {
        return {
          statusCode: 429,

          body:
            JSON.stringify({
              error:
                "Too many brand rating attempts. Please try again later.",
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

      if (
        !Array.isArray(images) ||
        images.length === 0
      ) {
        return {
          statusCode: 400,

          body:
            JSON.stringify({
              error:
                "No images were provided.",
            }),
        };
      }

      if (
        images.length > MAX_IMAGES
      ) {
        return {
          statusCode: 400,

          body:
            JSON.stringify({
              error:
                `Please upload no more than ${MAX_IMAGES} images.`,
            }),
        };
      }

      const invalidImage =
        images.find(
          image =>
            !isAllowedImage(image)
        );

      if (invalidImage) {
        return {
          statusCode: 400,

          body:
            JSON.stringify({
              error:
                "Only PNG, JPG, and WEBP brand images are supported.",
            }),
        };
      }

      const sizes =
        images.map(
          image =>
            getImageSize(
              image.dataUrl
            )
        );

      const oversized =
        sizes.some(
          size =>
            size >
            MAX_IMAGE_BYTES
        );

      if (oversized) {
        return {
          statusCode: 400,

          body:
            JSON.stringify({
              error:
                "One or more images are larger than 5 MB. Please upload smaller files.",
            }),
        };
      }

      const totalBytes =
        sizes.reduce(
          (sum, size) =>
            sum + size,
          0
        );

      if (
        totalBytes >
        MAX_TOTAL_IMAGE_BYTES
      ) {
        return {
          statusCode: 400,

          body:
            JSON.stringify({
              error:
                "The combined image upload is larger than 8 MB. Please upload fewer or smaller images.",
            }),
        };
      }

      /*
        The model sees the images only during the evidence-analysis pass.
        High detail is intentional because typography, hierarchy, and
        brand-system inconsistencies can be subtle.
      */
      const imageInputs =
        images.map(
          image => ({
            type:
              "input_image",

            image_url:
              image.dataUrl,

            detail:
              IMAGE_DETAIL,
          })
        );

      const analysisPrompt =
        buildAnalysisPrompt({
          business,

          imageNames:
            images.map(
              image =>
                image.name ||
                "Unnamed asset"
            ),
        });

      const modelAnalysis =
        await callOpenAI({
          model:
            ANALYSIS_MODEL,

          content: [
            ...imageInputs,
            {
              type:
                "input_text",
              text:
                analysisPrompt,
            },
          ],

          schema:
            ANALYSIS_SCHEMA,

          schemaName:
            "brand_rater_v2_analysis",

          maxOutputTokens:
            8000,
        });

      const categories =
        calculateCategoryScores(
          modelAnalysis
        );

      const brandHealth =
        calculateBrandHealth(
          categories
        );

      const maturity =
        calculateBusinessMaturity(
          business,
          modelAnalysis.businessSignals
        );

      const gap =
        calculateBrandGap(
          maturity.score,
          brandHealth.score
        );

      const pattern =
        selectBrandPattern({
          categories,
          brandHealth,
          maturity,
          gap,
          business,
          businessSignals:
            modelAnalysis.businessSignals,
        });

      const priority =
        choosePriority(
          categories,
          business
        );

      const strongest =
        chooseStrongestSignal(
          categories
        );

      /*
        Second pass: no images are required. This pass receives only
        the verified evidence + deterministic scores and writes the
        founder-facing explanation.
      */
      const narrativePrompt =
        buildNarrativePrompt({
          business,
          brandHealth,
          categories,
          maturity,
          gap,
          pattern,
          priority,
          strongest,
          businessSignals:
            modelAnalysis.businessSignals,
        });

      const narrative =
        await callOpenAI({
          model:
            NARRATIVE_MODEL,

          content: [
            {
              type:
                "input_text",
              text:
                narrativePrompt,
            },
          ],

          schema:
            NARRATIVE_SCHEMA,

          schemaName:
            "brand_rater_v2_narrative",

          maxOutputTokens:
            3500,
        });

      const result = {
        version:
          SCORING_VERSION,

        brandHealth: {
          score:
            brandHealth.score,

          level:
            brandHealth.level,

          confidence:
            brandHealth.confidence,

          summary:
            narrative
              .brandHealthSummary,
        },

        brandPattern: {
          id:
            pattern.id,

          name:
            pattern.name,

          confidence:
            pattern.confidence,

          secondarySignal:
            pattern.secondarySignal,

          summary:
            narrative
              .patternSummary,
        },

        brandGap: {
          businessMaturity:
            gap.businessMaturity,

          expectedBrandHealth:
            gap.expectedBrandHealth,

          actualBrandHealth:
            gap.actualBrandHealth,

          gap:
            gap.gap,

          level:
            gap.level,

          summary:
            narrative
              .gapSummary,
        },

        categories:
          buildCategoriesForClient(
            categories,
            narrative
          ),

        biggestStrength:
          narrative
            .biggestStrength,

        biggestOpportunity:
          narrative
            .biggestOpportunity,

        evidence:
          Array.isArray(
            narrative.evidence
          )
            ? narrative.evidence
                .slice(0, 3)
            : [],

        freeRecommendation:
          narrative
            .freeRecommendation,

        actionPlanPreview: {
          available:
            false,

          label:
            "Brand Action Plan",

          includes: [
            "Fix First + Fix Next",
            "Quick wins + budget guidance",
            "What not to prioritize",
            "90-day roadmap",
          ],
        },

        assessmentMeta: {
          scoringVersion:
            SCORING_VERSION,

          overallConfidence:
            brandHealth.confidence,

          analysisModel:
            ANALYSIS_MODEL,

          narrativeModel:
            NARRATIVE_MODEL,

          imageDetail:
            IMAGE_DETAIL,

          submittedAssets:
            images.length,
        },

        /*
          Kept in the response so Netlify lead capture can save the
          structured diagnostic for future Brand Action Plan generation.
          The V2 frontend does not render this section directly.
        */
        diagnostics:
          buildDiagnostics(
            categories,
            maturity,
            modelAnalysis.businessSignals,
            priority,
            strongest
          ),
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
          JSON.stringify(result),
      };
    }

    catch (error) {
      console.error(
        "Brand Rater V2 error:",
        error
      );

      return {
        statusCode: 500,

        body:
          JSON.stringify({
            error:
              error.message ||
              "Something went wrong.",
          }),
      };
    }
  };
