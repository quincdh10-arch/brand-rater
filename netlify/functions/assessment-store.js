/*
  Brand Rater — Assessment Store
  ------------------------------------------------------------
  Persists completed Brand Health assessments as baselines.
  Raw submitted images and data URLs are never stored here.
*/

const ASSESSMENT_STORE_NAME =
  "brand-rater-assessments";

async function connectBlobs(event) {
  if (!event) {
    throw new Error(
      "The Netlify Function event is required to initialize Blobs."
    );
  }

  const {
    connectLambda,
  } = await import("@netlify/blobs");

  connectLambda(event);
}

async function getAssessmentStore(event) {
  await connectBlobs(event);

  const {
    getStore,
  } = await import("@netlify/blobs");

  return getStore(
    ASSESSMENT_STORE_NAME
  );
}

function getAssessmentKey(assessmentId) {
  return `assessment/${assessmentId}`;
}

async function createAssessment(
  assessment,
  event
) {
  if (!assessment?.assessmentId) {
    throw new Error(
      "An assessmentId is required to create an assessment."
    );
  }

  const store =
    await getAssessmentStore(event);

  const result = await store.setJSON(
    getAssessmentKey(
      assessment.assessmentId
    ),
    assessment,
    {
      onlyIfNew: true,
    }
  );

  if (
    result &&
    result.modified === false
  ) {
    throw new Error(
      "An assessment with this ID already exists."
    );
  }

  return assessment;
}

async function getAssessment(
  assessmentId,
  event
) {
  if (!assessmentId) {
    return null;
  }

  const store =
    await getAssessmentStore(event);

  return store.get(
    getAssessmentKey(assessmentId),
    {
      type: "json",
    }
  );
}

async function saveAssessment(
  assessmentId,
  assessment,
  event
) {
  if (!assessmentId) {
    throw new Error(
      "An assessmentId is required to save an assessment."
    );
  }

  if (
    !assessment ||
    typeof assessment !== "object"
  ) {
    throw new Error(
      "A valid assessment record is required."
    );
  }

  const store =
    await getAssessmentStore(event);

  await store.setJSON(
    getAssessmentKey(assessmentId),
    assessment
  );

  return assessment;
}

async function updateAssessment(
  assessmentId,
  updates,
  event
) {
  const existing =
    await getAssessment(
      assessmentId,
      event
    );

  if (!existing) {
    throw new Error(
      "Assessment record not found."
    );
  }

  const updated = {
    ...existing,
    ...updates,
    updatedAt:
      new Date().toISOString(),
  };

  await saveAssessment(
    assessmentId,
    updated,
    event
  );

  return updated;
}

module.exports = {
  createAssessment,
  getAssessment,
  saveAssessment,
  updateAssessment,
};
