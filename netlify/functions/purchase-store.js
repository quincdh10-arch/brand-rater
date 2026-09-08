/*
  Brand Rater — Purchase Store
  ------------------------------------------------------------
  Purpose:
  - Persist Brand Action Plan purchases using Netlify Blobs.
  - Keep assessment/business data on the server.
  - Allow Stripe Checkout sessions to reference a purchase_id.
  - Support payment verification, replay protection,
    and Action Plan persistence.

  Store:
  - brand-rater-purchases

  Important:
  - Brand Rater currently uses Netlify's Lambda-compatible
    CommonJS Functions format.
  - connectLambda(event) must run before getStore().
  - This Lambda-compatible environment uses the default
    eventually-consistent Blobs read path.
*/

const PURCHASE_STORE_NAME =
  "brand-rater-purchases";

/* =========================================================
   BLOBS CONNECTION
========================================================= */

async function connectBlobs(
  event
) {
  if (!event) {
    throw new Error(
      "The Netlify Function event is required to initialize Blobs."
    );
  }

  const {
    connectLambda,
  } = await import(
    "@netlify/blobs"
  );

  /*
    Lambda compatibility mode requires the Netlify
    invocation event to initialize Blobs access.
  */
  connectLambda(
    event
  );
}

/* =========================================================
   STORE
========================================================= */

async function getPurchaseStore(
  event
) {
  await connectBlobs(
    event
  );

  const {
    getStore,
  } = await import(
    "@netlify/blobs"
  );

  /*
    Do NOT request strong consistency here.

    Lambda-compatible Blobs access does not provide
    the uncachedEdgeURL required for strong reads.

    Netlify Blobs therefore uses its default
    eventually-consistent read model.
  */
  return getStore(
    PURCHASE_STORE_NAME
  );
}

/* =========================================================
   KEY
========================================================= */

function getPurchaseKey(
  purchaseId
) {
  return `purchase/${purchaseId}`;
}

/* =========================================================
   CREATE
========================================================= */

async function createPurchase(
  purchase,
  event
) {
  if (
    !purchase ||
    !purchase.purchaseId
  ) {
    throw new Error(
      "A purchaseId is required to create a purchase."
    );
  }

  const store =
    await getPurchaseStore(
      event
    );

  const key =
    getPurchaseKey(
      purchase.purchaseId
    );

  const result =
    await store.setJSON(
      key,
      purchase,
      {
        onlyIfNew: true,
      }
    );

  if (
    result &&
    result.modified === false
  ) {
    throw new Error(
      "A purchase with this ID already exists."
    );
  }

  return purchase;
}

/* =========================================================
   READ
========================================================= */

async function getPurchase(
  purchaseId,
  event
) {
  if (!purchaseId) {
    return null;
  }

  const store =
    await getPurchaseStore(
      event
    );

  /*
    No strong consistency option here.
  */
  return store.get(
    getPurchaseKey(
      purchaseId
    ),
    {
      type:
        "json",
    }
  );
}

/* =========================================================
   SAVE
========================================================= */

async function savePurchase(
  purchaseId,
  purchase,
  event
) {
  if (!purchaseId) {
    throw new Error(
      "A purchaseId is required to save a purchase."
    );
  }

  if (
    !purchase ||
    typeof purchase !==
      "object"
  ) {
    throw new Error(
      "A valid purchase record is required."
    );
  }

  const store =
    await getPurchaseStore(
      event
    );

  await store.setJSON(
    getPurchaseKey(
      purchaseId
    ),
    purchase
  );

  return purchase;
}

/* =========================================================
   PATCH
========================================================= */

async function updatePurchase(
  purchaseId,
  updates,
  event
) {
  const existing =
    await getPurchase(
      purchaseId,
      event
    );

  if (!existing) {
    throw new Error(
      "Purchase record not found."
    );
  }

  const updated = {
    ...existing,
    ...updates,

    updatedAt:
      new Date()
        .toISOString(),
  };

  await savePurchase(
    purchaseId,
    updated,
    event
  );

  return updated;
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  createPurchase,
  getPurchase,
  savePurchase,
  updatePurchase,
};
