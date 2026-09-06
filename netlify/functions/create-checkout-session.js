/*
  Brand Rater — Stripe Checkout Session
  ------------------------------------------------------------
  Purpose:
  - Create a Stripe-hosted Checkout Session
  - Charge $39 for the Brand Action Plan
  - Return the user to Brand Rater after payment

  Environment variables:
  - STRIPE_SECRET_KEY
  - STRIPE_ACTION_PLAN_PRICE_ID
*/

function getSiteOrigin(event) {
  const origin =
    event.headers.origin ||
    event.headers.Origin;

  if (origin) {
    return origin.replace(/\/$/, "");
  }

  const host =
    event.headers["x-forwarded-host"] ||
    event.headers.host;

  const proto =
    event.headers["x-forwarded-proto"] ||
    "https";

  if (host) {
    return `${proto}://${host}`;
  }

  return "https://brandrater.netlify.app";
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

exports.handler =
  async function (event) {

    if (
      event.httpMethod !== "POST"
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
      const stripeSecretKey =
        process.env.STRIPE_SECRET_KEY;

      const priceId =
        process.env
          .STRIPE_ACTION_PLAN_PRICE_ID;

      if (!stripeSecretKey) {
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

      const origin =
        getSiteOrigin(event);

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

      /*
        Stripe replaces {CHECKOUT_SESSION_ID}
        after successful checkout.
      */
      params.append(
        "success_url",
        `${origin}/?action_plan=success&session_id={CHECKOUT_SESSION_ID}`
      );

      params.append(
        "cancel_url",
        `${origin}/?action_plan=cancelled`
      );

      /*
        Creates a Stripe customer record for
        successful Brand Action Plan buyers.
      */
      params.append(
        "customer_creation",
        "always"
      );

      /*
        Helps Stripe present the correct
        billing / payment experience.
      */
      params.append(
        "billing_address_collection",
        "auto"
      );

      /*
        This appears inside Stripe's payment
        records and makes the purchase easier
        to identify later.
      */
      params.append(
        "payment_intent_data[description]",
        "Brand Action Plan"
      );

      const stripeResponse =
        await fetch(
          "https://api.stripe.com/v1/checkout/sessions",
          {
            method: "POST",

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
        await stripeResponse.json();

      if (!stripeResponse.ok) {
        console.error(
          "Stripe Checkout error:",
          stripeData
        );

        return jsonResponse(
          stripeResponse.status,
          {
            error:
              stripeData.error?.message ||
              "Stripe could not create the Checkout Session.",
          }
        );
      }

      if (
        !stripeData.url ||
        !stripeData.id
      ) {
        return jsonResponse(
          500,
          {
            error:
              "Stripe created an incomplete Checkout Session.",
          }
        );
      }

      return jsonResponse(
        200,
        {
          success: true,

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
