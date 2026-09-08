const crypto =
  require("crypto");

const {
  createPurchase,
} = require(
  "./purchase-store"
);

/* =========================================================
   HELPERS
========================================================= */

function getSiteOrigin(
  event
) {
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

function cleanString(
  value
) {
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
         ENVIRONMENT
      ----------------------------------------------------- */

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

      /* -----------------------------------------------------
         REQUEST BODY
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

      /* -----------------------------------------------------
         PRODUCT
      ----------------------------------------------------- */

      if (
        cleanString(
          body.product
        ) !==
        "brand-action-plan"
      ) {
        return jsonResponse(
          400,
          {
            error:
              "Invalid product.",
          }
        );
      }

      /* -----------------------------------------------------
         VALIDATE ASSESSMENT
      ----------------------------------------------------- */

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

      /* -----------------------------------------------------
         NORMALIZE INPUT
      ----------------------------------------------------- */

      const business =
        normalizeBusiness(
          body.business
        );

      const assessment =
        body.assessment;

      /* -----------------------------------------------------
         CREATE PURCHASE ID
      ----------------------------------------------------- */

      const purchaseId =
        crypto.randomUUID();

      const origin =
        getSiteOrigin(
          event
        );

      /* -----------------------------------------------------
         BUILD STRIPE CHECKOUT REQUEST
      ----------------------------------------------------- */

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
        Stripe receives the server-generated purchase ID.
        This links payment back to the exact assessment
        that will be saved immediately after Checkout
        Session creation succeeds.
      */

      params.append(
        "metadata[purchase_id]",
        purchaseId
      );

      params.append(
        "payment_intent_data[metadata][purchase_id]",
        purchaseId
      );

      /* -----------------------------------------------------
         CREATE STRIPE CHECKOUT SESSION FIRST
      ----------------------------------------------------- */

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

      let stripeData;

      try {
        stripeData =
          await stripeResponse
            .json();
      }
      catch {
        return jsonResponse(
          502,
          {
            error:
              "Stripe returned an invalid response.",
          }
        );
      }

      /* -----------------------------------------------------
         STRIPE ERROR
      ----------------------------------------------------- */

      if (
        !stripeResponse.ok
      ) {
        console.error(
          "Stripe Checkout error:",
          stripeData
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

      /* -----------------------------------------------------
         VALIDATE STRIPE RESPONSE
      ----------------------------------------------------- */

      if (
        !stripeData.id ||
        !stripeData.url
      ) {
        return jsonResponse(
          500,
          {
            error:
              "Stripe created an incomplete Checkout Session.",
          }
        );
      }

      /* -----------------------------------------------------
         BUILD COMPLETE PURCHASE RECORD

         This is now the FIRST Blob write.
         There is no pending -> checkout_created overwrite.
      ----------------------------------------------------- */

      const now =
        new Date()
          .toISOString();

      const purchase = {
        version:
          "1.0.0",

        purchaseId,

        product:
          "brand-action-plan",

        status:
          "checkout_created",

        createdAt:
          now,

        updatedAt:
          now,

        business,

        assessment,

        stripe: {
          sessionId:
            stripeData.id,

          paymentStatus:
            stripeData
              .payment_status ||
            "unpaid",

          customerEmail:
            null,

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

      /* -----------------------------------------------------
         SAVE PURCHASE ONCE TO NETLIFY BLOBS
      ----------------------------------------------------- */

      try {
        await createPurchase(
          purchase,
          event
        );
      }
      catch (storageError) {
        console.error(
          "Purchase storage error:",
          storageError
        );

        /*
          Stripe Checkout exists, but we deliberately
          do NOT send the customer into Checkout if the
          server-side purchase cannot be saved.

          That prevents a paid session from becoming
          detached from its Brand Rater assessment.
        */

        return jsonResponse(
          500,
          {
            error:
              "We could not prepare your Brand Action Plan purchase. Please try again.",
          }
        );
      }

      /* -----------------------------------------------------
         SUCCESS
      ----------------------------------------------------- */

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
        error.statusCode ||
        500,
        {
          error:
            error.message ||
            "Something went wrong creating the checkout.",
        }
      );
    }
  };
