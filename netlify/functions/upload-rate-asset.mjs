/*
  Brand Rater Enterprise
  upload-rate-asset.mjs
  ------------------------------------------------------------
  Production Rate async architecture v1.0

  Purpose:
  - Accept ONE production Brand Rater asset per request.
  - Validate the Rate job and requested asset index.
  - Decode and validate the image.
  - Store raw image bytes in Netlify Blobs.
  - Update the Rate job's asset metadata.
  - Queue process-rate.mjs after the complete asset set arrives.

  Expected frontend payload:
  {
    jobId,
    assetIndex,
    assetName,
    mimeType,
    dataUrl
  }

  Required package:
  - @netlify/blobs
*/

import {
  getStore,
} from "@netlify/blobs";


const JOB_STORE_NAME =
  "brand-rater-rate-jobs";

const ASSET_STORE_NAME =
  "brand-rater-rate-assets";

const MAX_ASSETS = 5;

const MAX_ASSET_BYTES =
  4 * 1024 * 1024;

const ALLOWED_MIME_TYPES =
  new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
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

  return {
    jobs,
    assets,
  };
}


function getJobKey(
  jobId
) {
  return (
    `jobs/${jobId}`
  );
}


function getAssetKey({
  jobId,
  assetIndex,
}) {
  /*
    Deterministic keys make upload retries idempotent.
    Re-uploading asset 2 replaces only asset 2.
  */
  const paddedIndex =
    String(
      assetIndex
    )
      .padStart(
        3,
        "0"
      );

  return (
    `jobs/${jobId}/assets/${paddedIndex}`
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


function normalizeAssetName(
  value,
  assetIndex
) {
  const fallback =
    `Brand asset ${assetIndex + 1}`;

  if (
    typeof value !==
      "string"
  ) {
    return fallback;
  }

  const cleaned =
    value
      .trim()
      .replace(
        /[\u0000-\u001F\u007F]/g,
        ""
      )
      .slice(
        0,
        180
      );

  return (
    cleaned ||
    fallback
  );
}


function normalizeAssets(
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
      item =>
        item &&
        Number.isInteger(
          item.index
        ) &&
        typeof item.blobKey ===
          "string" &&
        item.blobKey.trim()
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


function decodeImageDataUrl({
  dataUrl,
  mimeType,
}) {
  if (
    !ALLOWED_MIME_TYPES
      .has(
        mimeType
      )
  ) {
    throw new Error(
      "Only PNG, JPG, and WEBP brand images are supported."
    );
  }

  if (
    typeof dataUrl !==
      "string"
  ) {
    throw new Error(
      "The uploaded image data is missing."
    );
  }

  const prefix =
    `data:${mimeType};base64,`;

  if (
    !dataUrl.startsWith(
      prefix
    )
  ) {
    throw new Error(
      "The uploaded image data does not match its file type."
    );
  }

  const base64 =
    dataUrl.slice(
      prefix.length
    );

  if (!base64) {
    throw new Error(
      "The uploaded image is empty."
    );
  }

  /*
    Reject obviously malformed base64 before decoding.
  */
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/
      .test(
        base64
      )
  ) {
    throw new Error(
      "The uploaded image data is invalid."
    );
  }

  const buffer =
    Buffer.from(
      base64,
      "base64"
    );

  if (
    !buffer.length
  ) {
    throw new Error(
      "The uploaded image is empty."
    );
  }

  if (
    buffer.length >
      MAX_ASSET_BYTES
  ) {
    throw new Error(
      "This image is larger than the 4 MB per-file production limit."
    );
  }

  return buffer;
}


function calculateUploadProgress(
  uploadedCount,
  expectedCount
) {
  const safeExpected =
    Math.max(
      1,
      Number(
        expectedCount
      ) || 1
    );

  const ratio =
    Math.min(
      1,
      uploadedCount /
        safeExpected
    );

  /*
    Shared async progress model:
    5%  = job created
    12% = uploads begin
    34% = uploads complete
    38% = background analysis queued
  */
  return Math.round(
    12 +
    ratio * 22
  );
}


/* =========================================================
   BACKGROUND PROCESSOR
========================================================= */

async function queueBackgroundAnalysis({
  request,
  jobId,
}) {
  /*
    Build from the current request URL so this works on:
    - production
    - deploy previews
    - local Netlify development
  */
  const endpoint =
    new URL(
      "/.netlify/functions/process-rate",
      request.url
    );

  const response =
    await fetch(
      endpoint,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            jobId,
          }),
      }
    );

  if (
    !response.ok
  ) {
    const errorText =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      errorText ||
      `Background Brand Rater analysis could not be queued (${response.status}).`
    );
  }

  return response.status;
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
            "The Brand Rater upload request was not valid JSON.",
        }
      );
    }

    const jobId =
      String(
        body.jobId ||
        ""
      )
        .trim();

    const assetIndex =
      Number(
        body.assetIndex
      );

    const mimeType =
      String(
        body.mimeType ||
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

    if (
      !Number.isInteger(
        assetIndex
      ) ||
      assetIndex < 0 ||
      assetIndex >=
        MAX_ASSETS
    ) {
      return jsonResponse(
        400,
        {
          success:
            false,

          error:
            "The Brand Rater asset index is invalid.",
        }
      );
    }

    const assetName =
      normalizeAssetName(
        body.assetName,
        assetIndex
      );

    let imageBuffer;

    try {
      imageBuffer =
        decodeImageDataUrl({
          dataUrl:
            body.dataUrl,

          mimeType,
        });
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

    const {
      jobs,
      assets,
    } =
      getBlobStores();

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
            "This Brand Rater job could not be found.",
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
            "This job is not a production Brand Rater Rate job.",
        }
      );
    }

    const expectedAssetCount =
      Number(
        job.assetCount
      );

    if (
      !Number.isInteger(
        expectedAssetCount
      ) ||
      expectedAssetCount < 1 ||
      expectedAssetCount >
        MAX_ASSETS
    ) {
      return jsonResponse(
        409,
        {
          success:
            false,

          error:
            "This Brand Rater job has an invalid asset configuration.",
        }
      );
    }

    if (
      assetIndex >=
        expectedAssetCount
    ) {
      return jsonResponse(
        400,
        {
          success:
            false,

          error:
            "This asset exceeds the number of images registered for the Brand Rater job.",
        }
      );
    }

    /*
      Once a worker has been queued or processing has begun,
      the analysis input must become immutable.

      If a network retry reaches this endpoint after the
      worker was successfully queued, the frontend can recover
      by polling rate-status.mjs instead of mutating the job.
    */
    if (
      job.workerQueuedAt ||
      [
        "queued",
        "processing",
        "complete",
        "failed",
      ].includes(
        job.status
      )
    ) {
      return jsonResponse(
        409,
        {
          success:
            false,

          error:
            job.status ===
              "complete"
              ? "This Brand Rater assessment is already complete."
              : job.status ===
                  "failed"
                ? "This Brand Rater job has already failed and can no longer accept uploads."
                : "This Brand Rater job has already been queued for analysis and can no longer accept asset changes.",

          jobId,

          status:
            job.status,

          recoverByPolling:
            [
              "queued",
              "processing",
              "complete",
            ].includes(
              job.status
            ),
        }
      );
    }

    const assetKey =
      getAssetKey({
        jobId,
        assetIndex,
      });

    /*
      Store raw binary bytes, not the original base64 data URL.
    */
    const imageBlob =
      new Blob(
        [
          imageBuffer,
        ],
        {
          type:
            mimeType,
        }
      );

    await assets.set(
      assetKey,
      imageBlob,
      {
        metadata: {
          jobId,

          assetIndex,

          assetName,

          mimeType,

          byteSize:
            imageBuffer.length,

          uploadedAt:
            new Date()
              .toISOString(),
        },
      }
    );

    const existingAssets =
      normalizeAssets(
        job.assets
      );

    /*
      Replace an existing entry for this index.
      This makes retries safe before analysis is queued.
    */
    const nextAssets =
      existingAssets
        .filter(
          item =>
            item.index !==
            assetIndex
        );

    nextAssets.push({
      index:
        assetIndex,

      blobKey:
        assetKey,

      name:
        assetName,

      mimeType,

      byteSize:
        imageBuffer.length,
    });

    nextAssets.sort(
      (
        a,
        b
      ) =>
        a.index -
        b.index
    );

    const uploadedAssetCount =
      nextAssets.length;

    const allAssetsUploaded =
      uploadedAssetCount ===
      expectedAssetCount;

    const hasCompleteIndexSet =
      allAssetsUploaded &&
      nextAssets.every(
        (
          item,
          index
        ) =>
          item.index ===
          index
      );

    if (
      allAssetsUploaded &&
      !hasCompleteIndexSet
    ) {
      return jsonResponse(
        409,
        {
          success:
            false,

          error:
            "The Brand Rater upload set is incomplete or contains an unexpected asset index.",
        }
      );
    }

    const now =
      new Date()
        .toISOString();

    let updatedJob = {
      ...job,

      assets:
        nextAssets,

      uploadedAssetCount,

      status:
        allAssetsUploaded
          ? "queued"
          : "uploading",

      stage:
        allAssetsUploaded
          ? "queued"
          : "uploading-assets",

      progress:
        allAssetsUploaded
          ? 38
          : calculateUploadProgress(
              uploadedAssetCount,
              expectedAssetCount
            ),

      message:
        allAssetsUploaded
          ? "Brand assets uploaded. Assessment queued for analysis."
          : `Uploaded ${uploadedAssetCount} of ${expectedAssetCount} brand assets.`,
    };

    if (
      allAssetsUploaded
    ) {
      updatedJob.uploadCompletedAt =
        now;
    }

    updatedJob =
      await writeJob(
        jobs,
        updatedJob
      );

    let backgroundStatus =
      null;

    if (
      allAssetsUploaded
    ) {
      try {
        backgroundStatus =
          await queueBackgroundAnalysis({
            request,
            jobId,
          });

        /*
          IMPORTANT:
          Reload the newest job after queueing the worker.

          A background function can advance the job before this
          request finishes. Writing from the old queued snapshot
          could otherwise overwrite newer processing/completed
          state. This mirrors the race-condition safeguard used
          in the newer Start/Compare architecture.
        */
        const latestJob =
          await readJob(
            jobs,
            jobId
          );

        updatedJob = {
          ...(
            latestJob ||
            updatedJob
          ),

          workerQueuedAt:
            new Date()
              .toISOString(),

          workerQueueStatus:
            backgroundStatus,
        };

        updatedJob =
          await writeJob(
            jobs,
            updatedJob
          );
      }
      catch (
        error
      ) {
        console.error(
          "Background Brand Rater queue error:",
          error
        );

        /*
          Reload before writing failure state so a worker that
          actually completed successfully is never overwritten
          by a late queue-response error.
        */
        const latestJob =
          await readJob(
            jobs,
            jobId
          );

        if (
          latestJob?.status ===
            "complete" &&
          latestJob?.result
        ) {
          return jsonResponse(
            200,
            {
              success:
                true,

              jobId,

              uploadedAssetCount:
                latestJob
                  .uploadedAssetCount,

              expectedAssetCount,

              allAssetsUploaded:
                true,

              status:
                latestJob.status,

              stage:
                latestJob.stage,

              progress:
                latestJob.progress,

              message:
                latestJob.message,

              backgroundQueued:
                true,

              recoveredFromQueueRace:
                true,
            }
          );
        }

        const failureBase =
          latestJob ||
          updatedJob;

        const failedJob = {
          ...failureBase,

          status:
            "failed",

          stage:
            "failed",

          message:
            "The brand assets uploaded successfully, but background analysis could not be started.",

          error:
            String(
              error?.message ||
              "Background Brand Rater analysis could not be started."
            )
              .slice(
                0,
                1200
              ),

          failedAt:
            new Date()
              .toISOString(),
        };

        await writeJob(
          jobs,
          failedJob
        );

        return jsonResponse(
          502,
          {
            success:
              false,

            error:
              "The brand assets were uploaded, but Brand Rater could not start the background analysis. Please try again.",

            jobId,
          }
        );
      }
    }

    return jsonResponse(
      200,
      {
        success:
          true,

        jobId,

        asset: {
          index:
            assetIndex,

          name:
            assetName,

          mimeType,

          byteSize:
            imageBuffer.length,
        },

        uploadedAssetCount,

        expectedAssetCount,

        allAssetsUploaded,

        status:
          updatedJob.status,

        stage:
          updatedJob.stage,

        progress:
          updatedJob.progress,

        message:
          updatedJob.message,

        backgroundQueued:
          allAssetsUploaded,

        backgroundStatus,
      }
    );
  }
  catch (
    error
  ) {
    console.error(
      "Brand Rater asset upload error:",
      error
    );

    return jsonResponse(
      500,
      {
        success:
          false,

        error:
          error?.message ||
          "Something went wrong while uploading the Brand Rater asset.",
      }
    );
  }
}
