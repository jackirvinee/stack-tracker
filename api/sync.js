import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    try {
      const { state } = req.body;
      if (!state) return res.status(400).json({ error: 'Missing state' });

      // Store app state with 48hr TTL (covers extended sessions)
      await redis.set('app:state', JSON.stringify(state), { ex: 48 * 3600 });
      await redis.set('app:lastSync', Date.now());

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Sync error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  if (req.method === 'GET') {
    try {
      const state = await redis.get('app:state');
      return res.status(200).json({ state: state ? JSON.parse(state) : null });
    } catch (e) {
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
