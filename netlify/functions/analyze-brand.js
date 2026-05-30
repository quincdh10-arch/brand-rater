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
    const { images, context } = JSON.parse(event.body || "{}");

    if (!images || !Array.isArray(images) || images.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No images were provided." }),
      };
    }

    const imageInputs = images.slice(0, 5).map((img) => ({
      type: "input_image",
      image_url: img.dataUrl,
      detail: "low",
    }));

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
                text: `
Analyze these brand visuals like a brand strategist.

Return ONLY valid JSON. No markdown.

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
                `,
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: data.error?.message || "OpenAI API error" }),
      };
    }

    const text = data.output_text || "";
    const cleaned = text.replace(/```json|```/g, "").trim();

    return {
      statusCode: 200,
      body: cleaned,
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
