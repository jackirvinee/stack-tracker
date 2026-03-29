import { Redis } from '@upstash/redis';
import webpush from 'web-push';

const redis = Redis.fromEnv();

webpush.setVapidDetails(
  'mailto:stacktracker@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Pharmacokinetics
const DEX_PK = {
  IR: { onsetMin: 30, peakEndMin: 150, totalMin: 300 },
  XR: { onsetMin: 36, peakEndMin: 300, totalMin: 600 }
};

const PHASES = [
  { id: 'wake', name: 'Wake up', hourRange: [5, 11], items: ['wellbutrin', 'tyrosine'] },
  { id: 'breakfast', name: 'Breakfast', hourRange: [6, 12], items: ['b50', 'electrolytes', 'd3', 'krill', 'magtein1'] },
  { id: 'afternoon', name: 'Afternoon', hourRange: [12, 16], items: ['alcar'] },
  { id: 'endstim', name: 'End of stim', hourRange: [14, 22], items: ['nac', 'vitc'], needsDexWornOff: true },
  { id: 'bed', name: 'Before bed', hourRange: [20, 3], items: ['magtein23', 'magbisgly'] }
];

async function sendPush(subscription, title, body) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
    return true;
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      // Subscription expired, clean up
      return false;
    }
    console.error('Push error:', e.statusCode || e.message);
    return false;
  }
}

async function getAllSubscriptions() {
  const keys = await redis.smembers('push:subs');
  const subs = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (raw) {
      subs.push({ key, sub: typeof raw === 'string' ? JSON.parse(raw) : raw });
    } else {
      // Dead key, remove from set
      await redis.srem('push:subs', key);
    }
  }
  return subs;
}

async function getNotifState() {
  const raw = await redis.get('notif:sent') || '{}';
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function markSent(key) {
  const sent = await getNotifState();
  sent[key] = Date.now();
  // Clean old entries (older than 24hr)
  const cutoff = Date.now() - 24 * 3600000;
  for (const k of Object.keys(sent)) {
    if (sent[k] < cutoff) delete sent[k];
  }
  await redis.set('notif:sent', JSON.stringify(sent), { ex: 48 * 3600 });
}

async function wasSent(key, cooldownMs) {
  const sent = await getNotifState();
  if (!sent[key]) return false;
  return (Date.now() - sent[key]) < cooldownMs;
}

export default async function handler(req, res) {
  // Verify cron secret (Vercel sends header, external cron can use ?secret= param)
  const headerAuth = req.headers['authorization'];
  const querySecret = req.query && req.query.secret;
  const valid = headerAuth === `Bearer ${process.env.CRON_SECRET}` ||
                querySecret === process.env.CRON_SECRET;
  if (!valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const subscriptions = await getAllSubscriptions();
    if (subscriptions.length === 0) {
      return res.status(200).json({ sent: 0, reason: 'no subscriptions' });
    }

    // Get app state
    const stateRaw = await redis.get('app:state');
    if (!stateRaw) {
      return res.status(200).json({ sent: 0, reason: 'no state synced' });
    }
    const state = typeof stateRaw === 'string' ? JSON.parse(stateRaw) : stateRaw;

    const now = Date.now();
    const hour = new Date().getHours();
    const notifications = [];

    // --- Water reminders ---
    const dexLog = state._dexLog || [];
    const dexActive = dexLog.some(d => {
      const pk = DEX_PK[d.type] || DEX_PK.XR;
      return (now - d.ts) < pk.totalMin * 60000;
    });
    const waterMl = state._water || 0;
    const waterGoal = state._waterGoal || 3000;
    const waterPct = Math.round((waterMl / waterGoal) * 100);

    if (dexActive && waterPct < 100 && !(await wasSent('water-stim', 90 * 60000))) {
      const mlLeft = waterGoal - waterMl;
      notifications.push({ title: 'Hydrate', body: `Stims active — ${mlLeft}ml left (${waterPct}% done). Drink water now.` });
      await markSent('water-stim');
    } else if (!dexActive && waterPct < 60 && !(await wasSent('water-low', 120 * 60000))) {
      notifications.push({ title: 'Drink water', body: `Only ${waterPct}% of water goal. Stay hydrated.` });
      await markSent('water-low');
    }

    // --- Supplement phase reminders ---
    for (const phase of PHASES) {
      const [startHr, endHr] = phase.hourRange;
      const inWindow = endHr > startHr
        ? (hour >= startHr && hour <= endHr)
        : (hour >= startHr || hour <= endHr); // wraps midnight

      if (!inWindow) continue;

      // Skip bed phase in all-nighter mode
      if (state._allNighter && phase.id === 'bed') continue;

      // If phase needs dex to be worn off, check
      if (phase.needsDexWornOff && dexActive) continue;

      const untaken = phase.items.filter(id => !state[id]);
      if (untaken.length === 0) continue;

      const sentKey = `supp-${phase.id}-${new Date().toDateString()}`;
      if (await wasSent(sentKey, 180 * 60000)) continue; // max every 3hr per phase

      notifications.push({
        title: `${phase.name} supplements`,
        body: `Untaken: ${untaken.length} item${untaken.length > 1 ? 's' : ''}. Open app to check off.`
      });
      await markSent(sentKey);
    }

    // --- Dex wearing off warnings ---
    for (const d of dexLog) {
      const pk = DEX_PK[d.type] || DEX_PK.XR;
      const elapsed = (now - d.ts) / 60000;

      // 30 min before wearing off
      if (elapsed >= pk.totalMin - 30 && elapsed < pk.totalMin) {
        const sentKey = `dex-warn-${d.ts}`;
        if (!(await wasSent(sentKey, pk.totalMin * 60000))) {
          notifications.push({
            title: `${d.type} wearing off in ${Math.round(pk.totalMin - elapsed)} min`,
            body: 'Finish priority tasks. Eat protein. Consider redose if you need more hours.'
          });
          await markSent(sentKey);
        }
      }

      // Just worn off
      if (elapsed >= pk.totalMin && elapsed < pk.totalMin + 20) {
        const sentKey = `dex-off-${d.ts}`;
        if (!(await wasSent(sentKey, pk.totalMin * 60000))) {
          notifications.push({
            title: `${d.type} has worn off`,
            body: 'Take NAC + Vitamin C. Eat a real meal with protein. Hydrate.'
          });
          await markSent(sentKey);
        }
      }
    }

    // --- Caffeine fade ---
    const cafLog = state._cafLog || [];
    for (const c of cafLog) {
      const elapsed = (now - c.ts) / 60000;
      if (elapsed >= 300 && elapsed < 330) {
        const sentKey = `caf-fade-${c.ts}`;
        if (!(await wasSent(sentKey, 360 * 60000))) {
          notifications.push({
            title: 'Caffeine fading',
            body: `${c.mg}mg from ${c.time} is wearing off. Drink water, avoid crash-redose.`
          });
          await markSent(sentKey);
        }
      }
    }

    // --- Crash prevention (extended sessions) ---
    const hoursAwake = state._wakeTime ? (now - state._wakeTime) / 3600000 : 0;

    const crashThreshold = state._allNighter ? 8 : 12;
    if (hoursAwake >= crashThreshold && !(await wasSent('crash-12h', 12 * 3600000))) {
      let totalDex = 0;
      dexLog.forEach(d => totalDex += parseFloat(d.mg) || 0);
      notifications.push({
        title: state._allNighter ? 'All-nighter checkpoint' : 'Big day — prep for crash',
        body: state._allNighter
          ? `${Math.round(hoursAwake)}hr in. Eat protein + complex carbs NOW. Take NAC + mag. Cold water on face for alertness.`
          : `${Math.round(hoursAwake)}hr awake, ${totalDex}mg Dex today. Eat, take mag + NAC, plan wind-down.`
      });
      await markSent('crash-12h');
    }

    if (hoursAwake >= 18 && !(await wasSent('crash-18h', 18 * 3600000))) {
      notifications.push({
        title: '18+ hours awake',
        body: state._allNighter
          ? 'Eat protein, hydrate aggressively, take magnesium. Consider a 20-min power nap if possible.'
          : 'Serious cognitive debt. Sleep if you can. Take magnesium regardless — it protects without sleep.'
      });
      await markSent('crash-18h');
    }

    // --- Sleep planning (suppressed in all-nighter mode) ---
    if (!state._allNighter && hour >= 20 && !state._endDay && !(await wasSent('sleep-ask', 6 * 3600000))) {
      notifications.push({
        title: 'Sleep tonight?',
        body: 'Tap "End Day" to start wind-down. Magnesium + melatonin need 30-60 min lead time.'
      });
      await markSent('sleep-ask');
    }

    // --- Protein ---
    const proteinG = state._protein || 0;
    const proteinGoal = state._proteinGoal || 150;
    if (proteinG < proteinGoal * 0.3 && hoursAwake > 3 && !(await wasSent('protein-low', 3 * 3600000))) {
      notifications.push({
        title: 'Eat protein',
        body: `Only ${proteinG}g so far. Dex depletes amino acids. Eggs, chicken, yogurt, shake.`
      });
      await markSent('protein-low');
    }

    // --- Send all notifications ---
    let sentCount = 0;
    for (const notif of notifications) {
      for (const { key, sub } of subscriptions) {
        const ok = await sendPush(sub, notif.title, notif.body);
        if (!ok) {
          // Remove dead subscription
          await redis.del(key);
          await redis.srem('push:subs', key);
        } else {
          sentCount++;
        }
      }
    }

    return res.status(200).json({ sent: sentCount, notifications: notifications.length });
  } catch (e) {
    console.error('Cron error:', e);
    return res.status(500).json({ error: e.message });
  }
}
