/*
  Brand Rater Enterprise
  process-rate.mjs
  ------------------------------------------------------------
  Production Rate async architecture v1.0

  Purpose:
  - Run the long Brand Health assessment in the background.
  - Load the Rate job from Netlify Blobs.
  - Load all previously uploaded brand assets.
  - Reconstruct image data URLs for rate-engine.js.
  - Run the existing Brand Rater V2 methodology.
  - Preserve Re-Rate before/after comparison behavior.
  - Save the completed assessment baseline.
  - Save progress and the final result back to the Rate job.
  - Remove temporary raw image assets after successful completion.

  Required files:
  - rate-engine.js
  - create-rate-job.mjs
  - upload-rate-asset.mjs

  Required package:
  - @netlify/blobs

  Required environment variable:
  - OPENAI_API_KEY

  IMPORTANT:
  This is a Netlify Background Function.
*/

import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import {
  createRequire,
} from "node:module";

import {
  getStore,
} from "@netlify/blobs";


const require =
  createRequire(
    import.meta.url
  );

const {
  analyzeRate,
  buildAssessmentComparison,
  SCORING_VERSION,
} =
  require(
    "./rate-engine.js"
  );


export const config = {
  background:
    true,
};


const JOB_STORE_NAME =
  "brand-rater-rate-jobs";

const ASSET_STORE_NAME =
  "brand-rater-rate-assets";

const ASSESSMENT_STORE_NAME =
  "brand-rater-assessments";

const MAX_ASSETS = 5;

const MAX_PROCESSING_ATTEMPTS =
  3;

/*
  Protect against duplicate background invocations while still
  allowing a stale worker to be recovered later.
*/
const PROCESSING_LOCK_MINUTES =
  18;


/* =========================================================
   RESPONSE HELPER
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
   NETLIFY BLOBS
========================================================= */

function getBlobStores() {
  const jobs =
    getStore({
      name:
        JOB_STORE_NAME,

      consistency:
        "strong",
    });

  const assets =
    getStore({
      name:
        ASSET_STORE_NAME,

      consistency:
        "strong",
    });

  const assessments =
    getStore({
      name:
        ASSESSMENT_STORE_NAME,

      consistency:
        "strong",
    });

  return {
    jobs,
    assets,
    assessments,
  };
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


async function writeJob(
  jobs,
  job
) {
  const updatedJob = {
    ...job,

    updatedAt:
      new Date()
        .toISOString(),
  };

  await jobs.setJSON(
    getJobKey(
      job.jobId
    ),

    updatedJob
  );

  return updatedJob;
}


/* =========================================================
   VALIDATION
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


function normalizeJobAssets(
  value
) {
  if (
    !Array.isArray(
      value
    )
  ) {
    return [];
  }

  return value
    .filter(
      asset =>
        asset &&
        Number.isInteger(
          asset.index
        ) &&
        typeof asset.blobKey ===
          "string" &&
        asset.blobKey.trim()
    )
    .sort(
      (
        a,
        b
      ) =>
        a.index -
        b.index
    );
}


function validateJob(
  job
) {
  if (
    !job ||
    typeof job !==
      "object"
  ) {
    throw new Error(
      "The Brand Rater job could not be found."
    );
  }

  if (
    !isValidJobId(
      job.jobId
    )
  ) {
    throw new Error(
      "The Brand Rater Job ID is invalid."
    );
  }

  if (
    job.jobType !==
      "brand-rate"
  ) {
    throw new Error(
      "This job is not a production Brand Rater Rate job."
    );
  }

  const assetCount =
    Number(
      job.assetCount
    );

  if (
    !Number.isInteger(
      assetCount
    ) ||
    assetCount < 1 ||
    assetCount >
      MAX_ASSETS
  ) {
    throw new Error(
      "The Brand Rater job contains an invalid number of assets."
    );
  }

  const assets =
    normalizeJobAssets(
      job.assets
    );

  if (
    assets.length !==
      assetCount
  ) {
    throw new Error(
      `The Brand Rater job expected ${assetCount} assets but only ${assets.length} uploaded assets were found.`
    );
  }

  const completeIndexSet =
    assets.every(
      (
        asset,
        index
      ) =>
        asset.index ===
        index
    );

  if (
    !completeIndexSet
  ) {
    throw new Error(
      "The uploaded Brand Rater assets do not form a complete set."
    );
  }

  if (
    !job.business ||
    typeof job.business !==
      "object"
  ) {
    throw new Error(
      "The Brand Rater business context is missing."
    );
  }

  return {
    assetCount,
    assets,
  };
}


/* =========================================================
   PROCESSING LOCK
========================================================= */

function hasActiveProcessingLock(
  job
) {
  if (
    job.status !==
      "processing" ||
    !job.processingStartedAt
  ) {
    return false;
  }

  const startedAt =
    Date.parse(
      job.processingStartedAt
    );

  if (
    !Number.isFinite(
      startedAt
    )
  ) {
    return false;
  }

  const lockWindow =
    PROCESSING_LOCK_MINUTES *
    60 *
    1000;

  return (
    Date.now() -
      startedAt <
    lockWindow
  );
}


/* =========================================================
   JOB PROGRESS
========================================================= */

async function updateProgress({
  jobs,
  jobId,
  stage,
  progress,
  message,
}) {
  /*
    Reload before every write so worker progress cannot erase
    newer metadata written by the upload request.
  */
  const latest =
    await readJob(
      jobs,
      jobId
    );

  if (!latest) {
    throw new Error(
      "The Brand Rater job disappeared while processing."
    );
  }

  const nextJob = {
    ...latest,

    status:
      "processing",

    stage,

    progress,

    message,
  };

  return await writeJob(
    jobs,
    nextJob
  );
}


/* =========================================================
   IMAGE LOADING
========================================================= */

function getMimeType(
  asset
) {
  const mimeType =
    String(
      asset.mimeType ||
      ""
    )
      .trim();

  if (
    [
      "image/png",
      "image/jpeg",
      "image/webp",
    ].includes(
      mimeType
    )
  ) {
    return mimeType;
  }

  throw new Error(
    `The stored file type for "${asset.name || "brand asset"}" is not supported.`
  );
}


async function loadRateAsset({
  assets,
  asset,
}) {
  const arrayBuffer =
    await assets.get(
      asset.blobKey,
      {
        type:
          "arrayBuffer",
      }
    );

  if (
    arrayBuffer ===
      null
  ) {
    throw new Error(
      `The stored Brand Rater asset "${asset.name || asset.blobKey}" could not be found.`
    );
  }

  const buffer =
    Buffer.from(
      arrayBuffer
    );

  if (
    !buffer.length
  ) {
    throw new Error(
      `The stored Brand Rater asset "${asset.name || asset.blobKey}" is empty.`
    );
  }

  const mimeType =
    getMimeType(
      asset
    );

  return {
    index:
      asset.index,

    name:
      asset.name ||
      `Brand asset ${asset.index + 1}`,

    type:
      mimeType,

    size:
      buffer.length,

    dataUrl:
      `data:${mimeType};base64,${buffer.toString("base64")}`,
  };
}


async function loadRateAssets({
  assets,
  jobAssets,
}) {
  const loaded =
    await Promise.all(
      jobAssets.map(
        asset =>
          loadRateAsset({
            assets,
            asset,
          })
      )
    );

  return loaded.sort(
    (
      a,
      b
    ) =>
      a.index -
      b.index
  );
}


/* =========================================================
   ASSESSMENT BASELINE
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


async function readBaseline({
  assessments,
  assessmentId,
}) {
  if (!assessmentId) {
    return null;
  }

  return await assessments.get(
    getAssessmentKey(
      assessmentId
    ),
    {
      type:
        "json",
    }
  );
}


async function persistAssessmentBaseline({
  assessments,
  baseline,
}) {
  const result =
    await assessments.setJSON(
      getAssessmentKey(
        baseline.assessmentId
      ),

      baseline,

      {
        onlyIfNew:
          true,
      }
    );

  if (
    result?.modified ===
      false
  ) {
    throw new Error(
      "An assessment with this ID already exists."
    );
  }

  return baseline;
}


/* =========================================================
   TEMPORARY ASSET CLEANUP
========================================================= */

async function cleanupTemporaryAssets({
  assets,
  jobAssets,
}) {
  const failures =
    [];

  for (
    const asset
    of jobAssets
  ) {
    try {
      await assets.delete(
        asset.blobKey
      );
    }
    catch (
      error
    ) {
      failures.push({
        blobKey:
          asset.blobKey,

        error:
          String(
            error?.message ||
            "Delete failed."
          )
            .slice(
              0,
              300
            ),
      });
    }
  }

  return failures;
}


/* =========================================================
   FAILURE HANDLING
========================================================= */

function sanitizeErrorMessage(
  error
) {
  return String(
    error?.message ||
    "Brand Rater analysis failed."
  )
    .trim()
    .slice(
      0,
      1200
    );
}


async function recordFailure({
  jobs,
  jobId,
  attempt,
  error,
}) {
  const latest =
    await readJob(
      jobs,
      jobId
    );

  if (!latest) {
    return;
  }

  /*
    Never replace a completed result with a late failure.
  */
  if (
    latest.status ===
      "complete" &&
    latest.result
  ) {
    return;
  }

  const failedAt =
    new Date()
      .toISOString();

  await writeJob(
    jobs,
    {
      ...latest,

      status:
        "failed",

      stage:
        "failed",

      message:
        "Brand Rater could not complete this assessment.",

      error:
        sanitizeErrorMessage(
          error
        ),

      failedAt,

      processingAttempt:
        attempt,
    }
  );
}


/* =========================================================
   FUNCTIONS API V2 BACKGROUND HANDLER
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

  let jobId =
    "";

  let attempt =
    0;

  let stores =
    null;

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
            "The Brand Rater processing request was not valid JSON.",
        }
      );
    }

    jobId =
      String(
        body.jobId ||
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

    stores =
      getBlobStores();

    const {
      jobs,
      assets,
      assessments,
    } =
      stores;

    let job =
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
            "This Brand Rater job could not be found.",
        }
      );
    }

    /*
      Idempotency:
      if a duplicate worker arrives after completion,
      return without spending another OpenAI call.
    */
    if (
      job.status ===
        "complete" &&
      job.result
    ) {
      return jsonResponse(
        200,
        {
          success:
            true,

          jobId,

          status:
            "complete",

          alreadyComplete:
            true,
        }
      );
    }

    if (
      hasActiveProcessingLock(
        job
      )
    ) {
      return jsonResponse(
        202,
        {
          success:
            true,

          jobId,

          status:
            "processing",

          alreadyProcessing:
            true,
        }
      );
    }

    attempt =
      Number(
        job.processingAttempt
      ) + 1;

    if (
      attempt >
      MAX_PROCESSING_ATTEMPTS
    ) {
      throw new Error(
        "This Brand Rater job exceeded the maximum number of processing attempts."
      );
    }

    const validated =
      validateJob(
        job
      );

    const processingStartedAt =
      new Date()
        .toISOString();

    /*
      Claim the job before loading assets or calling OpenAI.
    */
    job =
      await writeJob(
        jobs,
        {
          ...job,

          status:
            "processing",

          stage:
            "loading-assets",

          progress:
            44,

          message:
            "Preparing brand assets for assessment.",

          processingStartedAt,

          processingAttempt:
            attempt,

          error:
            null,

          failedAt:
            null,
        }
      );

    const loadedImages =
      await loadRateAssets({
        assets,

        jobAssets:
          validated.assets,
      });

    await updateProgress({
      jobs,
      jobId,

      stage:
        "analyzing-brand-evidence",

      progress:
        50,

      message:
        "Reviewing the submitted brand evidence.",
    });

    /*
      Re-Rate credentials were validated before the job was
      created. The background worker stores only the baseline
      assessment ID and retrieves that trusted record here.
    */
    let originalBaseline =
      null;

    if (
      job.baselineAssessmentId
    ) {
      originalBaseline =
        await readBaseline({
          assessments,

          assessmentId:
            job.baselineAssessmentId,
        });

      if (
        !originalBaseline
      ) {
        throw new Error(
          "The verified Re-Rate baseline is no longer available."
        );
      }
    }

    const result =
      await analyzeRate({
        business:
          job.business,

        images:
          loadedImages,

        onStage:
          async ({
            stage,
            progress,
            message,
          }) => {
            await updateProgress({
              jobs,
              jobId,
              stage,
              progress,
              message,
            });
          },
      });

    /*
      Preserve the original production baseline format.
      The engine intentionally leaves assessmentId null because
      persistence belongs to this orchestration layer.
    */
    const assessmentId =
      randomUUID();

    const createdAt =
      result
        ?.assessmentMeta
        ?.createdAt ||
      new Date()
        .toISOString();

    const reRateAccessToken =
      randomBytes(32)
        .toString(
          "hex"
        );

    result.assessmentMeta = {
      ...(
        result.assessmentMeta ||
        {}
      ),

      assessmentId,

      createdAt,

      scoringVersion:
        SCORING_VERSION,

      baselineSaved:
        false,
    };

    if (
      originalBaseline
    ) {
      result.comparison =
        buildAssessmentComparison(
          originalBaseline,
          result
        );
    }

    const submittedAssetMetadata =
      validated.assets.map(
        (
          asset,
          index
        ) => ({
          assetNumber:
            index + 1,

          name:
            String(
              asset.name ||
              `Brand asset ${index + 1}`
            )
              .slice(
                0,
                180
              ),

          type:
            String(
              asset.mimeType ||
              ""
            )
              .slice(
                0,
                80
              ),

          sizeBytes:
            Number(
              asset.byteSize
            ) || 0,
        })
      );

    /*
      Set true for the stored copy, then add the raw private
      Re-Rate token only AFTER successful persistence.

      This ensures the token itself is never stored inside the
      assessment baseline.
    */
    result.assessmentMeta
      .baselineSaved =
        true;

    const baseline = {
      assessmentId,

      recordType:
        "brand-health-baseline",

      status:
        "baseline",

      createdAt,

      updatedAt:
        createdAt,

      scoringVersion:
        SCORING_VERSION,

      accessTokenHash:
        hashAccessToken(
          reRateAccessToken
        ),

      parentBaselineAssessmentId:
        originalBaseline
          ?.assessmentId ||
        null,

      business:
        job.business,

      submittedAssets:
        submittedAssetMetadata,

      scores: {
        overall:
          result.brandHealth,

        categories:
          result.categories,

        brandGap:
          result.brandGap,
      },

      identifiedIssues: {
        biggestOpportunity:
          result.biggestOpportunity,

        evidence:
          result.evidence,

        diagnostics:
          result.diagnostics,
      },

      recommendations: {
        freeRecommendation:
          result.freeRecommendation,

        growthOpportunity:
          result.growthOpportunity,
      },

      comparison:
        result.comparison ||
        null,

      assessment:
        JSON.parse(
          JSON.stringify(
            result
          )
        ),
    };

    let baselineSaved =
      false;

    try {
      await persistAssessmentBaseline({
        assessments,
        baseline,
      });

      baselineSaved =
        true;

      result.assessmentMeta
        .reRateAccessToken =
          reRateAccessToken;
    }
    catch (
      storageError
    ) {
      result.assessmentMeta
        .baselineSaved =
          false;

      console.error(
        "Brand Rater baseline storage error:",
        storageError
      );
    }

    await updateProgress({
      jobs,
      jobId,

      stage:
        "saving-assessment",

      progress:
        98,

      message:
        baselineSaved
          ? "Saving your Brand Health baseline."
          : "Finalizing your Brand Health assessment.",
    });

    /*
      Reload the latest job before completion so a late upload
      response cannot overwrite worker metadata.
    */
    const latest =
      await readJob(
        jobs,
        jobId
      );

    if (!latest) {
      throw new Error(
        "The Brand Rater job disappeared before completion."
      );
    }

    const completedAt =
      new Date()
        .toISOString();

    const completedJob =
      await writeJob(
        jobs,
        {
          ...latest,

          status:
            "complete",

          stage:
            "complete",

          progress:
            100,

          message:
            "Brand Health assessment complete.",

          result,

          error:
            null,

          assessmentId:
            baselineSaved
              ? assessmentId
              : null,

          assessmentSavedAt:
            baselineSaved
              ? completedAt
              : null,

          completedAt,

          failedAt:
            null,
        }
      );

    /*
      Images are temporary analysis inputs. Once the completed
      result is safely stored, remove the raw blobs.
    */
    const cleanupFailures =
      await cleanupTemporaryAssets({
        assets,

        jobAssets:
          validated.assets,
      });

    if (
      cleanupFailures.length
    ) {
      console.warn(
        "Brand Rater temporary asset cleanup had failures:",
        cleanupFailures
      );

      /*
        Record cleanup metadata without altering the successful
        assessment result.
      */
      const cleanupLatest =
        await readJob(
          jobs,
          jobId
        );

      if (
        cleanupLatest?.status ===
          "complete"
      ) {
        await writeJob(
          jobs,
          {
            ...cleanupLatest,

            temporaryAssetCleanup: {
              complete:
                false,

              failedCount:
                cleanupFailures.length,
            },
          }
        );
      }
    }
    else {
      const cleanupLatest =
        await readJob(
          jobs,
          jobId
        );

      if (
        cleanupLatest?.status ===
          "complete"
      ) {
        await writeJob(
          jobs,
          {
            ...cleanupLatest,

            temporaryAssetCleanup: {
              complete:
                true,

              failedCount:
                0,
            },
          }
        );
      }
    }

    console.log(
      `Completed production Brand Rater Rate job ${jobId}.`
    );

    return jsonResponse(
      200,
      {
        success:
          true,

        jobId,

        status:
          completedJob.status,

        assessmentId:
          baselineSaved
            ? assessmentId
            : null,

        baselineSaved,
      }
    );
  }
  catch (
    error
  ) {
    console.error(
      "Brand Rater process-rate error:",
      error
    );

    if (
      stores &&
      jobId
    ) {
      try {
        await recordFailure({
          jobs:
            stores.jobs,

          jobId,

          attempt,

          error,
        });
      }
      catch (
        failureWriteError
      ) {
        console.error(
          "Brand Rater could not save failure state:",
          failureWriteError
        );
      }
    }

    return jsonResponse(
      500,
      {
        success:
          false,

        jobId:
          jobId ||
          null,

        error:
          sanitizeErrorMessage(
            error
          ),
      }
    );
  }
}
