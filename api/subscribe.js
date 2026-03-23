import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing push subscription' });
    }

    // Store subscription keyed by endpoint hash
    const key = 'push:sub:' + Buffer.from(subscription.endpoint).toString('base64').slice(0, 32);
    await redis.set(key, JSON.stringify(subscription), { ex: 30 * 86400 }); // 30 day TTL

    // Also add to the set of all subscriptions
    await redis.sadd('push:subs', key);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Subscribe error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
