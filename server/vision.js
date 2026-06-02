// FixIt — AI vision analysis for repair photos.
// Uses Google Gemini (GEMINI_API_KEY) or Anthropic Claude (ANTHROPIC_API_KEY),
// whichever is set; falls back to a realistic mock when neither is configured.
const GEMINI_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

export function activeProvider() {
  if (GEMINI_KEY) return 'gemini';
  if (ANTHROPIC_KEY) return 'claude';
  return 'mock';
}

const SCHEMA_HINT = `Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "issue": "short title of the problem",
  "severity": "Low" | "Moderate" | "High" | "Emergency",
  "summary": "2 sentence plain-English diagnosis of what you see",
  "recommendedCategory": "one of: Plumbing, Electrical, HVAC, Roofing, Windows, Flooring, Doors, General",
  "options": [
    { "title": "option name", "description": "what this fix involves", "estimateLow": 80, "estimateHigh": 200, "difficulty": "Easy" | "Moderate" | "Hard" | "Professional Only", "time": "e.g. 1-2 hrs" }
  ],
  "tips": ["short safety/prep tip", "another tip"]
}
Provide 2 or 3 options ordered cheapest/simplest first (e.g. DIY, standard pro repair, full replacement) when sensible.`;

function buildPrompt(category, description) {
  return `You are FixIt, an expert home-repair diagnostician. A homeowner has ${category && category !== 'General' ? `selected the category "${category}" and ` : ''}described the problem as: "${description || '(no description provided)'}".${'\n'}Analyze the attached photo (if any) together with the description. Identify the most likely issue, how serious it is, and realistic repair options with US cost estimates in dollars.${'\n\n'}${SCHEMA_HINT}`;
}

function parseJson(text) {
  if (!text) throw new Error('empty AI response');
  let t = text.trim();
  // strip ```json ... ``` fences if present
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

async function analyzeGemini(prompt, image) {
  const parts = [{ text: prompt }];
  if (image?.data) parts.push({ inline_data: { mime_type: image.mediaType || 'image/jpeg', data: image.data } });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.4, response_mime_type: 'application/json' },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `gemini ${resp.status}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return { ...parseJson(text), provider: 'gemini' };
}

async function analyzeClaude(prompt, image) {
  const content = [];
  if (image?.data) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType || 'image/jpeg', data: image.data } });
  }
  content.push({ type: 'text', text: prompt });
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `claude ${resp.status}`);
  const text = (data.content || []).map((b) => b.text || '').join('');
  return { ...parseJson(text), provider: 'claude' };
}

function mockAnalysis(category, description) {
  const cat = category && category !== 'General' ? category : 'General';
  return {
    issue: `${cat} issue detected`,
    severity: 'Moderate',
    summary: `Based on your description${description ? ` ("${description.slice(0, 60)}")` : ''}, this looks like a standard ${cat.toLowerCase()} repair. Add a real AI key (Gemini or Claude) to analyze the photo itself.`,
    recommendedCategory: cat,
    options: [
      { title: 'DIY quick fix', description: 'Tackle it yourself with basic tools if you are comfortable.', estimateLow: 0, estimateHigh: 60, difficulty: 'Moderate', time: '1-2 hrs' },
      { title: 'Standard pro repair', description: 'A licensed pro diagnoses and fixes the root cause.', estimateLow: 120, estimateHigh: 280, difficulty: 'Professional Only', time: '1-3 hrs' },
      { title: 'Full replacement', description: 'Replace the failing component for a long-term fix.', estimateLow: 300, estimateHigh: 750, difficulty: 'Professional Only', time: 'half day' },
    ],
    tips: ['Turn off water or power to the area before inspecting.', 'Take a few photos from different angles for the contractor.'],
    provider: 'mock',
    simulated: true,
  };
}

// image: { data: base64-no-prefix, mediaType } | null
export async function analyzeIssue({ category, description, image }) {
  const prompt = buildPrompt(category, description);
  const provider = activeProvider();
  try {
    if (provider === 'gemini') return await analyzeGemini(prompt, image);
    if (provider === 'claude') return await analyzeClaude(prompt, image);
  } catch (e) {
    // On any AI error, degrade gracefully to mock so the user flow never breaks.
    const m = mockAnalysis(category, description);
    m.error = String(e.message || e);
    return m;
  }
  return mockAnalysis(category, description);
}
