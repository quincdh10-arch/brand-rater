/*
  Brand Rater Enterprise
  rate-status.mjs
  ------------------------------------------------------------
  Production Rate async architecture v1.0

  Purpose:
  - Let the production Brand Rater frontend poll an active Rate job.
  - Return progress while assets upload / analysis runs.
  - Return the completed Brand Health result only when ready.
  - Return a safe failure message if processing fails.
  - Never expose raw uploaded asset data or internal job metadata.

  Request:
  GET /.netlify/functions/rate-status?jobId=rate_<uuid>

  Required package:
  - @netlify/blobs
*/

import {
  getStore,
} from "@netlify/blobs";


const JOB_STORE_NAME =
  "brand-rater-rate-jobs";

const PUBLIC_STATUSES =
  new Set([
    "awaiting-assets",
    "uploading",
    "queued",
    "processing",
    "complete",
    "failed",
  ]);


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
          "no-store, max-age=0",

        "Pragma":
          "no-cache",
      },
    }
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


function getJobKey(
  jobId
) {
  return (
    `jobs/${jobId}`
  );
}


async function readJob(
  jobs,
  jobId
) {
  return await jobs.get(
    getJobKey(
      jobId
    ),
    {
      type:
        "json",
    }
  );
}


/* =========================================================
   VALIDATION / NORMALIZATION
========================================================= */

function isValidJobId(
  value
) {
  return (
    typeof value ===
      "string" &&

    /^rate_[A-Za-z0-9_-]{8,100}$/
      .test(
        value
      )
  );
}


function normalizeProgress(
  value
) {
  const number =
    Number(
      value
    );

  if (
    !Number.isFinite(
      number
    )
  ) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        number
      )
    )
  );
}


function safeString(
  value,
  maxLength = 1200
) {
  return String(
    value || ""
  )
    .trim()
    .slice(
      0,
      maxLength
    );
}


function normalizeStatus(
  value
) {
  const status =
    safeString(
      value,
      60
    );

  return (
    PUBLIC_STATUSES.has(
      status
    )
      ? status
      : "processing"
  );
}


/* =========================================================
   PUBLIC JOB SHAPE
========================================================= */

function buildPublicStatus(
  job
) {
  const status =
    normalizeStatus(
      job.status
    );

  const response = {
    success:
      true,

    jobId:
      job.jobId,

    status,

    stage:
      safeString(
        job.stage ||
        status,
        100
      ),

    progress:
      normalizeProgress(
        job.progress
      ),

    message:
      safeString(
        job.message ||
        "",
        500
      ),

    uploadedAssetCount:
      Number(
        job.uploadedAssetCount
      ) || 0,

    assetCount:
      Number(
        job.assetCount
      ) || 0,

    reRate:
      Boolean(
        job.baselineAssessmentId
      ),

    createdAt:
      job.createdAt ||
      null,

    updatedAt:
      job.updatedAt ||
      null,

    expiresAt:
      job.expiresAt ||
      null,
  };

  /*
    Only completed jobs expose the result.
    Raw asset metadata and business intake are never returned
    through this polling endpoint.
  */
  if (
    status ===
      "complete"
  ) {
    response.result =
      job.result ||
      null;

    response.completedAt =
      job.completedAt ||
      null;

    response.assessmentId =
      job.assessmentId ||
      job.result
        ?.assessmentMeta
        ?.assessmentId ||
      null;
  }

  if (
    status ===
      "failed"
  ) {
    response.error =
      safeString(
        job.error ||
        "Brand Rater could not complete this assessment.",
        1200
      );

    response.failedAt =
      job.failedAt ||
      null;
  }

  return response;
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
      "GET"
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
    const url =
      new URL(
        request.url
      );

    const jobId =
      String(
        url.searchParams.get(
          "jobId"
        ) ||
        ""
      )
        .trim();

    if (
      !isValidJobId(
        jobId
      )
    ) {
      return jsonResponse(
        400,
        {
          success:
            false,

          error:
            "The Brand Rater Job ID is invalid.",
        }
      );
    }

    const jobs =
      getJobStore();

    const job =
      await readJob(
        jobs,
        jobId
      );

    if (!job) {
      return jsonResponse(
        404,
        {
          success:
            false,

          error:
            "This Brand Rater job could not be found or is no longer available.",
        }
      );
    }

    if (
      job.jobType !==
        "brand-rate"
    ) {
      return jsonResponse(
        409,
        {
          success:
            false,

          error:
            "This Job ID does not belong to a production Brand Rater assessment.",
        }
      );
    }

    return jsonResponse(
      200,
      buildPublicStatus(
        job
      )
    );
  }
  catch (
    error
  ) {
    console.error(
      "Brand Rater rate-status error:",
      error
    );

    return jsonResponse(
      500,
      {
        success:
          false,

        error:
          "Brand Rater could not read the assessment status. Please try again.",
      }
    );
  }
}
