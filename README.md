# Second Life Finder

**AIVORA 2K26 · Track: AI for Sustainability**

Upload a photo of an old, damaged or unwanted item. The AI identifies it, then ranks every second-life route (repair, reuse, repurpose, sell, donate, recycle) on cost, effort, environmental impact, difficulty and usefulness. Users change what matters to them and the ranking re-sorts live.

## Problem
Most households bin things that could be repaired, resold or donated, because they don't know the options or what each one costs. That adds to India's landfill and e-waste load.

## Solution
1. Photo and a few questions (reason, DIY skill, budget, priority).
2. Vision AI identifies the item, material and condition.
3. The AI proposes 5-6 realistic routes with steps and India-specific places (OLX, Goonj, authorised e-waste collectors).
4. A weighted scoring engine in the front end ranks them. The user can change the weights and see the ranking update instantly.
5. The best route appears as a verdict tag with match score, cost and estimated CO2 avoided.

## Architecture
```
Browser (public/index.html)  --JSON-->  server.js (Node, no dependencies)  --->  Gemini API (free tier, vision) or Claude API
   scoring + live re-ranking              key stays server-side, rate limit,
   sticker-style UI                       input limits, output validation
```
- The API key never reaches the browser.
- Model output is validated and clamped on the server (scores 0-100, allowed option types, length limits), so a bad reply can't break the UI.
- Per-IP hourly rate limit (default 30).

## Run locally
Requires Node 18+.
```
cp .env.example .env      # then paste your free Gemini key (aistudio.google.com/apikey) into .env
npm start
# open http://localhost:3000
```

## Deploy (free options: Render, Railway, Fly.io)
- Start command: `npm start`
- Environment variable: `GEMINI_API_KEY` (free) or `ANTHROPIC_API_KEY`
- Optional: `GEMINI_MODELS`, `HOURLY_LIMIT`

## Limits and responsible use
- Scores and CO2 figures are AI estimates, not measurements.
- Safety steps are requested for electronics, batteries and load-bearing items. Users should still check before repairing.
- Photos are sent to the AI provider for analysis and are not stored by this app. On Google's free tier, inputs may be used to improve Google's products, so don't upload personal documents or photos with people in them.

## Future scope
- Real emission-factor table to replace estimated CO2
- Local repair-shop and NGO finder
- Impact tracker across items
- Hindi and Marathi voice input

## Credits
UI, scoring engine, prompt design and server written by the team. Fonts: Dela Gothic One and Figtree (Google Fonts). Vision analysis by Google Gemini (free tier) or Anthropic Claude.
