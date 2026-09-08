/*
  Brand Rater — Verify Stripe Checkout Session
  ------------------------------------------------------------
  Purpose:
  - Verify that a Stripe Checkout Session was actually paid.
  - Confirm the purchase used the expected Brand Action Plan price.
  - Read purchase_id from Stripe metadata.
  - Load the matching server-side purchase from Netlify Blobs.
  - Confirm the Stripe Session belongs to that purchase.
  - Mark the purchase as paid.

  Environment variables:
  - STRIPE_SECRET_KEY
  - STRIPE_ACTION_PLAN_PRICE_ID
*/

const {
  getPurchase,
  savePurchase,
} = require(
  "./purchase-store"
);


/* =========================================================
   RESPONSE HELPER
========================================================= */

function jsonResponse(
  statusCode,
  body
) {
  return {
    statusCode,

    headers: {
      "Content-Type":
        "application/json",

      "Cache-Control":
        "no-store",
    },

    body:
      JSON.stringify(body),
  };
}


/* =========================================================
   CLEAN STRING
========================================================= */

function cleanString(
  value
) {
  return String(
    value || ""
  ).trim();
}


/* =========================================================
   STRIPE GET
========================================================= */

async function stripeGet(
  path
) {
  const stripeSecretKey =
    process.env
      .STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    const error =
      new Error(
        "STRIPE_SECRET_KEY is missing from Netlify."
      );

    error.statusCode = 500;

    throw error;
  }

  const response =
    await fetch(
      `https://api.stripe.com${path}`,
      {
        method:
          "GET",

        headers: {
          Authorization:
            `Bearer ${stripeSecretKey}`,
        },
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    const error =
      new Error(
        data?.error?.message ||
        "Stripe request failed."
      );

    error.statusCode =
      response.status;

    throw error;
  }

  return data;
}


/* =========================================================
   VERIFY STRIPE SESSION
========================================================= */

async function verifyStripeSession(
  sessionId
) {
  const priceId =
    process.env
      .STRIPE_ACTION_PLAN_PRICE_ID;

  if (!priceId) {
    const error =
      new Error(
        "STRIPE_ACTION_PLAN_PRICE_ID is missing from Netlify."
      );

    error.statusCode = 500;

    throw error;
  }

  const cleanedSessionId =
    cleanString(
      sessionId
    );

  if (!cleanedSessionId) {
    const error =
      new Error(
        "A Stripe Checkout Session ID is required."
      );

    error.statusCode = 400;

    throw error;
  }

  if (
    !cleanedSessionId.startsWith(
      "cs_test_"
    ) &&
    !cleanedSessionId.startsWith(
      "cs_live_"
    )
  ) {
    const error =
      new Error(
        "The Stripe Checkout Session ID is invalid."
      );

    error.statusCode = 400;

    throw error;
  }

  const encodedId =
    encodeURIComponent(
      cleanedSessionId
    );

  const session =
    await stripeGet(
      `/v1/checkout/sessions/${encodedId}?expand[]=line_items`
    );

  /* -------------------------------------------------------
     MODE
  ------------------------------------------------------- */

  if (
    session.mode !==
    "payment"
  ) {
    const error =
      new Error(
        "This Checkout Session is not a one-time payment."
      );

    error.statusCode = 400;

    throw error;
  }

  /* -------------------------------------------------------
     PAYMENT STATUS
  ------------------------------------------------------- */

  if (
    session.payment_status !==
    "paid"
  ) {
    const error =
      new Error(
        "Payment has not been completed."
      );

    error.statusCode = 402;

    throw error;
  }

  /* -------------------------------------------------------
     PRICE ID
  ------------------------------------------------------- */

  const lineItems =
    session.line_items?.data ||
    [];

  const matchingItem =
    lineItems.find(
      (item) =>
        item?.price?.id ===
          priceId &&
        Number(
          item?.quantity || 0
        ) >= 1
    );

  if (!matchingItem) {
    const error =
      new Error(
        "This payment does not match the Brand Action Plan."
      );

    error.statusCode = 403;

    throw error;
  }

  /* -------------------------------------------------------
     PURCHASE ID
  ------------------------------------------------------- */

  const purchaseId =
    cleanString(
      session.metadata
        ?.purchase_id
    );

  if (!purchaseId) {
    const error =
      new Error(
        "This Stripe payment is missing its Brand Rater purchase ID."
      );

    error.statusCode = 400;

    throw error;
  }

  return {
    session,
    purchaseId,
    priceId,
  };
}


/* =========================================================
   HANDLER
========================================================= */

exports.handler =
  async function (event) {

    /* -------------------------------------------------------
       METHOD
    ------------------------------------------------------- */

    if (
      event.httpMethod !==
      "POST"
    ) {
      return jsonResponse(
        405,
        {
          error:
            "Method not allowed.",
        }
      );
    }

    try {
      /* -----------------------------------------------------
         BODY
      ----------------------------------------------------- */

      let body;

      try {
        body =
          JSON.parse(
            event.body ||
            "{}"
          );
      }
      catch {
        return jsonResponse(
          400,
          {
            error:
              "The request body was not valid JSON.",
          }
        );
      }

      const sessionId =
        cleanString(
          body.sessionId
        );

      /* -----------------------------------------------------
         VERIFY STRIPE
      ----------------------------------------------------- */

      const {
        session,
        purchaseId,
        priceId,
      } =
        await verifyStripeSession(
          sessionId
        );

      /* -----------------------------------------------------
         LOAD PURCHASE

         IMPORTANT:
         Pass event so purchase-store.js can initialize
         Netlify Blobs with connectLambda(event).
      ----------------------------------------------------- */

      const purchase =
        await getPurchase(
          purchaseId,
          event
        );

      if (!purchase) {
        return jsonResponse(
          404,
          {
            error:
              "The Brand Rater purchase record could not be found.",
          }
        );
      }

      /* -----------------------------------------------------
         VERIFY PRODUCT
      ----------------------------------------------------- */

      if (
        purchase.product !==
        "brand-action-plan"
      ) {
        return jsonResponse(
          403,
          {
            error:
              "This purchase is not for a Brand Action Plan.",
          }
        );
      }

      /* -----------------------------------------------------
         VERIFY SESSION OWNERSHIP
      ----------------------------------------------------- */

      const storedSessionId =
        cleanString(
          purchase.stripe
            ?.sessionId
        );

      if (
        !storedSessionId
      ) {
        return jsonResponse(
          409,
          {
            error:
              "The purchase does not have a Stripe Checkout Session attached.",
          }
        );
      }

      if (
        storedSessionId !==
        session.id
      ) {
        return jsonResponse(
          403,
          {
            error:
              "This Stripe Checkout Session does not belong to this purchase.",
          }
        );
      }

      /* -----------------------------------------------------
         VERIFY STORED PRICE
      ----------------------------------------------------- */

      const storedPriceId =
        cleanString(
          purchase.stripe
            ?.priceId
        );

      if (
        storedPriceId &&
        storedPriceId !==
          priceId
      ) {
        return jsonResponse(
          403,
          {
            error:
              "The purchase Price ID does not match the current Brand Action Plan.",
          }
        );
      }

      /* -----------------------------------------------------
         CUSTOMER EMAIL
      ----------------------------------------------------- */

      const customerEmail =
        cleanString(
          session.customer_details
            ?.email ||
          session.customer_email
        ) || null;

      /* -----------------------------------------------------
         PRESERVE LATER STATES
      ----------------------------------------------------- */

      const protectedStatuses =
        new Set([
          "generating",
          "completed",
        ]);

      const nextStatus =
        protectedStatuses.has(
          purchase.status
        )
          ? purchase.status
          : "paid";

      /* -----------------------------------------------------
         UPDATE PURCHASE
      ----------------------------------------------------- */

      const now =
        new Date()
          .toISOString();

      const updatedPurchase = {
        ...purchase,

        status:
          nextStatus,

        updatedAt:
          now,

        paidAt:
          purchase.paidAt ||
          now,

        stripe: {
          ...purchase.stripe,

          sessionId:
            session.id,

          paymentStatus:
            session
              .payment_status,

          customerEmail,

          amountTotal:
            typeof session
              .amount_total ===
              "number"
              ? session
                  .amount_total
              : purchase.stripe
                  ?.amountTotal ??
                null,

          currency:
            session.currency ||
            purchase.stripe
              ?.currency ||
            null,

          livemode:
            Boolean(
              session.livemode
            ),

          priceId,
        },
      };

      /* -----------------------------------------------------
         SAVE PURCHASE

         IMPORTANT:
         Pass event here too.
      ----------------------------------------------------- */

      await savePurchase(
        purchaseId,
        updatedPurchase,
        event
      );

      /* -----------------------------------------------------
         SUCCESS
      ----------------------------------------------------- */

      return jsonResponse(
        200,
        {
          verified:
            true,

          purchaseId,

          purchaseStatus:
            updatedPurchase
              .status,

          session: {
            id:
              session.id,

            paymentStatus:
              session
                .payment_status,

            status:
              session.status ||
              null,

            livemode:
              Boolean(
                session.livemode
              ),

            customerEmail,

            amountTotal:
              session
                .amount_total ??
              null,

            currency:
              session.currency ||
              null,

            priceId,
          },
        }
      );
    }

    catch (error) {
      console.error(
        "Verify Checkout Session error:",
        error
      );

      return jsonResponse(
        error.statusCode ||
        500,
        {
          error:
            error.message ||
            "Something went wrong verifying the payment.",
        }
      );
    }
  };
