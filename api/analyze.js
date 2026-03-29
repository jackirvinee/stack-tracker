// Analyzes a food or drink description and returns estimated nutrition values
// Uses Claude claude-haiku-4-5-20251001 for fast, cheap inference

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { description, type, photo } = req.body;
  if (!description && !photo) return res.status(400).json({ error: 'Missing description or photo' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key configured' });

  const isFood = type === 'food';
  const prompt = isFood
    ? `You are a nutrition analyst. The user just ate: "${description}"
Estimate the nutritional content for a typical serving of this food.
Respond with ONLY valid JSON, no explanation:
{"protein_g": <number>, "water_ml": <number>, "caffeine_mg": <number>, "summary": "<short 1-line description of what they ate>"}`
    : `You are a nutrition analyst. The user just drank: "${description}"
Estimate the nutritional content for a typical serving of this drink.
Respond with ONLY valid JSON, no explanation:
{"protein_g": <number>, "water_ml": <number>, "caffeine_mg": <number>, "summary": "<short 1-line description of what they drank>"}

Common estimates:
- Water/sparkling water: water_ml = volume described (default 250ml), caffeine=0, protein=0
- Coffee (small/medium/large = 150/250/350ml): caffeine ~80/120/160mg
- Espresso: caffeine ~63mg, water ~30ml
- Red Bull (small 250ml): caffeine 80mg; large 473ml: caffeine 151mg
- Monster (500ml): caffeine 160mg
- Coke/Pepsi (can 355ml): caffeine 34mg, water_ml ~330
- Diet Coke (can): caffeine 46mg
- Tea (cup 240ml): caffeine ~47mg
- Green tea: caffeine ~30mg
- Protein shake: protein ~25g, water ~300ml, caffeine ~0
- Beer/wine/spirits: caffeine 0, water ~200ml, protein ~1g`;

  try {
    // Build messages - include photo if provided
    const messages = [];
    const content = [];

    if (photo) {
      // photo is a base64 data URL like "data:image/jpeg;base64,..."
      const match = photo.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] }
        });
      }
    }

    content.push({ type: 'text', text: prompt + (description ? `\n\nDescription: "${description}"` : '\n\nNo description provided — analyze what you see in the image.') });
    messages.push({ role: 'user', content });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(500).json({ error: 'AI analysis failed' });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Could not parse AI response' });

    const result = JSON.parse(jsonMatch[0]);
    return res.status(200).json({
      protein_g: Math.round(result.protein_g || 0),
      water_ml: Math.round(result.water_ml || 0),
      caffeine_mg: Math.round(result.caffeine_mg || 0),
      summary: result.summary || description
    });
  } catch (e) {
    console.error('Analyze error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
