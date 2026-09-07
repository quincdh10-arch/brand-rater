const crypto =
  require("crypto");

const {
  createPurchase,
  savePurchase,
} = require(
  "./purchase-store"
);

/*
  Brand Rater — Stripe Checkout Session
  ------------------------------------------------------------
  Purpose:
  - Create a persistent Brand Action Plan purchase.
  - Save the original business + assessment server-side.
  - Create a Stripe-hosted Checkout Session.
  - Associate Stripe with the server-side purchase_id.

  Environment variables:
  - STRIPE_SECRET_KEY
  - STRIPE_ACTION_PLAN_PRICE_ID
*/

/* =========================================================
   HELPERS
========================================================= */

function getSiteOrigin(event) {
  const origin =
    event.headers.origin ||
    event.headers.Origin;

  if (origin) {
    return origin.replace(
      /\/$/,
      ""
    );
  }

  const host =
    event.headers[
      "x-forwarded-host"
    ] ||
    event.headers.host;

  const proto =
    event.headers[
      "x-forwarded-proto"
    ] ||
    "https";

  if (host) {
    return `${proto}://${host}`;
  }

  return (
    "https://brandrater.netlify.app"
  );
}

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

function cleanString(value) {
  return String(
    value || ""
  ).trim();
}

function normalizeBusiness(
  input
) {
  const business =
    input &&
    typeof input === "object"
      ? input
      : {};

  return {
    name:
      cleanString(
        business.name
      ),

    website:
      cleanString(
        business.website
      ),

    description:
      cleanString(
        business.description
      ),

    audience:
      cleanString(
        business.audience
      ),

    yearsInBusiness:
      cleanString(
        business.yearsInBusiness
      ),

    teamSize:
      cleanString(
        business.teamSize
      ),

    traction:
      cleanString(
        business.traction
      ),

    brandConcern:
      cleanString(
        business.brandConcern
      ),

    twelveMonthGoal:
      cleanString(
        business.twelveMonthGoal
      ),
  };
}

function validateAssessment(
  assessment
) {
  if (
    !assessment ||
    typeof assessment !==
      "object"
  ) {
    return (
      "A completed Brand Rater assessment is required."
    );
  }

  if (
    !assessment.brandHealth ||
    typeof assessment
      .brandHealth
      .score !== "number"
  ) {
    return (
      "The assessment is missing Brand Health data."
    );
  }

  if (
    !Array.isArray(
      assessment.categories
    )
  ) {
    return (
      "The assessment is missing category scores."
    );
  }

  if (
    !assessment.diagnostics
  ) {
    return (
      "The assessment is missing diagnostics."
    );
  }

  return null;
}

/* =========================================================
   HANDLER
========================================================= */

exports.handler =
  async function (event) {

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
      /* -----------------------------------------------
         ENVIRONMENT
      ------------------------------------------------ */

      const stripeSecretKey =
        process.env
          .STRIPE_SECRET_KEY;

      const priceId =
        process.env
          .STRIPE_ACTION_PLAN_PRICE_ID;

      if (
        !stripeSecretKey
      ) {
        return jsonResponse(
          500,
          {
            error:
              "STRIPE_SECRET_KEY is missing from Netlify.",
          }
        );
      }

      if (!priceId) {
        return jsonResponse(
          500,
          {
            error:
              "STRIPE_ACTION_PLAN_PRICE_ID is missing from Netlify.",
          }
        );
      }

      /* -----------------------------------------------
         REQUEST BODY
      ------------------------------------------------ */

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

      const validationError =
        validateAssessment(
          body.assessment
        );

      if (
        validationError
      ) {
        return jsonResponse(
          400,
          {
            error:
              validationError,
          }
        );
      }

      const business =
        normalizeBusiness(
          body.business
        );

      const assessment =
        body.assessment;

      /* -----------------------------------------------
         CREATE PURCHASE ID
      ------------------------------------------------ */

      const purchaseId =
        crypto.randomUUID();

      const now =
        new Date()
          .toISOString();

      /*
        This becomes the source of truth for the purchase.

        After this point, the Action Plan generator will
        eventually load business + assessment from this
        record instead of trusting browser-supplied data.
      */
      const purchase = {
        version:
          "1.0.0",

        purchaseId,

        product:
          "brand-action-plan",

        status:
          "pending",

        createdAt:
          now,

        updatedAt:
          now,

        business,

        assessment,

        stripe: {
          sessionId:
            null,

          paymentStatus:
            null,

          customerEmail:
            null,

          amountTotal:
            null,

          currency:
            null,

          livemode:
            null,

          priceId,
        },

        actionPlan:
          null,

        generation: {
          startedAt:
            null,

          completedAt:
            null,

          error:
            null,
        },
      };

      /* -----------------------------------------------
         SAVE BEFORE STRIPE
      ------------------------------------------------ */

      await createPurchase(
        purchase
      );

      /* -----------------------------------------------
         CREATE STRIPE CHECKOUT
      ------------------------------------------------ */

      const origin =
        getSiteOrigin(
          event
        );

      const params =
        new URLSearchParams();

      params.append(
        "mode",
        "payment"
      );

      params.append(
        "line_items[0][price]",
        priceId
      );

      params.append(
        "line_items[0][quantity]",
        "1"
      );

      params.append(
        "success_url",
        `${origin}/?action_plan=success&session_id={CHECKOUT_SESSION_ID}`
      );

      params.append(
        "cancel_url",
        `${origin}/?action_plan=cancelled`
      );

      params.append(
        "customer_creation",
        "always"
      );

      params.append(
        "billing_address_collection",
        "auto"
      );

      params.append(
        "payment_intent_data[description]",
        "Brand Action Plan"
      );

      /*
        Stripe Checkout Session metadata.

        This is the critical connection between the
        Stripe purchase and the server-side Brand Rater
        purchase record.
      */
      params.append(
        "metadata[purchase_id]",
        purchaseId
      );

      /*
        Also attach the purchase ID to the PaymentIntent.

        This is useful later for webhook-based fulfillment,
        support, reconciliation, and Stripe dashboard
        troubleshooting.
      */
      params.append(
        "payment_intent_data[metadata][purchase_id]",
        purchaseId
      );

      const stripeResponse =
        await fetch(
          "https://api.stripe.com/v1/checkout/sessions",
          {
            method:
              "POST",

            headers: {
              Authorization:
                `Bearer ${stripeSecretKey}`,

              "Content-Type":
                "application/x-www-form-urlencoded",
            },

            body:
              params.toString(),
          }
        );

      const stripeData =
        await stripeResponse
          .json();

      /* -----------------------------------------------
         STRIPE ERROR
      ------------------------------------------------ */

      if (
        !stripeResponse.ok
      ) {
        console.error(
          "Stripe Checkout error:",
          stripeData
        );

        /*
          Preserve the purchase for troubleshooting rather
          than silently losing the failed checkout attempt.
        */
        await savePurchase(
          purchaseId,
          {
            ...purchase,

            status:
              "checkout_failed",

            updatedAt:
              new Date()
                .toISOString(),

            checkoutError:
              stripeData
                .error
                ?.message ||
              "Stripe Checkout creation failed.",
          }
        );

        return jsonResponse(
          stripeResponse.status,
          {
            error:
              stripeData
                .error
                ?.message ||
              "Stripe could not create the Checkout Session.",
          }
        );
      }

      if (
        !stripeData.url ||
        !stripeData.id
      ) {
        await savePurchase(
          purchaseId,
          {
            ...purchase,

            status:
              "checkout_failed",

            updatedAt:
              new Date()
                .toISOString(),

            checkoutError:
              "Stripe created an incomplete Checkout Session.",
          }
        );

        return jsonResponse(
          500,
          {
            error:
              "Stripe created an incomplete Checkout Session.",
          }
        );
      }

      /* -----------------------------------------------
         SAVE STRIPE SESSION
      ------------------------------------------------ */

      const updatedPurchase = {
        ...purchase,

        status:
          "checkout_created",

        updatedAt:
          new Date()
            .toISOString(),

        stripe: {
          ...purchase.stripe,

          sessionId:
            stripeData.id,

          paymentStatus:
            stripeData
              .payment_status ||
            "unpaid",

          amountTotal:
            typeof stripeData
              .amount_total ===
              "number"
              ? stripeData
                  .amount_total
              : null,

          currency:
            stripeData
              .currency ||
            null,

          livemode:
            Boolean(
              stripeData
                .livemode
            ),
        },
      };

      await savePurchase(
        purchaseId,
        updatedPurchase
      );

      /* -----------------------------------------------
         RESPONSE
      ------------------------------------------------ */

      return jsonResponse(
        200,
        {
          success:
            true,

          purchaseId,

          sessionId:
            stripeData.id,

          checkoutUrl:
            stripeData.url,
        }
      );
    }
    catch (error) {
      console.error(
        "Create Checkout Session error:",
        error
      );

      return jsonResponse(
        500,
        {
          error:
            error.message ||
            "Something went wrong creating the checkout.",
        }
      );
    }
  };
