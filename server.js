// Second Life Finder: zero-dependency Node server (Node 18+).
const http = require("http");
const fs = require("fs");
const path = require("path");

// Load .env
try {
  for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}

const PORT = process.env.PORT || 3000;

const KEY = process.env.ANTHROPIC_API_KEY;
const GKEY = process.env.GEMINI_API_KEY;

const MODEL = process.env.MODEL || "claude-sonnet-5-5";

const GBASE =
  process.env.GEMINI_BASE ||
  "https://generativelanguage.googleapis.com/v1beta";

// Gemini models are tried in order.
// If one is temporarily unavailable, the next one is tried.
const GMODELS = (
  process.env.GEMINI_MODELS ||
  "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-3.5-flash-lite"
)
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const TYPES = [
  "repair",
  "reuse",
  "repurpose",
  "sell",
  "donate",
  "recycle"
];

const hits = new Map();

const clamp = n =>
  Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

const str = (v, m = 400) =>
  String(v ?? "").slice(0, m);

function limited(ip) {
  const now = Date.now();

  const a = (hits.get(ip) || []).filter(
    t => now - t < 36e5
  );

  a.push(now);
  hits.set(ip, a);

  return a.length > (+process.env.HOURLY_LIMIT || 30);
}


// ---------------------------------------------------------
// PROMPT
// ---------------------------------------------------------

function buildPrompt(b, hasImg) {
  return `
You are a circular-economy expert advising Indian households.

${
  hasImg
    ? `IMPORTANT: Study the attached image carefully and identify the physical object shown in it. The image is the PRIMARY source for identifying the item. Do not say that the item is unknown simply because the user did not type a name.`
    : `No photo is attached.`
}

User details:
- Item name: "${str(b.name, 80) || "not provided"}"
- Reason for discarding: ${str(b.why, 80)}
- DIY skill: ${str(b.skill, 20)}
- Repair budget: INR ${Number(b.budget) || 0}

If an image is provided:
1. Identify what object/product is visible.
2. Determine its likely material and condition.
3. Base the recommendations on the object visible in the image.
4. If the exact brand/model cannot be identified, identify the general object type instead.
5. Do NOT return an error merely because the user did not provide a text description.

Return ONLY valid JSON.
Do NOT use markdown.
Do NOT wrap the JSON in a code block.

Required format:

{
  "item": {
    "name": "",
    "material": "",
    "condition": "",
    "summary": "one sentence"
  },
  "options": [
    {
      "type": "repair|reuse|repurpose|sell|donate|recycle",
      "title": "short action",
      "why": "one sentence",
      "scores": {
        "cost": 0,
        "effort": 0,
        "impact": 0,
        "difficulty": 0,
        "usefulness": 0
      },
      "cost_inr": 0,
      "co2_kg": 0,
      "steps": [
        "3-5 short steps"
      ],
      "where": "specific India-relevant place or resource"
    }
  ]
}

Rules:
- Give 5-6 realistic options.
- Each type can appear at most once.
- Only include options that make sense for the identified object.
- Scores must be between 0 and 100.
- HIGHER score is better.
- cost: cheaper = higher score.
- effort: less effort = higher score.
- difficulty: easier = higher score.
- impact: greater environmental benefit = higher score.
- usefulness: more useful outcome = higher score.
- Respect the user's budget and DIY skill.
- co2_kg should be a cautious estimate of emissions avoided compared with throwing the item away.
- For electronics, batteries, electrical devices, or load-bearing objects, include an appropriate safety step.
- Prefer realistic Indian options such as OLX, Goonj, local repair shops and authorised e-waste collectors.
`;
}


// ---------------------------------------------------------
// CLEAN GEMINI RESULT
// ---------------------------------------------------------

function clean(o) {
  if (!o || !Array.isArray(o.options)) {
    throw new Error("Invalid AI response structure");
  }

  const options = o.options
    .filter(x => x && TYPES.includes(x.type))
    .slice(0, 6)
    .map(x => ({
      type: x.type,

      title: str(x.title, 90),

      why: str(x.why, 240),

      scores: Object.fromEntries(
        [
          "cost",
          "effort",
          "impact",
          "difficulty",
          "usefulness"
        ].map(k => [
          k,
          clamp(x.scores && x.scores[k])
        ])
      ),

      cost_inr: Math.max(
        0,
        Math.round(Number(x.cost_inr) || 0)
      ),

      co2_kg: Math.max(
        0,
        Math.round((Number(x.co2_kg) || 0) * 10) / 10
      ),

      steps: (
        Array.isArray(x.steps)
          ? x.steps
          : []
      )
        .slice(0, 6)
        .map(s => str(s, 200)),

      where: str(x.where, 200)
    }));

  if (!options.length) {
    throw new Error("AI returned no usable options");
  }

  const i = o.item || {};

  return {
    item: {
      name: str(i.name, 80) || "Your item",
      material: str(i.material, 80),
      condition: str(i.condition, 100),
      summary: str(i.summary, 240)
    },
    options
  };
}


// ---------------------------------------------------------
// EXTRACT JSON FROM GEMINI RESPONSE
// ---------------------------------------------------------

function extractJsonText(parts) {

  if (!Array.isArray(parts)) {
    return "";
  }

  // Gemini can return multiple parts.
  // We specifically collect text parts and ignore
  // non-text/thinking parts.
  const texts = parts
    .map(part => {
      if (
        part &&
        typeof part.text === "string"
      ) {
        return part.text.trim();
      }

      return "";
    })
    .filter(Boolean);

  if (!texts.length) {
    return "";
  }

  const combined = texts.join("\n").trim();

  // First try the complete response directly.
  try {
    JSON.parse(combined);
    return combined;
  } catch {}

  // Remove markdown code fences if Gemini adds them.
  const withoutFence = combined
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    JSON.parse(withoutFence);
    return withoutFence;
  } catch {}

  // Find the first JSON object.
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");

  if (start !== -1 && end > start) {
    const candidate =
      withoutFence.slice(start, end + 1);

    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  return "";
}


// ---------------------------------------------------------
// GEMINI
// ---------------------------------------------------------

async function viaGemini(imageData, prompt) {

  const parts = [];

  // IMAGE
  if (imageData) {

    parts.push({
      inline_data: {
        mime_type: imageData[1],
        data: imageData[2]
      }
    });

  }

  // TEXT PROMPT
  parts.push({
    text: prompt
  });


  let lastError = "Unknown Gemini error";


  for (const model of GMODELS) {

    console.log(
      `Trying Gemini model: ${model}`
    );


    for (let attempt = 1; attempt <= 2; attempt++) {

      let response;

      try {

        response = await fetch(
          `${GBASE}/models/${model}:generateContent`,
          {
            method: "POST",

            headers: {
              "content-type": "application/json",
              "x-goog-api-key": GKEY
            },

            body: JSON.stringify({

              contents: [
                {
                  role: "user",
                  parts
                }
              ],

              generationConfig: {
                responseMimeType: "application/json",

                maxOutputTokens: 4000
              }

            })
          }
        );

      } catch (err) {

        lastError =
          `${model}: ${err.message}`;

        console.error(
          "Gemini network error:",
          lastError
        );

        break;
      }


      const raw =
        await response.text();


      // ---------------------------------------------------
      // SUCCESS
      // ---------------------------------------------------

      if (response.ok) {

        let data;

        try {

          data = JSON.parse(raw);

        } catch {

          lastError =
            `${model}: invalid JSON response`;

          console.error(
            lastError
          );

          break;
        }


        const candidate =
          data?.candidates?.[0];


        // Check for blocked prompt/image
        if (
          candidate?.finishReason === "SAFETY"
        ) {

          lastError =
            `${model}: response blocked by safety filters`;

          console.error(lastError);

          break;
        }


        const text =
          extractJsonText(
            candidate?.content?.parts
          );


        if (text) {

          console.log(
            `Gemini succeeded with ${model}`
          );

          return text;
        }


        const reason =
          candidate?.finishReason ||
          data?.promptFeedback?.blockReason ||
          "no usable text returned";


        lastError =
          `${model}: ${reason}`;

        console.error(
          "Gemini returned no usable text:",
          lastError
        );

        break;
      }


      // ---------------------------------------------------
      // ERROR
      // ---------------------------------------------------

      let detail =
        raw.slice(0, 500);

      try {

        const parsed =
          JSON.parse(raw);

        detail =
          parsed?.error?.message ||
          detail;

      } catch {}


      lastError =
        `${model} ${response.status}: ${detail}`;


      console.error(
        "Gemini error:",
        lastError
      );


      // 503 = temporarily unavailable
      // 429 = rate limit
      //
      // Retry once before moving to
      // another model.

      if (
        (response.status === 503 ||
         response.status === 429) &&
        attempt === 1
      ) {

        console.log(
          `${model} temporarily unavailable. Retrying...`
        );

        await new Promise(
          resolve => setTimeout(resolve, 1500)
        );

        continue;
      }


      // Authentication / invalid request:
      // don't keep retrying the same model.

      if (
        response.status === 400 ||
        response.status === 401 ||
        response.status === 403
      ) {

        break;
      }


      break;
    }
  }


  throw new Error(
    "Gemini failed: " + lastError
  );
}


// ---------------------------------------------------------
// PARSE MODEL JSON
// ---------------------------------------------------------

function parseModelJson(text) {

  if (
    typeof text !== "string" ||
    !text.trim()
  ) {

    throw new Error(
      "Empty AI response"
    );
  }


  const cleaned =
    text
      .trim()
      .replace(
        /^```(?:json)?\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();


  // Direct JSON
  try {

    return JSON.parse(cleaned);

  } catch {}


  // JSON embedded in text
  const start =
    cleaned.indexOf("{");

  const end =
    cleaned.lastIndexOf("}");


  if (
    start === -1 ||
    end <= start
  ) {

    throw new Error(
      "AI did not return JSON"
    );
  }


  try {

    return JSON.parse(
      cleaned.slice(
        start,
        end + 1
      )
    );

  } catch {

    throw new Error(
      "AI returned invalid JSON"
    );
  }
}


// ---------------------------------------------------------
// CLAUDE FALLBACK
// ---------------------------------------------------------

async function viaClaude(imageData, prompt) {

  const content = [];


  if (imageData) {

    content.push({
      type: "image",

      source: {
        type: "base64",
        media_type: imageData[1],
        data: imageData[2]
      }
    });

  }


  content.push({
    type: "text",
    text: prompt
  });


  const response =
    await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json",

          "x-api-key": KEY,

          "anthropic-version":
            "2023-06-01"
        },

        body: JSON.stringify({

          model: MODEL,

          max_tokens: 2500,

          messages: [
            {
              role: "user",
              content
            }
          ]

        })
      }
    );


  if (!response.ok) {

    throw new Error(
      "Claude " +
      response.status +
      " " +
      (await response.text()).slice(0, 300)
    );
  }


  const data =
    await response.json();


  return (
    data.content || []
  )
    .map(c => c.text || "")
    .join("");
}


// ---------------------------------------------------------
// ANALYZE
// ---------------------------------------------------------

async function analyze(body) {

  // Accept JPEG, PNG and WEBP.
  //
  // This is important because the uploaded image
  // must actually reach Gemini as base64 image data.

  const imageMatch =
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i
      .exec(body.image || "");


  const imageData =
    imageMatch
      ? [
          imageMatch[0],
          imageMatch[1].toLowerCase() === "image/jpg"
            ? "image/jpeg"
            : imageMatch[1].toLowerCase(),
          imageMatch[2]
        ]
      : null;


  // If an image was supplied but the format
  // could not be understood, give a clear error.

  if (body.image && !imageData) {

    throw new Error(
      "Unsupported image format. Please upload a JPG, PNG or WEBP image."
    );
  }


  const prompt =
    buildPrompt(
      body,
      !!imageData
    );


  let text;


  if (GKEY) {

    text =
      await viaGemini(
        imageData,
        prompt
      );

  } else if (KEY) {

    text =
      await viaClaude(
        imageData,
        prompt
      );

  } else {

    throw new Error(
      "No API key set"
    );
  }


  return clean(
    parseModelJson(text)
  );
}


// ---------------------------------------------------------
// HTTP RESPONSE
// ---------------------------------------------------------

const send =
  (res, code, obj) => {

    res.writeHead(
      code,
      {
        "content-type":
          "application/json"
      }
    );

    res.end(
      JSON.stringify(obj)
    );
  };


// ---------------------------------------------------------
// SERVER
// ---------------------------------------------------------

http
  .createServer((req, res) => {

    // -----------------------------------------------------
    // ANALYZE API
    // -----------------------------------------------------

    if (
      req.method === "POST" &&
      req.url === "/api/analyze"
    ) {

      if (!KEY && !GKEY) {

        return send(
          res,
          503,
          {
            error:
              "No API key set"
          }
        );
      }


      const ip =
        (
          req.headers[
            "x-forwarded-for"
          ] ||
          req.socket.remoteAddress ||
          ""
        )
          .split(",")[0]
          .trim();


      if (limited(ip)) {

        return send(
          res,
          429,
          {
            error:
              "Hourly limit reached"
          }
        );
      }


      let body = "";
      let tooBig = false;


      req.on(
        "data",
        chunk => {

          body += chunk;


          // Prevent excessively large
          // image requests.

          if (body.length > 6e6) {

            tooBig = true;

            req.destroy();
          }
        }
      );


      req.on(
        "end",
        async () => {

          if (tooBig) {
            return;
          }


          try {

            const parsed =
              JSON.parse(body);


            const result =
              await analyze(parsed);


            send(
              res,
              200,
              result
            );

          } catch (error) {

            console.error(
              error.stack ||
              error.message
            );


            send(
              res,
              502,
              {
                error:
                  error.message ||
                  "Analysis failed"
              }
            );
          }

        }
      );


      return;
    }


    // -----------------------------------------------------
    // STATIC FILES
    // -----------------------------------------------------

    if (req.method === "GET") {

      const requested =
        req.url
          .split("?")[0];


      const file =
        requested === "/"
          ? "index.html"
          : requested.slice(1);


      const publicDir =
        path.join(
          __dirname,
          "public"
        );


      const filePath =
        path.join(
          publicDir,
          path.normalize(file)
        );


      if (
        !filePath.startsWith(
          publicDir
        ) ||
        !fs.existsSync(filePath) ||
        fs.statSync(filePath).isDirectory()
      ) {

        res.writeHead(404);

        return res.end(
          "Not found"
        );
      }


      const types = {

        ".html":
          "text/html; charset=utf-8",

        ".js":
          "text/javascript",

        ".css":
          "text/css",

        ".png":
          "image/png",

        ".jpg":
          "image/jpeg",

        ".jpeg":
          "image/jpeg",

        ".webp":
          "image/webp",

        ".svg":
          "image/svg+xml"

      };


      res.writeHead(
        200,
        {
          "content-type":
            types[
              path.extname(filePath)
            ] ||
            "application/octet-stream"
        }
      );


      return fs
        .createReadStream(filePath)
        .pipe(res);
    }


    res.writeHead(405);
    res.end();

  })
  .listen(
    PORT,
    () => {

      console.log(
        `Second Life Finder running on http://localhost:${PORT}` +
        `${
          KEY || GKEY
            ? " [AI: " +
              (GKEY ? "Gemini" : "Claude") +
              "]"
            : " (no API key: add one to .env)"
        }`
      );

    }
  );