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

      // Inject server timestamp for cross-device conflict resolution
      state._lastModified = Date.now();

      // Store app state with 30-day TTL (supports infrequent use)
      await redis.set('app:state', JSON.stringify(state), { ex: 30 * 24 * 3600 });
      await redis.set('app:lastSync', Date.now());

      return res.status(200).json({ ok: true, lastModified: state._lastModified });
    } catch (e) {
      console.error('Sync error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  if (req.method === 'GET') {
    try {
      const raw = await redis.get('app:state');
      const state = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      return res.status(200).json({ state: state });
    } catch (e) {
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
