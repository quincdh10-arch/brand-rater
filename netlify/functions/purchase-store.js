/*
  Brand Rater — Purchase Store
  ------------------------------------------------------------
  Purpose:
  - Persist Brand Action Plan purchases using Netlify Blobs.
  - Keep assessment/business data on the server.
  - Allow Stripe Checkout sessions to reference a purchase_id.
  - Support later payment verification, replay protection,
    and Action Plan persistence.

  Store:
  - brand-rater-purchases
*/

const PURCHASE_STORE_NAME =
  "brand-rater-purchases";

/* =========================================================
   STORE
========================================================= */

async function getPurchaseStore() {
  /*
    Dynamic import keeps this helper compatible with the
    existing CommonJS Netlify Functions used by Brand Rater.
  */
  const {
    getStore,
  } = await import(
    "@netlify/blobs"
  );

  /*
    Strong consistency is useful here because our payment
    flow may write a purchase and immediately read/update it.
  */
  return getStore({
    name:
      PURCHASE_STORE_NAME,

    consistency:
      "strong",
  });
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
  purchase
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
    await getPurchaseStore();

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

  if (!result.modified) {
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
  purchaseId
) {
  if (!purchaseId) {
    return null;
  }

  const store =
    await getPurchaseStore();

  return store.get(
    getPurchaseKey(
      purchaseId
    ),
    {
      type: "json",
      consistency: "strong",
    }
  );
}

/* =========================================================
   UPDATE
========================================================= */

async function savePurchase(
  purchaseId,
  purchase
) {
  if (!purchaseId) {
    throw new Error(
      "A purchaseId is required to save a purchase."
    );
  }

  if (
    !purchase ||
    typeof purchase !== "object"
  ) {
    throw new Error(
      "A valid purchase record is required."
    );
  }

  const store =
    await getPurchaseStore();

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
  updates
) {
  const existing =
    await getPurchase(
      purchaseId
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
    updated
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
