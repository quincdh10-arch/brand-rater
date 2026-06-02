const rateLimitStore = new Map();

function getClientIp(event) {
  return (
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["client-ip"] ||
    event.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const maxRequests = 3;

  const record = rateLimitStore.get(ip) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (record.count >= maxRequests) {
    return false;
  }

  record.count += 1;
  rateLimitStore.set(ip, record);
  return true;
}

function isImageTooLarge(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  const sizeInBytes = (base64.length * 3) / 4;
  const maxSize = 5 * 1024 * 1024;
  return sizeInBytes > maxSize;
}

async function verifyTurnstile(token, ip) {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    return {
      success: false,
      message: "TURNSTILE_SECRET_KEY is missing from Netlify.",
    };
  }

  if (!token) {
    return {
      success: false,
      message: "Turnstile verification is missing.",
    };
  }

  const formData = new URLSearchParams();
  formData.append("secret", process.env.TURNSTILE_SECRET_KEY);
  formData.append("response", token);
  formData.append("remoteip", ip);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: formData,
  });

  const data = await response.json();

  return {
    success: data.success === true,
    message: data["error-codes"]?.join(", ") || "Turnstile verification failed.",
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Brand Rater function is ready. Send a POST request with images.",
      }),
    };
  }

  try {
    const ip = getClientIp(event);

    if (!checkRateLimit(ip)) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          error: "Too many brand rating attempts. Please try again later.",
        }),
      };
    }

    const { images, context, turnstileToken } = JSON.parse(event.body || "{}");

    const turnstile = await verifyTurnstile(turnstileToken, ip);

    if (!turnstile.success) {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: turnstile.message,
        }),
      };
    }

    if (!process.env.OPENAI_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "OPENAI_API_KEY is missing from Netlify.",
        }),
      };
    }

    if (!images || !Array.isArray(images) || images.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No images were provided." }),
      };
    }

    if (images.length > 5) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Please upload no more than 5 images." }),
      };
    }

    const oversizedImage = images.find((img) => isImageTooLarge(img.dataUrl || ""));

    if (oversizedImage) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "One or more images are larger than 5 MB. Please upload smaller files.",
        }),
      };
    }

    const imageInputs = images.map((img) => ({
      type: "input_image",
      image_url: img.dataUrl,
      detail: "low",
    }));

    const prompt = `
Analyze these brand visuals like a brand strategist.

Return ONLY valid JSON. No markdown. No intro text.

Use this exact structure:
{
  "overallScore": 72,
  "verdict": "Strong foundation, but inconsistent",
  "summary": "A short teaser summary.",
  "categories": [
    { "name": "Logo", "score": 78, "note": "Short high-level note." },
    { "name": "Color", "score": 65, "note": "Short high-level note." },
    { "name": "Typography", "score": 58, "note": "Short high-level note." },
    { "name": "Consistency", "score": 52, "note": "Short high-level note." }
  ],
  "visibleIssues": [
    {
      "category": "Typography",
      "severity": "Critical",
      "problem": "Short problem statement.",
      "impact": "Short impact statement."
    },
    {
      "category": "Color",
      "severity": "Warning",
      "problem": "Short problem statement.",
      "impact": "Short impact statement."
    }
  ],
  "lockedIssueCount": 3
}

Important:
- Do not give full fixes.
- Keep the result useful but incomplete.
- Make the user want the full breakdown.
- Be honest, direct, and brand-focused.
${context ? `Brand context: ${context}` : ""}
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              ...imageInputs,
              {
                type: "input_text",
                text: prompt,
              },
            ],
          },
        ],
      }),
    });

    const raw = await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch (error) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "OpenAI returned a non-JSON response.",
          details: raw,
        }),
      };
    }

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: data.error?.message || "OpenAI API error",
        }),
      };
    }

    let outputText = data.output_text;

    if (!outputText && Array.isArray(data.output)) {
      outputText = data.output
        .flatMap((item) => item.content || [])
        .map((content) => content.text || "")
        .join("")
        .trim();
    }

    if (!outputText) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "OpenAI returned no usable text.",
          details: data,
        }),
      };
    }

    const cleaned = outputText.replace(/```json|```/g, "").trim();

    let result;

    try {
      result = JSON.parse(cleaned);
    } catch (error) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "The model response was not valid JSON.",
          details: cleaned,
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || "Something went wrong.",
      }),
    };
  }
};
