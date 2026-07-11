import { beforeEach } from 'vitest'
import { applyD1Migrations, env } from 'cloudflare:test'

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM photos'),
    env.DB.prepare('DELETE FROM groups'),
    env.DB.prepare('DELETE FROM collections'),
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare('DELETE FROM model_aliases'),
    env.DB.prepare('DELETE FROM model_names'),
    env.DB.prepare('DELETE FROM site_daily_views'),
    env.DB.prepare('DELETE FROM login_attempts'),
    env.DB.prepare('DELETE FROM admin_sessions'),
  ])
  let cursor
  do {
    const listed = await env.PHOTOS.list({ cursor })
    if (listed.objects.length) await env.PHOTOS.delete(listed.objects.map((object) => object.key))
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
})
