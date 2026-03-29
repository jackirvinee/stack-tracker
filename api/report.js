// Generates a daily health report from the current day's tracked state
// Uses Claude Haiku for fast, cheap inference

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { state } = req.body;
  if (!state) return res.status(400).json({ error: 'Missing state' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key configured' });

  // Build a readable summary of the day's data
  const now = Date.now();

  // Wake / sleep
  const wakeTime = state._wakeTime ? new Date(state._wakeTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null;
  const hoursAwake = state._wakeTime ? ((now - state._wakeTime) / 3600000).toFixed(1) : null;
  const sleepHrs = state._sleep?.hours || null;
  const bedTime = state._endDay ? new Date(state._endDay).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : null;

  // Dexedrine
  const dexLog = state._dexLog || [];
  const DEX_PK = { XR: { onsetMin: 36, peakEndMin: 300, totalMin: 600 }, IR: { onsetMin: 30, peakEndMin: 150, totalMin: 300 } };
  const dexSummary = dexLog.map(d => {
    const pk = DEX_PK[d.type] || DEX_PK.XR;
    const elapsedMin = (now - d.ts) / 60000;
    let phase = 'worn off';
    if (elapsedMin < pk.onsetMin) phase = 'onset (not yet active)';
    else if (elapsedMin < pk.peakEndMin) phase = 'peak';
    else if (elapsedMin < pk.totalMin) phase = 'fading';
    return `${d.type} ${d.mg}mg at ${d.time} — currently ${phase}`;
  });

  // Supplements
  const PHASE_NAMES = {
    wake: 'Morning Wake', breakfast: 'Breakfast', midmorning: 'Mid-morning',
    afternoon: 'Afternoon', evening: 'Evening', bed: 'Bed', night_hygiene: 'Night Hygiene'
  };
  const taken = [], missed = [];
  if (state._phases) {
    // state has phase data
  }
  // Scan all boolean state keys that look like supplement IDs
  // We'll rely on what was synced — just count taken vs not from known supplement IDs
  // The client sends the full state so we look for known supplement-like keys
  const supplementKeys = Object.keys(state).filter(k => !k.startsWith('_') && state[k] === true);
  const missedKeys = Object.keys(state).filter(k => !k.startsWith('_') && state[k] === false);

  // Intake log
  const intakeLog = state._intakeLog || [];
  const totalProtein = intakeLog.reduce((s, e) => s + (e.protein_g || 0), 0);
  const totalWater = state._t_water || 0;
  const totalCaffeine = intakeLog.reduce((s, e) => s + (e.caffeine_mg || 0), 0);
  const waterGoal = state._waterGoal || 2500;
  const proteinGoal = state._proteinGoal || 150;
  const intakeSummary = intakeLog.map(e =>
    `${e.time} — ${e.type === 'food' ? '🍽' : '☕'} ${e.summary} (protein ${e.protein_g}g, water ${e.water_ml}ml, caf ${e.caffeine_mg}mg)`
  );

  // BFRB
  const bfrbLog = state._bfrbLog || [];
  const bfrbSummary = bfrbLog.length > 0
    ? `${bfrbLog.length} episode(s). Triggers: ${[...new Set(bfrbLog.map(e => e.trigger).filter(Boolean))].join(', ') || 'not logged'}. Avg intensity: ${(bfrbLog.reduce((s, e) => s + e.intensity, 0) / bfrbLog.length).toFixed(1)}/5`
    : 'None';

  // Mood
  const moodLog = state._moodLog || [];
  const moodMap = { 1: 'awful', 2: 'bad', 3: 'ok', 4: 'good', 5: 'great' };
  const energyMap = { 1: 'drained', 2: 'low', 3: 'moderate', 4: 'high', 5: 'peak' };
  const focusMap = { 1: 'scattered', 2: 'distracted', 3: 'ok', 4: 'focused', 5: 'locked in' };
  const moodSummary = moodLog.map(m =>
    `${m.time}: mood ${moodMap[m.mood] || m.mood}, energy ${energyMap[m.energy] || m.energy}, focus ${focusMap[m.focus] || m.focus}${m.note ? ' — "' + m.note + '"' : ''}`
  );

  // Oral hygiene
  const brushCount = [state.morningBrush, state.eveningBrush].filter(Boolean).length;
  const flossCount = [state.morningFloss, state.eveningFloss].filter(Boolean).length;

  // Build the prompt
  const lines = [
    `Today's wellness tracking data:`,
    ``,
    `TIME: ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`,
    wakeTime ? `WAKE TIME: ${wakeTime} (${hoursAwake}h awake)` : 'WAKE TIME: not logged',
    sleepHrs ? `SLEEP LAST NIGHT: ${sleepHrs} hours` : 'SLEEP: not logged',
    bedTime ? `BED TIME: ${bedTime}` : '',
    state._allNighter ? 'MODE: All-nighter active' : '',
    ``,
    `DEXEDRINE:`,
    dexLog.length > 0 ? dexSummary.join('\n') : 'No doses logged',
    ``,
    `SUPPLEMENTS TAKEN: ${supplementKeys.length > 0 ? supplementKeys.join(', ') : 'none'}`,
    ``,
    `FOOD & DRINK (${intakeLog.length} entries):`,
    intakeLog.length > 0 ? intakeSummary.join('\n') : 'Nothing logged',
    `Totals: protein ${totalProtein}g / ${proteinGoal}g goal, water ${totalWater}ml / ${waterGoal}ml goal, caffeine ${totalCaffeine}mg / 400mg limit`,
    ``,
    `BFRB (hair pulling): ${bfrbSummary}`,
    ``,
    `MOOD CHECK-INS: ${moodLog.length > 0 ? moodSummary.join(' | ') : 'none'}`,
    ``,
    `ORAL HYGIENE: brushed ${brushCount}/2, flossed ${flossCount}/2`,
  ].filter(l => l !== undefined).join('\n');

  const prompt = `${lines}

Write a concise, direct daily report for this person. Structure it as:

**Overall**: 1-2 sentences on how the day looks.
**Dex timing**: Assessment of their Dexedrine schedule — onset timing, whether they're in peak or fade, any concerns.
**Nutrition & hydration**: How water/protein/caffeine compares to goals. Any gaps.
**BFRB**: If episodes occurred, note any patterns (triggers, timing relative to stimulant phase).
**Mood trend**: If check-ins available, note energy/focus arc.
**Tomorrow**: 2-3 specific actionable recommendations.

Be direct, personal, and specific to the actual data. Do not add headers or markdown formatting beyond bold labels shown above. Keep under 220 words.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(500).json({ error: 'AI report failed' });
    }

    const data = await response.json();
    const reportText = data.content?.[0]?.text || '';

    return res.status(200).json({
      report: reportText,
      stats: {
        wakeTime, hoursAwake, sleepHrs,
        dexDoses: dexLog.length,
        supplementsTaken: supplementKeys.length,
        intakeEntries: intakeLog.length,
        totalProtein, totalWater, totalCaffeine,
        waterGoal, proteinGoal,
        bfrbEpisodes: bfrbLog.length,
        moodCheckIns: moodLog.length
      }
    });
  } catch (e) {
    console.error('Report error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
