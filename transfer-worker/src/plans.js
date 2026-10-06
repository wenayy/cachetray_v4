export const DAY = 86400000;
export const CLIP_TYPES = ['text', 'link', 'code', 'task'];
export function limits(plan, env = {}) {
  const positive = (value, fallback, max) => Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Math.min(Number(value), max) : fallback;
  return plan === 'pro'
    ? { imagesPerPhone: positive(env.PRO_IMAGES_PER_PHONE, 50, 1000), clipsPerCategory: positive(env.PRO_CLIPS_PER_CATEGORY, 100, 200), phones: 2 }
    : { imagesPerPhone: 5, imagesPerDay: 5, clipsPerCategory: 20, phones: 1 };
}
export function selectClips(items, cap) {
  const counts = Object.fromEntries(CLIP_TYPES.map(type => [type, 0]));
  const seen = new Set();
  return [...items].sort((a, b) => b.time - a.time).filter(item => {
    const key = `${item.type}:${item.id}`;
    if (!CLIP_TYPES.includes(item.type) || seen.has(key) || counts[item.type] >= cap) return false;
    seen.add(key); counts[item.type]++;
    return true;
  });
}
export async function imageUsage(env, senderId, now = Date.now()) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM transfers
    WHERE sender_device_id = ? AND status = 'ready' AND expires_at > ?`)
    .bind(senderId, now).first();
  const daily = await env.DB.prepare(`SELECT COUNT(*) AS total, MIN(sent_at) AS first_sent FROM image_usage
    WHERE sender_id = ? AND status = 'sent' AND sent_at > ?`).bind(senderId, now - DAY).first();
  return { imagesUsed: Number(row?.total || 0), imagesSentLast24h: Number(daily?.total || 0),
    nextImageAllowanceAt: daily?.first_sent ? Number(daily.first_sent) + DAY : null };
}
export async function reserveImage(env, sender, receiverId, transferId, now = Date.now()) {
  const result = await env.DB.prepare(`INSERT INTO image_usage (transfer_id, sender_id, receiver_id, status, reserved_until)
    SELECT ?, ?, ?, 'reserved', ? WHERE
      (? = 'free' OR ((SELECT COUNT(*) FROM transfers WHERE receiver_device_id = ? AND status = 'ready' AND expires_at > ?)
        + (SELECT COUNT(*) FROM image_usage WHERE receiver_id = ? AND status = 'reserved' AND reserved_until > ?)) < ?)
      AND (? = 'pro' OR ((SELECT COUNT(*) FROM image_usage WHERE sender_id = ? AND status = 'sent' AND sent_at > ?)
        + (SELECT COUNT(*) FROM image_usage WHERE sender_id = ? AND status = 'reserved' AND reserved_until > ?)) < 5)`)
    .bind(transferId, sender.id, receiverId, now + 10 * 60000, sender.plan || 'free', receiverId, now, receiverId, now,
      limits(sender.plan, env).imagesPerPhone, sender.plan || 'free', sender.id, now - DAY, sender.id, now).run();
  return result.meta?.changes === 1;
}
