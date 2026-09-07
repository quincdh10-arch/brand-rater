/*
  Brand Rater — Verify Stripe Checkout Session
  ------------------------------------------------------------
  Purpose:
  - Receive a Stripe Checkout Session ID from the frontend
  - Retrieve the session directly from Stripe
  - Confirm payment succeeded
  - Confirm the purchased Price matches the Brand Action Plan
  - Return a verified result to the frontend

  Environment variables:
  - STRIPE_SECRET_KEY
  - STRIPE_ACTION_PLAN_PRICE_ID

  Important:
  This function verifies payment only.
  It does NOT generate the Action Plan yet.
*/

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function getSessionId(body) {
  if (!body || typeof body !== "object") {
    return "";
  }

  const sessionId =
    typeof body.sessionId === "string"
      ? body.sessionId.trim()
      : "";

  return sessionId;
}

async function stripeGet(path, secretKey) {
  const response = await fetch(
    `https://api.stripe.com${path}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const message =
      data?.error?.message ||
      "Stripe request failed.";

    const error = new Error(message);

    error.statusCode =
      response.status;

    error.stripeError =
      data?.error || null;

    throw error;
  }

  return data;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      error: "Method not allowed.",
    });
  }

  try {
    const stripeSecretKey =
      process.env.STRIPE_SECRET_KEY;

    const expectedPriceId =
      process.env.STRIPE_ACTION_PLAN_PRICE_ID;

    if (!stripeSecretKey) {
      return jsonResponse(500, {
        error:
          "STRIPE_SECRET_KEY is missing from Netlify.",
      });
    }

    if (!expectedPriceId) {
      return jsonResponse(500, {
        error:
          "STRIPE_ACTION_PLAN_PRICE_ID is missing from Netlify.",
      });
    }

    let body;

    try {
      body = JSON.parse(
        event.body || "{}"
      );
    } catch {
      return jsonResponse(400, {
        error:
          "Invalid JSON request body.",
      });
    }

    const sessionId =
      getSessionId(body);

    if (!sessionId) {
      return jsonResponse(400, {
        error:
          "A Stripe Checkout Session ID is required.",
      });
    }

    /*
      Checkout Session IDs normally begin with:
      - cs_test_
      - cs_live_

      This is only basic input validation.
      Stripe remains the source of truth.
    */
    if (
      !sessionId.startsWith("cs_test_") &&
      !sessionId.startsWith("cs_live_")
    ) {
      return jsonResponse(400, {
        error:
          "Invalid Stripe Checkout Session ID.",
      });
    }

    /*
      Retrieve the Checkout Session directly
      from Stripe.

      Expanding line_items lets us verify the
      exact Stripe Price that was purchased.
    */
    const encodedSessionId =
      encodeURIComponent(sessionId);

    const session =
      await stripeGet(
        `/v1/checkout/sessions/${encodedSessionId}?expand[]=line_items`,
        stripeSecretKey
      );

    /*
      Verify this was a one-time payment Checkout.
    */
    if (session.mode !== "payment") {
      return jsonResponse(403, {
        verified: false,
        error:
          "This Checkout Session is not a one-time payment.",
      });
    }

    /*
      Stripe's payment_status is the key signal
      for this pass.

      We only unlock the Action Plan when Stripe
      says the payment is paid.
    */
    if (session.payment_status !== "paid") {
      return jsonResponse(402, {
        verified: false,
        paymentStatus:
          session.payment_status || "unknown",
        error:
          "Payment has not been completed.",
      });
    }

    /*
      Verify the actual Price purchased.

      Stripe returns line_items.data, and each
      line item should contain a price object.
    */
    const lineItems =
      Array.isArray(
        session.line_items?.data
      )
        ? session.line_items.data
        : [];

    const purchasedPriceIds =
      lineItems
        .map(
          (item) =>
            item?.price?.id
        )
        .filter(Boolean);

    const purchasedActionPlan =
      purchasedPriceIds.includes(
        expectedPriceId
      );

    if (!purchasedActionPlan) {
      console.error(
        "Checkout verification failed: unexpected price.",
        {
          sessionId,
          expectedPriceId,
          purchasedPriceIds,
        }
      );

      return jsonResponse(403, {
        verified: false,
        error:
          "This payment does not match the Brand Action Plan.",
      });
    }

    /*
      Optional sanity check:
      quantity should be at least 1 for the
      matching Brand Action Plan line item.
    */
    const matchingLineItem =
      lineItems.find(
        (item) =>
          item?.price?.id ===
          expectedPriceId
      );

    if (
      !matchingLineItem ||
      Number(
        matchingLineItem.quantity || 0
      ) < 1
    ) {
      return jsonResponse(403, {
        verified: false,
        error:
          "The Brand Action Plan purchase could not be verified.",
      });
    }

    /*
      Return only the information the frontend
      needs for the next step.

      Do not expose the Stripe secret key or raw
      PaymentIntent details.
    */
    return jsonResponse(200, {
      success: true,
      verified: true,

      session: {
        id: session.id,
        mode: session.mode,
        paymentStatus:
          session.payment_status,

        status:
          session.status || null,

        livemode:
          Boolean(session.livemode),

        amountTotal:
          Number.isFinite(
            session.amount_total
          )
            ? session.amount_total
            : null,

        currency:
          session.currency || null,

        customerEmail:
          session.customer_details
            ?.email ||
          session.customer_email ||
          null,

        priceId:
          expectedPriceId,
      },
    });
  } catch (error) {
    console.error(
      "Verify Checkout Session error:",
      error
    );

    return jsonResponse(
      error.statusCode || 500,
      {
        verified: false,
        error:
          error.message ||
          "Something went wrong verifying the checkout.",
      }
    );
  }
};
