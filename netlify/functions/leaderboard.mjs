import { getStore } from '@netlify/blobs';
import { createHash, randomUUID } from 'node:crypto';

const ROLLS = [10, 20, 30];
const MIN_MS_PER_REP = 1500;   // Faster than this is treated as not a real workout.
const MIN_REPS_FOR_TIME = 10;  // Average reps per roll needed to count on the time boards.
const POST_GAP_MS = 30000;     // One log per visitor every 30 seconds.
const KEEP = 2000;             // Boards are worked out from the newest 2,000 workouts.
const TOP = 10;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
const store = () => getStore({ name: 'roll-for-reps', consistency: 'strong' });

function top(rows, value, ascending = false) {
  return rows.filter(r => value(r) !== null)
    .map(r => ({ id: r.id, name: r.name, value: value(r), at: r.at }))
    .sort((a, b) => (ascending ? a.value - b.value : b.value - a.value) || a.at - b.at)
    .slice(0, TOP);
}

export function buildBoards(rows) {
  const timed = rows.filter(r => !r.paused && r.reps / r.rolls >= MIN_REPS_FOR_TIME);
  const counts = new Map();
  for (const r of rows) {
    const k = r.name.toLowerCase(), c = counts.get(k);
    if (c) c.value += 1; else counts.set(k, { id: k, name: r.name, value: 1, at: r.at });
  }
  return {
    workouts: rows.length,
    reps: top(rows, r => r.reps),
    quickest: Object.fromEntries(ROLLS.map(n => [n, top(timed.filter(r => r.rolls === n), r => r.ms, true)])),
    pace: top(timed, r => Math.round(r.ms / r.reps / 100) / 10, true),
    burpees: top(rows.filter(r => r.burpees > 0), r => r.burpees),
    regulars: [...counts.values()].sort((a, b) => b.value - a.value || a.at - b.at).slice(0, TOP)
  };
}

async function boards(s) {
  const { blobs } = await s.list({ prefix: 'w/' });
  const keys = blobs.map(b => b.key).sort().reverse().slice(0, KEEP);
  const rows = [];
  for (let i = 0; i < keys.length; i += 50) {
    const got = await Promise.all(keys.slice(i, i + 50).map(k => s.get(k, { type: 'json' })));
    rows.push(...got.filter(Boolean));
  }
  return buildBoards(rows);
}

export function clean(body) {
  const name = String(body?.name ?? '').replace(/\s+/g, ' ').trim();
  const rolls = Number(body?.rolls), reps = Number(body?.reps), ms = Number(body?.ms), burpees = Number(body?.burpees ?? 0);
  if (name.length < 1 || name.length > 24) return { error: 'Enter a name of 24 characters or fewer.' };
  if (/https?:|www\.|[<>]|\.(com|net|org)\b/i.test(name)) return { error: 'Names can’t include links.' };
  if (!ROLLS.includes(rolls)) return { error: 'Only finished 10, 20 or 30-roll workouts can be logged.' };
  if (![reps, ms, burpees].every(Number.isInteger) || reps < 1 || ms < 1 || burpees < 0 || burpees > reps) return { error: 'This workout’s numbers don’t add up.' };
  if (reps > rolls * 100) return { error: 'The leaderboard counts up to 100 reps per roll.' };
  if (ms < reps * MIN_MS_PER_REP) return { error: 'That’s too fast to count. The limit is 1.5 seconds per rep.' };
  return { value: { name, rolls, reps, ms, burpees, paused: body?.paused === true } };
}

export default async (req, context) => {
  const s = store();
  if (req.method === 'GET') return json(await boards(s));
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'That request couldn’t be read.' }, 400); }
  const { value, error } = clean(body);
  if (error) return json({ error }, 400);

  // Only a one-way hash of the visitor's address is stored, and only to slow down repeat posts.
  const who = 'r/' + createHash('sha256').update('roll-for-reps:' + (context?.ip ?? 'unknown')).digest('hex').slice(0, 32);
  const last = await s.get(who, { type: 'json' });
  const now = Date.now();
  if (last && now - last.at < POST_GAP_MS) return json({ error: 'You just logged a workout. Try again in 30 seconds.' }, 429);
  await s.setJSON(who, { at: now });

  const id = randomUUID();
  const key = 'w/' + String(now).padStart(15, '0') + '-' + id;
  await s.setJSON(key, { id, at: now, ...value });
  return json({ id, boards: await boards(s) }, 201);
};

export const config = { path: '/api/leaderboard' };
