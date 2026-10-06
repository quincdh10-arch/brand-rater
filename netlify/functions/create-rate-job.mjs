/*
  Brand Rater Enterprise
  create-rate-job.mjs
  ------------------------------------------------------------
  Production Rate async architecture v1.0

  Purpose:
  - Validate the Brand Rater business intake.
  - Verify Cloudflare Turnstile.
  - Preserve the production 3-ratings-per-hour lightweight limit.
  - Validate optional Re-Rate baseline credentials.
  - Create a unique Rate Job ID.
  - Save the initial job record in Netlify Blobs.
  - Return immediately so the frontend can upload
    brand assets one at a time.

  Expected frontend payload:
  {
    business: {
      name,
      website,
      description,
      audience,
      yearsInBusiness,
      teamSize,
      traction,
      brandConcern,
      twelveMonthGoal
    },
    assetCount: number,
    turnstileToken: string,
    baselineAssessmentId?: string,
    baselineAccessToken?: string
  }

  Required environment variable:
  - TURNSTILE_SECRET_KEY

  Required package:
  - @netlify/blobs
*/

import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  getStore,
} from "@netlify/blobs";


const JOB_STORE_NAME =
  "brand-rater-rate-jobs";

const ASSESSMENT_STORE_NAME =
  "brand-rater-assessments";

const JOB_VERSION =
  "rate-job-1.0.0";

const MIN_ASSETS = 1;
const MAX_ASSETS = 5;

const JOB_RETENTION_HOURS = 24;

const MAX_NAME_LENGTH = 160;
const MAX_URL_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 3000;
const MAX_AUDIENCE_LENGTH = 2500;
const MAX_CONCERN_LENGTH = 1500;
const MAX_GOAL_LENGTH = 2500;

const VALID_YEARS_IN_BUSINESS =
  new Set([
    "less-than-1",
    "1-3",
    "4-7",
    "8-plus",
  ]);

const VALID_TEAM_SIZES =
  new Set([
    "solo",
    "2-5",
    "6-10",
    "11-25",
    "25-plus",
  ]);

const VALID_TRACTION =
  new Set([
    "early",
    "growing",
    "established",
    "mature",
  ]);

/*
  This mirrors the existing production Rater behavior.
  It is intentionally lightweight and instance-local.

  Turnstile remains the primary abuse-control layer.
*/
const rateLimitStore =
  new Map();


/* =========================================================
   RESPONSE HELPERS
========================================================= */

function jsonResponse(
  status,
  body
) {
  return Response.json(
    body,
    {
      status,

      headers: {
        "Cache-Control":
          "no-store",
      },
    }
  );
}


/* =========================================================
   REQUEST / RATE LIMIT HELPERS
========================================================= */

function getClientIp(
  request,
  context
) {
  return (
    context?.ip ||
    request.headers.get(
      "x-nf-client-connection-ip"
    ) ||
    request.headers.get(
      "client-ip"
    ) ||
    request.headers
      .get(
        "x-forwarded-for"
      )
      ?.split(",")[0]
      ?.trim() ||
    "unknown"
  );
}


function checkRateLimit(
  ip
) {
  const now =
    Date.now();

  const windowMs =
    60 * 60 * 1000;

  const maxRequests =
    3;

  const record =
    rateLimitStore.get(ip) || {
      count:
        0,

      resetAt:
        now +
        windowMs,
    };

  if (
    now >
    record.resetAt
  ) {
    rateLimitStore.set(
      ip,
      {
        count:
          1,

        resetAt:
          now +
          windowMs,
      }
    );

    return true;
  }

  if (
    record.count >=
    maxRequests
  ) {
    return false;
  }

  record.count +=
    1;

  rateLimitStore.set(
    ip,
    record
  );

  return true;
}


/* =========================================================
   TURNSTILE
========================================================= */

async function verifyTurnstile(
  token,
  ip
) {
  if (
    !process.env
      .TURNSTILE_SECRET_KEY
  ) {
    return {
      success:
        false,

      message:
        "TURNSTILE_SECRET_KEY is missing from Netlify.",

      hostname:
        null,
    };
  }

  if (!token) {
    return {
      success:
        false,

      message:
        "Turnstile verification is missing.",

      hostname:
        null,
    };
  }

  const formData =
    new URLSearchParams();

  formData.append(
    "secret",
    process.env
      .TURNSTILE_SECRET_KEY
  );

  formData.append(
    "response",
    token
  );

  if (
    ip &&
    ip !==
      "unknown"
  ) {
    formData.append(
      "remoteip",
      ip
    );
  }

  const response =
    await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method:
          "POST",

        body:
          formData,
      }
    );

  const data =
    await response.json();

  return {
    success:
      data.success ===
      true,

    message:
      data["error-codes"]
        ?.join(", ") ||
      "Turnstile verification failed.",

    hostname:
      data.hostname ||
      null,
  };
}


/* =========================================================
   BUSINESS NORMALIZATION / VALIDATION
========================================================= */

function cleanString(
  value,
  maxLength
) {
  return String(
    value || ""
  )
    .trim()
    .replace(
      /[\u0000-\u001F\u007F]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .slice(
      0,
      maxLength
    );
}


function normalizeBusiness(
  input
) {
  const business =
    input &&
    typeof input ===
      "object"
      ? input
      : {};

  return {
    name:
      cleanString(
        business.name,
        MAX_NAME_LENGTH
      ),

    website:
      cleanString(
        business.website,
        MAX_URL_LENGTH
      ),

    description:
      cleanString(
        business.description,
        MAX_DESCRIPTION_LENGTH
      ),

    audience:
      cleanString(
        business.audience,
        MAX_AUDIENCE_LENGTH
      ),

    yearsInBusiness:
      cleanString(
        business.yearsInBusiness,
        40
      ),

    teamSize:
      cleanString(
        business.teamSize,
        40
      ),

    traction:
      cleanString(
        business.traction,
        40
      ),

    brandConcern:
      cleanString(
        business.brandConcern,
        MAX_CONCERN_LENGTH
      ),

    twelveMonthGoal:
      cleanString(
        business.twelveMonthGoal,
        MAX_GOAL_LENGTH
      ),
  };
}


function validateOptionalWebsite(
  website
) {
  if (!website) {
    return null;
  }

  try {
    const url =
      new URL(
        website
      );

    if (
      ![
        "http:",
        "https:",
      ].includes(
        url.protocol
      )
    ) {
      return (
        "Please enter a valid website URL or leave the field blank."
      );
    }
  }
  catch {
    return (
      "Please enter a valid website URL or leave the field blank."
    );
  }

  return null;
}


function validateBusiness(
  business
) {
  if (!business.name) {
    return (
      "The business / brand name is required."
    );
  }

  if (!business.description) {
    return (
      "Please describe what the business does."
    );
  }

  if (!business.audience) {
    return (
      "Please describe the primary audience."
    );
  }

  if (
    !VALID_YEARS_IN_BUSINESS
      .has(
        business
          .yearsInBusiness
      )
  ) {
    return (
      "Select a valid operating-history option."
    );
  }

  if (
    !VALID_TEAM_SIZES
      .has(
        business.teamSize
      )
  ) {
    return (
      "Select a valid team-size option."
    );
  }

  if (
    !VALID_TRACTION
      .has(
        business.traction
      )
  ) {
    return (
      "Select a valid customer-traction option."
    );
  }

  if (!business.brandConcern) {
    return (
      "Select the primary brand concern."
    );
  }

  if (!business.twelveMonthGoal) {
    return (
      "Please describe the 12-month business goal."
    );
  }

  return (
    validateOptionalWebsite(
      business.website
    )
  );
}


/* =========================================================
   NETLIFY BLOBS
========================================================= */

function getJobStore() {
  return getStore({
    name:
      JOB_STORE_NAME,

    consistency:
      "strong",
  });
}


function getAssessmentStore() {
  return getStore({
    name:
      ASSESSMENT_STORE_NAME,

    consistency:
      "strong",
  });
}


function getJobKey(
  jobId
) {
  return (
    `jobs/${jobId}`
  );
}


function getAssessmentKey(
  assessmentId
) {
  return (
    `assessment/${assessmentId}`
  );
}


/* =========================================================
   RE-RATE BASELINE VALIDATION
========================================================= */

function hashAccessToken(
  token
) {
  return createHash(
    "sha256"
  )
    .update(
      String(
        token || ""
      )
    )
    .digest(
      "hex"
    );
}


function accessTokenMatches(
  token,
  expectedHash
) {
  const supplied =
    Buffer.from(
      hashAccessToken(
        token
      ),
      "hex"
    );

  const expected =
    Buffer.from(
      String(
        expectedHash || ""
      ),
      "hex"
    );

  return (
    supplied.length ===
      expected.length &&
    timingSafeEqual(
      supplied,
      expected
    )
  );
}


async function validateReRateBaseline({
  baselineAssessmentId,
  baselineAccessToken,
}) {
  const hasAssessmentId =
    Boolean(
      String(
        baselineAssessmentId ||
        ""
      ).trim()
    );

  const hasAccessToken =
    Boolean(
      String(
        baselineAccessToken ||
        ""
      ).trim()
    );

  if (
    !hasAssessmentId &&
    !hasAccessToken
  ) {
    return {
      baseline:
        null,

      baselineAssessmentId:
        null,
    };
  }

  if (
    !hasAssessmentId ||
    !hasAccessToken
  ) {
    throw new Error(
      "Both the baseline assessment ID and private access token are required for a Re-Rate."
    );
  }

  const assessmentId =
    String(
      baselineAssessmentId
    )
      .trim()
      .slice(
        0,
        160
      );

  const assessments =
    getAssessmentStore();

  const baseline =
    await assessments.get(
      getAssessmentKey(
        assessmentId
      ),
      {
        type:
          "json",
      }
    );

  if (
    !baseline ||
    !accessTokenMatches(
      baselineAccessToken,
      baseline.accessTokenHash
    )
  ) {
    throw new Error(
      "The private Re-Rate reference is invalid or no longer available."
    );
  }

  return {
    baseline,

    baselineAssessmentId:
      assessmentId,
  };
}


/* =========================================================
   JOB CREATION
========================================================= */

function createJobId() {
  return (
    `rate_${randomUUID()}`
  );
}


function validateAssetCount(
  value
) {
  const assetCount =
    Number(
      value
    );

  if (
    !Number.isInteger(
      assetCount
    ) ||
    assetCount <
      MIN_ASSETS ||
    assetCount >
      MAX_ASSETS
  ) {
    throw new Error(
      `Brand Rater currently supports ${MIN_ASSETS}–${MAX_ASSETS} brand assets.`
    );
  }

  return assetCount;
}


function createJobRecord({
  jobId,
  business,
  assetCount,
  baselineAssessmentId,
  turnstileHostname,
}) {
  const now =
    new Date();

  const expiresAt =
    new Date(
      now.getTime() +
      JOB_RETENTION_HOURS *
        60 *
        60 *
        1000
    );

  return {
    version:
      JOB_VERSION,

    jobId,

    jobType:
      "brand-rate",

    status:
      "awaiting-assets",

    stage:
      "creating-job",

    progress:
      5,

    message:
      "Brand Health job created. Waiting for brand assets.",

    business,

    assetCount,

    uploadedAssetCount:
      0,

    assets:
      [],

    baselineAssessmentId:
      baselineAssessmentId ||
      null,

    baselineVerified:
      Boolean(
        baselineAssessmentId
      ),

    result:
      null,

    error:
      null,

    createdAt:
      now.toISOString(),

    updatedAt:
      now.toISOString(),

    expiresAt:
      expiresAt
        .toISOString(),

    uploadCompletedAt:
      null,

    workerQueuedAt:
      null,

    workerQueueStatus:
      null,

    processingStartedAt:
      null,

    processingAttempt:
      0,

    completedAt:
      null,

    failedAt:
      null,

    assessmentId:
      null,

    assessmentSavedAt:
      null,

    turnstile: {
      verified:
        true,

      hostname:
        turnstileHostname ||
        null,
    },
  };
}


async function persistNewJob({
  jobs,
  job,
}) {
  let nextJob =
    job;

  /*
    UUID collisions are extraordinarily unlikely,
    but onlyIfNew prevents accidental overwrites.
  */
  for (
    let attempt = 0;
    attempt < 3;
    attempt += 1
  ) {
    const result =
      await jobs.setJSON(
        getJobKey(
          nextJob.jobId
        ),

        nextJob,

        {
          onlyIfNew:
            true,

          metadata: {
            type:
              "brand-rate-job",

            version:
              JOB_VERSION,

            createdAt:
              nextJob.createdAt,

            expiresAt:
              nextJob.expiresAt,
          },
        }
      );

    if (
      result?.modified !==
      false
    ) {
      return nextJob;
    }

    nextJob = {
      ...nextJob,

      jobId:
        createJobId(),
    };
  }

  throw new Error(
    "Could not create a unique Brand Rater Job ID."
  );
}


/* =========================================================
   FUNCTIONS API V2 HANDLER
========================================================= */

export default async function handler(
  request,
  context
) {
  if (
    request.method !==
      "POST"
  ) {
    return jsonResponse(
      405,
      {
        success:
          false,

        error:
          "Method not allowed.",
      }
    );
  }

  try {
    let body;

    try {
      body =
        await request.json();
    }
    catch {
      return jsonResponse(
        400,
        {
          success:
            false,

          error:
            "The Brand Rater request was not valid JSON.",
        }
      );
    }

    const ip =
      getClientIp(
        request,
        context
      );

    /*
      Preserve production behavior:
      verify the human challenge before consuming one of
      the lightweight hourly Rate attempts.
    */
    const turnstile =
      await verifyTurnstile(
        body.turnstileToken,
        ip
      );

    if (
      !turnstile.success
    ) {
      return jsonResponse(
        403,
        {
          success:
            false,

          error:
            turnstile.message,
        }
      );
    }

    if (
      !checkRateLimit(
        ip
      )
    ) {
      return jsonResponse(
        429,
        {
          success:
            false,

          error:
            "Too many brand rating attempts. Please try again later.",
        }
      );
    }

    const business =
      normalizeBusiness(
        body.business
      );

    const businessError =
      validateBusiness(
        business
      );

    if (
      businessError
    ) {
      return jsonResponse(
        400,
        {
          success:
            false,

          error:
            businessError,
        }
      );
    }

    let assetCount;

    try {
      assetCount =
        validateAssetCount(
          body.assetCount
        );
    }
    catch (
      error
    ) {
      return jsonResponse(
        400,
        {
          success:
            false,

          error:
            error.message,
        }
      );
    }

    let baselineInfo;

    try {
      baselineInfo =
        await validateReRateBaseline({
          baselineAssessmentId:
            body.baselineAssessmentId,

          baselineAccessToken:
            body.baselineAccessToken,
        });
    }
    catch (
      error
    ) {
      return jsonResponse(
        403,
        {
          success:
            false,

          error:
            error.message,
        }
      );
    }

    const jobs =
      getJobStore();

    const initialJob =
      createJobRecord({
        jobId:
          createJobId(),

        business,

        assetCount,

        baselineAssessmentId:
          baselineInfo
            .baselineAssessmentId,

        turnstileHostname:
          turnstile.hostname,
      });

    const job =
      await persistNewJob({
        jobs,

        job:
          initialJob,
      });

    console.log(
      `Created production Brand Rater Rate job ${job.jobId}.`
    );

    return jsonResponse(
      201,
      {
        success:
          true,

        jobId:
          job.jobId,

        status:
          job.status,

        stage:
          job.stage,

        progress:
          job.progress,

        message:
          job.message,

        assetCount:
          job.assetCount,

        reRate:
          Boolean(
            job.baselineAssessmentId
          ),

        expiresAt:
          job.expiresAt,
      }
    );
  }
  catch (
    error
  ) {
    console.error(
      "Brand Rater create-rate-job error:",
      error
    );

    return jsonResponse(
      500,
      {
        success:
          false,

        error:
          error?.message ||
          "Something went wrong while creating the Brand Rater job.",
      }
    );
  }
}
