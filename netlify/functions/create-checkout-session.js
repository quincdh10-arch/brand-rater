/*
  Brand Rater — Create Stripe Checkout Session
  ------------------------------------------------------------
  Purpose:
  - Validate the Brand Action Plan checkout request.
  - Save the original assessment and business context on the server.
  - Create a one-time Stripe Checkout Session.
  - Attach purchase_id metadata for secure verification after payment.

  Environment variables:
  - STRIPE_SECRET_KEY
  - STRIPE_ACTION_PLAN_PRICE_ID
  - BRAND_RATER_SITE_URL (recommended)
*/

const {
  randomUUID,
} = require(
  "crypto"
);

const {
  createPurchase,
  savePurchase,
} = require(
  "./purchase-store"
);

const PRODUCT_ID =
  "brand-action-plan";

const DEFAULT_SITE_URL =
  "https://rate.milkymindscreative.com";


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
   HELPERS
========================================================= */

function cleanString(
  value
) {
  return String(
    value || ""
  ).trim();
}

function cleanSiteUrl(
  value
) {
  const fallback =
    DEFAULT_SITE_URL;

  try {
    const url =
      new URL(
        cleanString(value) ||
        fallback
      );

    if (
      url.protocol !== "https:" &&
      url.protocol !== "http:"
    ) {
      return fallback;
    }

    return url.origin;
  }
  catch {
    return fallback;
  }
}

function isPlainObject(
  value
) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}


/* =========================================================
   STRIPE POST
========================================================= */

async function stripePost(
  path,
  parameters
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
          "POST",

        headers: {
          Authorization:
            `Bearer ${stripeSecretKey}`,

          "Content-Type":
            "application/x-www-form-urlencoded",
        },

        body:
          new URLSearchParams(
            parameters
          ),
      }
    );

  let data;

  try {
    data =
      await response.json();
  }
  catch {
    const error =
      new Error(
        `Stripe returned an invalid response (${response.status}).`
      );

    error.statusCode = 502;

    throw error;
  }

  if (!response.ok) {
    const error =
      new Error(
        data?.error?.message ||
        "Stripe could not create the Checkout Session."
      );

    error.statusCode =
      response.status >= 400 &&
      response.status < 500
        ? 400
        : 502;

    throw error;
  }

  return data;
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

      const product =
        cleanString(
          body.product
        );

      if (
        product !==
        PRODUCT_ID
      ) {
        return jsonResponse(
          400,
          {
            error:
              "The requested product is invalid.",
          }
        );
      }

      if (
        !isPlainObject(
          body.business
        ) ||
        !isPlainObject(
          body.assessment
        )
      ) {
        return jsonResponse(
          400,
          {
            error:
              "A valid business and Brand Rater assessment are required."
          }
        );
      }

      const priceId =
        cleanString(
          process.env
            .STRIPE_ACTION_PLAN_PRICE_ID
        );

      if (!priceId) {
        return jsonResponse(
          500,
          {
            error:
              "STRIPE_ACTION_PLAN_PRICE_ID is missing from Netlify."
          }
        );
      }

      const siteUrl =
        cleanSiteUrl(
          process.env
            .BRAND_RATER_SITE_URL
        );

      const purchaseId =
        randomUUID();

      const now =
        new Date()
          .toISOString();

      const purchase = {
        purchaseId,

        product:
          PRODUCT_ID,

        status:
          "checkout_pending",

        createdAt:
          now,

        updatedAt:
          now,

        business:
          body.business,

        assessment:
          body.assessment,

        stripe: {
          sessionId:
            null,

          priceId,

          paymentStatus:
            "unpaid",
        },
      };

      /*
        Save the assessment before redirecting to Stripe.
        The browser will not be trusted as the source of the
        paid Action Plan after checkout.
      */
      await createPurchase(
        purchase,
        event
      );

      const successUrl =
        `${siteUrl}/?action_plan=success&session_id={CHECKOUT_SESSION_ID}`;

      const cancelUrl =
        `${siteUrl}/?action_plan=cancelled`;

      const stripeSession =
        await stripePost(
          "/v1/checkout/sessions",
          {
            mode:
              "payment",

            "line_items[0][price]":
              priceId,

            "line_items[0][quantity]":
              "1",

            success_url:
              successUrl,

            cancel_url:
              cancelUrl,

            client_reference_id:
              purchaseId,

            "metadata[purchase_id]":
              purchaseId,

            "metadata[product]":
              PRODUCT_ID,

            "payment_intent_data[metadata][purchase_id]":
              purchaseId,

            "payment_intent_data[metadata][product]":
              PRODUCT_ID,
          }
        );

      if (
        !stripeSession?.id ||
        !stripeSession?.url
      ) {
        const error =
          new Error(
            "Stripe did not return a valid Checkout Session."
          );

        error.statusCode = 502;

        throw error;
      }

      const updatedPurchase = {
        ...purchase,

        updatedAt:
          new Date()
            .toISOString(),

        stripe: {
          ...purchase.stripe,

          sessionId:
            stripeSession.id,

          paymentStatus:
            stripeSession
              .payment_status ||
            "unpaid",

          livemode:
            Boolean(
              stripeSession
                .livemode
            ),
        },
      };

      await savePurchase(
        purchaseId,
        updatedPurchase,
        event
      );

      return jsonResponse(
        200,
        {
          checkoutUrl:
            stripeSession.url,

          sessionId:
            stripeSession.id,

          purchaseId,
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
            "Something went wrong starting checkout."
        }
      );
    }
  };
