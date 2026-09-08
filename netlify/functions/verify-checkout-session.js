const {
  getPurchase,
  savePurchase,
} = require("./purchase-store");


/* =========================================================
   CONFIG
========================================================= */

const STRIPE_API_BASE =
  "https://api.stripe.com/v1";

const PRODUCT_KEY =
  "brand-action-plan";


/* =========================================================
   RESPONSE HELPERS
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
   STRIPE REQUEST
========================================================= */

async function stripeGet(
  path
) {
  const secretKey =
    process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is not configured."
    );
  }

  const response =
    await fetch(
      `${STRIPE_API_BASE}${path}`,
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${secretKey}`,
        },
      }
    );

  let data;

  try {
    data =
      await response.json();
  }

  catch {
    throw new Error(
      `Stripe returned an invalid response (${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `Stripe request failed (${response.status}).`
    );
  }

  return data;
}


/* =========================================================
   PRICE VALIDATION
========================================================= */

function sessionHasExpectedPrice(
  session,
  expectedPriceId
) {
  const items =
    session?.line_items?.data;

  if (
    !Array.isArray(items) ||
    !items.length
  ) {
    return false;
  }

  return items.some(
    item =>
      item?.price?.id ===
        expectedPriceId &&
      Number(item?.quantity || 0) >= 1
  );
}


/* =========================================================
   HANDLER
========================================================= */

exports.handler =
  async function handler(
    event
  ) {
    /*
      IMPORTANT:

      The Netlify Function event MUST be
      passed into getPurchase() and
      savePurchase().

      purchase-store.js uses that event
      to initialize Netlify Blobs in
      Lambda compatibility mode.
    */

    if (
      event.httpMethod !==
      "POST"
    ) {
      return jsonResponse(
        200,
        {
          success: true,

          function:
            "verify-checkout-session",

          ready:
            true,
        }
      );
    }


    try {

      /* =====================================================
         ENVIRONMENT
      ====================================================== */

      const expectedPriceId =
        process.env
          .STRIPE_ACTION_PLAN_PRICE_ID;

      if (!expectedPriceId) {
        throw new Error(
          "STRIPE_ACTION_PLAN_PRICE_ID is not configured."
        );
      }


      /* =====================================================
         REQUEST BODY
      ====================================================== */

      let body;

      try {
        body =
          JSON.parse(
            event.body || "{}"
          );
      }

      catch {
        return jsonResponse(
          400,
          {
            verified:
              false,

            error:
              "Invalid request body.",
          }
        );
      }


      const sessionId =
        typeof body.sessionId ===
          "string"
          ? body.sessionId.trim()
          : "";


      if (
        !sessionId ||
        !(
          sessionId.startsWith(
            "cs_live_"
          ) ||
          sessionId.startsWith(
            "cs_test_"
          )
        )
      ) {
        return jsonResponse(
          400,
          {
            verified:
              false,

            error:
              "A valid Stripe Checkout Session ID is required.",
          }
        );
      }


      /* =====================================================
         RETRIEVE STRIPE CHECKOUT SESSION
      ====================================================== */

      const encodedSessionId =
        encodeURIComponent(
          sessionId
        );

      const stripeSession =
        await stripeGet(
          `/checkout/sessions/${encodedSessionId}?expand[]=line_items`
        );


      /* =====================================================
         VERIFY STRIPE PAYMENT
      ====================================================== */

      if (
        stripeSession.mode !==
        "payment"
      ) {
        return jsonResponse(
          400,
          {
            verified:
              false,

            error:
              "This Checkout Session is not a one-time payment.",
          }
        );
      }


      if (
        stripeSession.payment_status !==
        "paid"
      ) {
        return jsonResponse(
          402,
          {
            verified:
              false,

            error:
              "Stripe has not marked this Checkout Session as paid.",
          }
        );
      }


      if (
        !sessionHasExpectedPrice(
          stripeSession,
          expectedPriceId
        )
      ) {
        return jsonResponse(
          403,
          {
            verified:
              false,

            error:
              "This payment does not match the Brand Action Plan product.",
          }
        );
      }


      /* =====================================================
         GET PURCHASE ID
      ====================================================== */

      const purchaseId =
        stripeSession
          ?.metadata
          ?.purchase_id;


      if (!purchaseId) {
        return jsonResponse(
          400,
          {
            verified:
              false,

            error:
              "This Checkout Session is missing its purchase record.",
          }
        );
      }


      /* =====================================================
         LOAD SERVER-SIDE PURCHASE

         IMPORTANT:
         Pass event here.
      ====================================================== */

      const purchase =
        await getPurchase(
          purchaseId,
          event
        );


      if (!purchase) {
        return jsonResponse(
          404,
          {
            verified:
              false,

            error:
              "We could not find the Brand Action Plan purchase connected to this payment.",
          }
        );
      }


      /* =====================================================
         VERIFY PURCHASE RECORD
      ====================================================== */

      if (
        purchase.product !==
        PRODUCT_KEY
      ) {
        return jsonResponse(
          403,
          {
            verified:
              false,

            error:
              "The stored purchase does not match the Brand Action Plan.",
          }
        );
      }


      if (
        purchase?.stripe?.sessionId &&
        purchase.stripe.sessionId !==
          stripeSession.id
      ) {
        return jsonResponse(
          403,
          {
            verified:
              false,

            error:
              "The Stripe Checkout Session does not belong to this purchase.",
          }
        );
      }


      if (
        purchase?.stripe?.priceId &&
        purchase.stripe.priceId !==
          expectedPriceId
      ) {
        return jsonResponse(
          403,
          {
            verified:
              false,

            error:
              "The stored purchase price does not match the expected Brand Action Plan price.",
          }
        );
      }


      /* =====================================================
         MARK PURCHASE PAID

         Do not overwrite a report already being
         generated or completed.
      ====================================================== */

      const currentStatus =
        purchase.status || "";

      let updatedPurchase =
        purchase;


      if (
        currentStatus !==
          "generating" &&
        currentStatus !==
          "completed"
      ) {
        const now =
          new Date()
            .toISOString();


        updatedPurchase = {
          ...purchase,

          status:
            "paid",

          updatedAt:
            now,

          stripe: {
            ...(purchase.stripe || {}),

            sessionId:
              stripeSession.id,

            paymentStatus:
              stripeSession
                .payment_status,

            paymentIntentId:
              typeof stripeSession
                .payment_intent ===
                "string"
                ? stripeSession
                    .payment_intent
                : stripeSession
                    ?.payment_intent
                    ?.id ||
                  null,

            customerEmail:
              stripeSession
                ?.customer_details
                ?.email ||
              stripeSession
                ?.customer_email ||
              purchase
                ?.stripe
                ?.customerEmail ||
              null,

            amountTotal:
              stripeSession
                .amount_total,

            currency:
              stripeSession
                .currency,

            livemode:
              Boolean(
                stripeSession
                  .livemode
              ),

            priceId:
              expectedPriceId,
          },
        };


        /*
          IMPORTANT:
          Pass event here too.
        */

        await savePurchase(
          purchaseId,
          updatedPurchase,
          event
        );
      }


      /* =====================================================
         SUCCESS
      ====================================================== */

      return jsonResponse(
        200,
        {
          verified:
            true,

          purchaseId,

          purchaseStatus:
            updatedPurchase.status,

          session: {
            id:
              stripeSession.id,

            paymentStatus:
              stripeSession
                .payment_status,

            amountTotal:
              stripeSession
                .amount_total,

            currency:
              stripeSession
                .currency,

            customerEmail:
              stripeSession
                ?.customer_details
                ?.email ||
              stripeSession
                ?.customer_email ||
              null,

            livemode:
              Boolean(
                stripeSession
                  .livemode
              ),
          },
        }
      );
    }


    catch (error) {
      console.error(
        "Checkout verification error:",
        error
      );


      return jsonResponse(
        500,
        {
          verified:
            false,

          error:
            error.message ||
            "We could not verify the payment.",
        }
      );
    }
  };
