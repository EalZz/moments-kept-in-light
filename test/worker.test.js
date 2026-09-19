import { describe, expect, it } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { persistUpload, runScheduledCleanup, trashRetentionDays, normalizeSeries, splitCharacterLine, seriesOf } from '../src/worker.js'

async function login(password = 'test-password') {
  const response = await SELF.fetch('https://example.com/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

async function seedCollection({ title, published = 1, deletedAt = null, shootType = 'event', locationType = '', relatedEventId = null } = {}) {
  const result = await env.DB.prepare(
    `INSERT INTO collections
       (title, description, published, deleted_at, shoot_type, location_type, related_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(title || 'Collection', 'Description', published, deletedAt, shootType, locationType, relatedEventId).run()
  return result.meta.last_row_id
}

describe('admin authentication', () => {
  it('rejects a bad password and issues a hardened cookie for a valid login', async () => {
    const bad = await login('wrong')
    expect(bad.response.status).toBe(401)
    expect(bad.cookie).toBeUndefined()

    const good = await login()
    expect(good.response.status).toBe(200)
    const setCookie = good.response.headers.get('set-cookie')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')

    const me = await SELF.fetch('https://example.com/api/me', { headers: { Cookie: good.cookie } })
    expect(await me.json()).toEqual({ admin: true })
  })

  it('temporarily blocks repeated failed logins', async () => {
    for (let i = 0; i < 5; i++) expect((await login('wrong')).response.status).toBe(401)
    expect((await login('wrong')).response.status).toBe(429)
  })

  it('rejects tampered sessions and cross-origin mutations', async () => {
    const { cookie } = await login()
    const tampered = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a')
    expect(await (await SELF.fetch('https://example.com/api/me', { headers: { Cookie: tampered } })).json())
      .toEqual({ admin: false })
    const forbidden = await SELF.fetch('https://example.com/api/settings', {
      method: 'PATCH',
      headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ featured_collection_id: null }),
    })
    expect(forbidden.status).toBe(403)
  })

  it('revokes the server-side session on logout', async () => {
    const { cookie } = await login()
    expect((await SELF.fetch('https://example.com/api/me', { headers: { Cookie: cookie } })).status).toBe(200)
    await SELF.fetch('https://example.com/api/logout', { method: 'POST', headers: { Cookie: cookie } })
    expect(await (await SELF.fetch('https://example.com/api/me', { headers: { Cookie: cookie } })).json())
      .toEqual({ admin: false })
  })
})

describe('visibility and sharing', () => {
  it('shows only published active collections publicly and drafts to admins', async () => {
    await seedCollection({ title: 'Published', published: 1 })
    await seedCollection({ title: 'Draft', published: 0 })
    await seedCollection({ title: 'Deleted', published: 1, deletedAt: new Date().toISOString() })

    const publicResponse = await SELF.fetch('https://example.com/api/collections')
    expect((await publicResponse.json()).map((row) => row.title)).toEqual(['Published'])

    const { cookie } = await login()
    const adminResponse = await SELF.fetch('https://example.com/api/collections', { headers: { Cookie: cookie } })
    expect((await adminResponse.json()).map((row) => row.title).sort()).toEqual(['Draft', 'Published'])
  })

  it('renders collection-specific share metadata only for published collections', async () => {
    const publishedId = await seedCollection({ title: 'A & <B>', published: 1 })
    const draftId = await seedCollection({ title: 'Draft', published: 0 })

    const shared = await SELF.fetch(`https://example.com/share/collection/${publishedId}`)
    expect(shared.status).toBe(200)
    const html = await shared.text()
    expect(html).toContain('A &amp; &lt;B&gt;')
    expect(html).toContain(`https://example.com/#/c/${publishedId}`)

    const draft = await SELF.fetch(`https://example.com/share/collection/${draftId}`)
    expect(draft.status).toBe(404)
  })

  it('excludes draft content from photo, feature, and model APIs', async () => {
    const publishedId = await seedCollection({ title: 'Published', published: 1 })
    const draftId = await seedCollection({ title: 'Draft', published: 0 })
    for (const [collectionId, key] of [[publishedId, 'published'], [draftId, 'draft']]) {
      const group = await env.DB.prepare(
        `INSERT INTO groups (collection_id, name, meta_json) VALUES (?, ?, '{"twitter":["model"]}')`
      ).bind(collectionId, key).run()
      await env.DB.prepare(
        'INSERT INTO photos (collection_id, group_id, key_large, key_thumb) VALUES (?, ?, ?, ?)'
      ).bind(collectionId, group.meta.last_row_id, `${key}-large`, `${key}-thumb`).run()
    }

    const photos = await (await SELF.fetch('https://example.com/api/photos')).json()
    expect(photos.total).toBe(1)
    expect(photos.photos[0].title).toBe('Published')
    const features = await (await SELF.fetch('https://example.com/api/feature-photos')).json()
    expect(features.map((photo) => photo.title)).toEqual(['Published'])
    const models = await (await SELF.fetch('https://example.com/api/models')).json()
    expect(models[0].photo_count).toBe(1)
  })

  it('blocks direct image access for draft or deleted content but allows admins', async () => {
    const publishedId = await seedCollection({ title: 'Published', published: 1 })
    const draftId = await seedCollection({ title: 'Draft', published: 0 })
    const deletedId = await seedCollection({ title: 'Deleted photo', published: 1 })
    for (const [collectionId, key, deletedAt] of [[publishedId, 'public', null], [draftId, 'draft', null], [deletedId, 'deleted', new Date().toISOString()]]) {
      await env.DB.prepare(
        'INSERT INTO photos (collection_id, key_large, key_thumb, deleted_at) VALUES (?, ?, ?, ?)'
      ).bind(collectionId, `${key}-large`, `${key}-thumb`, deletedAt).run()
      await env.PHOTOS.put(`${key}-large`, new Uint8Array([1]), { httpMetadata: { contentType: 'image/webp' } })
    }
    expect((await SELF.fetch('https://example.com/img/public-large')).status).toBe(200)
    expect((await SELF.fetch('https://example.com/img/draft-large')).status).toBe(404)
    expect((await SELF.fetch('https://example.com/img/deleted-large')).status).toBe(404)
    const { cookie } = await login()
    expect((await SELF.fetch('https://example.com/img/draft-large', { headers: { Cookie: cookie } })).status).toBe(200)
    expect((await SELF.fetch('https://example.com/img/deleted-large', { headers: { Cookie: cookie } })).status).toBe(200)
  })

  it('includes model display names in feature, photo, and collection responses', async () => {
    const collectionId = await seedCollection({ title: 'Credits', published: 1 })
    const group = await env.DB.prepare(
      `INSERT INTO groups (collection_id, name, meta_json) VALUES (?, 'Folder Name', '{"twitter":["model_id"]}')`
    ).bind(collectionId).run()
    await env.DB.prepare("INSERT INTO model_names (handle, name) VALUES ('model_id', 'Model Name')").run()
    await env.DB.prepare(
      `INSERT INTO photos (collection_id, group_id, key_large, key_thumb) VALUES (?, ?, 'credit-large', 'credit-thumb')`
    ).bind(collectionId, group.meta.last_row_id).run()

    const features = await (await SELF.fetch('https://example.com/api/feature-photos')).json()
    expect(features[0].models).toEqual(['model_id'])
    expect(features[0].model_names).toEqual(['Model Name'])
    const photos = await (await SELF.fetch('https://example.com/api/photos')).json()
    expect(photos.photos[0].model_names).toEqual(['Model Name'])
    const collection = await (await SELF.fetch(`https://example.com/api/collections/${collectionId}`)).json()
    expect(collection.groups[0].model_names).toEqual(['Model Name'])
  })
})

describe('collection editing', () => {
  it('updates title, date, and description for an active collection', async () => {
    const id = await seedCollection({ title: 'Before', published: 0 })
    const { cookie } = await login()
    const response = await SELF.fetch(`https://example.com/api/collections/${id}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'After', date: '2026-07', description: 'Updated' }),
    })
    expect(response.status).toBe(200)
    const row = await env.DB.prepare('SELECT title, date, description FROM collections WHERE id = ?').bind(id).first()
    expect(row).toEqual({ title: 'After', date: '2026-07', description: 'Updated' })
  })
})

describe('collection types and home settings', () => {
  it('creates a personal session and exposes its related event', async () => {
    const eventId = await seedCollection({ title: 'Related event' })
    const { cookie } = await login()
    const created = await SELF.fetch('https://example.com/api/collections', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Personal session',
        shoot_type: 'session',
        location_type: 'outdoor',
        related_event_id: eventId,
        session_model: {
          name: '메쨩님',
          twitter: '@reze_model',
          character: '체인소 맨 - 레제',
          series: '체인소 맨',
        },
      }),
    })
    expect(created.status).toBe(200)
    const id = (await created.json()).id
    const detail = await (await SELF.fetch(`https://example.com/api/collections/${id}`, { headers: { Cookie: cookie } })).json()
    expect(detail.shoot_type).toBe('session')
    expect(detail.location_type).toBe('outdoor')
    expect(detail.related_event_id).toBe(eventId)
    expect(detail.related_event_title).toBe('Related event')
    expect(detail.groups).toEqual([])
    expect(detail.session_model).toEqual({
      name: '메쨩님',
      twitter: ['reze_model'],
      character: '체인소 맨 - 레제',
      series: ['체인소 맨'],
    })

    const list = await (await SELF.fetch('https://example.com/api/collections', { headers: { Cookie: cookie } })).json()
    expect(list.find((collection) => collection.id === id).session_model).toEqual(detail.session_model)

    const updated = await SELF.fetch(`https://example.com/api/collections/${id}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_model: { name: '하정님', twitter: 'hajung_model' } }),
    })
    expect(updated.status).toBe(200)
    const updatedDetail = await (await SELF.fetch(`https://example.com/api/collections/${id}`, { headers: { Cookie: cookie } })).json()
    expect(updatedDetail.session_model).toEqual({
      name: '하정님',
      twitter: ['hajung_model'],
      character: '',
      series: [],
    })
  })

  it('rejects invalid collection type metadata and defaults old rows to events', async () => {
    const id = await seedCollection({ title: 'Legacy row' })
    const row = await env.DB.prepare('SELECT shoot_type, location_type FROM collections WHERE id = ?').bind(id).first()
    expect(row).toEqual({ shoot_type: 'event', location_type: '' })
    const { cookie } = await login()
    const response = await SELF.fetch(`https://example.com/api/collections/${id}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shoot_type: 'portrait' }),
    })
    expect(response.status).toBe(400)
  })

  it('stores and validates the home section order', async () => {
    expect(await (await SELF.fetch('https://example.com/api/settings')).json()).toMatchObject({
      home_section_order: 'events_first',
    })
    expect((await SELF.fetch('https://example.com/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ home_section_order: 'sessions_first' }),
    })).status).toBe(401)
    const { cookie } = await login()
    expect((await SELF.fetch('https://example.com/api/settings', {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ home_section_order: 'invalid' }),
    })).status).toBe(400)
    expect((await SELF.fetch('https://example.com/api/settings', {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ home_section_order: 'sessions_first' }),
    })).status).toBe(200)
    expect(await (await SELF.fetch('https://example.com/api/settings')).json()).toMatchObject({
      home_section_order: 'sessions_first',
    })
  })
})

describe('group creation', () => {
  it('puts a newly created person folder before the existing folder order', async () => {
    const collectionId = await seedCollection({ title: 'Group order' })
    await env.DB.prepare('INSERT INTO groups (collection_id, name, sort_order) VALUES (?, ?, ?)')
      .bind(collectionId, 'Existing first', 10).run()
    await env.DB.prepare('INSERT INTO groups (collection_id, name, sort_order) VALUES (?, ?, ?)')
      .bind(collectionId, 'Existing second', 11).run()
    const { cookie } = await login()

    const created = await SELF.fetch(`https://example.com/api/collections/${collectionId}/groups`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New person' }),
    })
    expect(created.status).toBe(200)

    const collection = await (await SELF.fetch(`https://example.com/api/collections/${collectionId}`, {
      headers: { cookie },
    })).json()
    expect(collection.groups.map((group) => group.name)).toEqual([
      'New person', 'Existing first', 'Existing second',
    ])
  })
})

describe('trash and backup', () => {
  it('soft-deletes and restores a collection without removing its R2 objects', async () => {
    const id = await seedCollection({ title: 'Recoverable' })
    await env.DB.prepare(
      `INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, 'p/large.webp', 'p/thumb.webp')`
    ).bind(id).run()
    await env.PHOTOS.put('p/large.webp', new Uint8Array([1]))
    await env.PHOTOS.put('p/thumb.webp', new Uint8Array([2]))
    const { cookie } = await login()

    const removed = await SELF.fetch(`https://example.com/api/collections/${id}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    })
    expect(removed.status).toBe(200)
    expect(await env.PHOTOS.head('p/large.webp')).not.toBeNull()

    const hidden = await SELF.fetch(`https://example.com/api/collections/${id}`)
    expect(hidden.status).toBe(404)

    const restored = await SELF.fetch(`https://example.com/api/trash/collections/${id}/restore`, {
      method: 'POST', headers: { Cookie: cookie },
    })
    expect(restored.status).toBe(200)
    expect((await SELF.fetch(`https://example.com/api/collections/${id}`)).status).toBe(200)
  })

  it('exports deterministic metadata without secrets', async () => {
    await seedCollection({ title: 'Backup target' })
    const { cookie } = await login()
    const response = await SELF.fetch('https://example.com/api/backup', { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('attachment')
    const backup = await response.json()
    expect(backup.schema_version).toBe(1)
    expect(backup.data.collections[0].title).toBe('Backup target')
    expect(JSON.stringify(backup)).not.toContain('test-password')
  })

  it('restores or permanently deletes an individual photo', async () => {
    const id = await seedCollection({ title: 'Photo trash' })
    const inserted = await env.DB.prepare(
      `INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, 'photo-large', 'photo-thumb')`
    ).bind(id).run()
    const photoId = inserted.meta.last_row_id
    await env.PHOTOS.put('photo-large', new Uint8Array([1]))
    await env.PHOTOS.put('photo-thumb', new Uint8Array([2]))
    const { cookie } = await login()

    await SELF.fetch(`https://example.com/api/photos/${photoId}`, { method: 'DELETE', headers: { Cookie: cookie } })
    expect(await env.PHOTOS.head('photo-large')).not.toBeNull()
    expect((await (await SELF.fetch('https://example.com/api/trash', { headers: { Cookie: cookie } })).json()).photos).toHaveLength(1)

    await SELF.fetch(`https://example.com/api/trash/photos/${photoId}/restore`, { method: 'POST', headers: { Cookie: cookie } })
    expect((await env.DB.prepare('SELECT deleted_at FROM photos WHERE id = ?').bind(photoId).first()).deleted_at).toBeNull()

    await SELF.fetch(`https://example.com/api/photos/${photoId}`, { method: 'DELETE', headers: { Cookie: cookie } })
    await SELF.fetch(`https://example.com/api/trash/photos/${photoId}`, { method: 'DELETE', headers: { Cookie: cookie } })
    expect(await env.PHOTOS.head('photo-large')).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM photos WHERE id = ?').bind(photoId).first()).toBeNull()
  })

  it('permanently deletes a trashed collection and its R2 objects', async () => {
    const id = await seedCollection({ title: 'Purge collection' })
    await env.DB.prepare(
      `INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, 'collection-large', 'collection-thumb')`
    ).bind(id).run()
    await env.PHOTOS.put('collection-large', new Uint8Array([1]))
    await env.PHOTOS.put('collection-thumb', new Uint8Array([2]))
    const { cookie } = await login()
    await SELF.fetch(`https://example.com/api/collections/${id}`, { method: 'DELETE', headers: { Cookie: cookie } })
    const purged = await SELF.fetch(`https://example.com/api/trash/collections/${id}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    })
    expect(purged.status).toBe(200)
    expect(await env.PHOTOS.head('collection-large')).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM collections WHERE id = ?').bind(id).first()).toBeNull()
  })

  it('requires restoring a deleted parent collection before a photo', async () => {
    const id = await seedCollection({ title: 'Deleted parent' })
    const inserted = await env.DB.prepare(
      `INSERT INTO photos (collection_id, key_large, key_thumb, deleted_at) VALUES (?, 'a', 'b', datetime('now'))`
    ).bind(id).run()
    await env.DB.prepare("UPDATE collections SET deleted_at = datetime('now') WHERE id = ?").bind(id).run()
    const { cookie } = await login()
    const response = await SELF.fetch(`https://example.com/api/trash/photos/${inserted.meta.last_row_id}/restore`, {
      method: 'POST', headers: { Cookie: cookie },
    })
    expect(response.status).toBe(409)
  })

  it('snapshots and restores R2 photo originals', async () => {
    const id = await seedCollection({ title: 'Snapshot' })
    await env.DB.prepare(
      `INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, 'snap-large', 'snap-thumb')`
    ).bind(id).run()
    await env.PHOTOS.put('snap-large', new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/webp' } })
    await env.PHOTOS.put('snap-thumb', new Uint8Array([4, 5]), { httpMetadata: { contentType: 'image/webp' } })
    const { cookie } = await login()
    const created = await SELF.fetch('https://example.com/api/backups', { method: 'POST', headers: { Cookie: cookie } })
    expect(created.status).toBe(200)
    let backup = await created.json()
    expect(backup.object_count).toBe(2)
    expect(backup.done).toBe(false)
    while (!backup.done) {
      backup = await (await SELF.fetch(`https://example.com/api/backups/${backup.id}/run`, {
        method: 'POST', headers: { Cookie: cookie },
      })).json()
    }
    await env.PHOTOS.delete(['snap-large', 'snap-thumb'])
    const restored = await SELF.fetch(`https://example.com/api/backups/${backup.id}/restore`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ offset: 0 }),
    })
    expect(restored.status).toBe(200)
    expect((await restored.json()).restored).toBe(2)
    expect(await env.PHOTOS.head('snap-large')).not.toBeNull()
    expect(await env.PHOTOS.head('snap-thumb')).not.toBeNull()
  })

  it('deletes an individual snapshot and removes backup copies during a complete purge', async () => {
    const id = await seedCollection({ title: 'Complete purge' })
    const inserted = await env.DB.prepare(
      `INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, 'erase-large', 'erase-thumb')`
    ).bind(id).run()
    await env.PHOTOS.put('erase-large', new Uint8Array([1]))
    await env.PHOTOS.put('erase-thumb', new Uint8Array([2]))
    const { cookie } = await login()
    let backup = await (await SELF.fetch('https://example.com/api/backups', { method: 'POST', headers: { Cookie: cookie } })).json()
    while (!backup.done) {
      backup = await (await SELF.fetch(`https://example.com/api/backups/${backup.id}/run`, {
        method: 'POST', headers: { Cookie: cookie },
      })).json()
    }
    expect(await env.BACKUPS.head(`_backups/${backup.id}/objects/erase-large`)).not.toBeNull()
    expect(await env.PHOTOS.head(`_backups/${backup.id}/objects/erase-large`)).toBeNull()
    await SELF.fetch(`https://example.com/api/photos/${inserted.meta.last_row_id}`, { method: 'DELETE', headers: { Cookie: cookie } })
    const purged = await SELF.fetch(`https://example.com/api/trash/photos/${inserted.meta.last_row_id}?purge_backups=1`, {
      method: 'DELETE', headers: { Cookie: cookie },
    })
    expect(purged.status).toBe(200)
    expect(await env.BACKUPS.head(`_backups/${backup.id}/objects/erase-large`)).toBeNull()
    const manifest = JSON.parse(await (await env.BACKUPS.get(`_backups/${backup.id}/manifest.json`)).text())
    expect(manifest.objects).toHaveLength(0)
    const deleted = await SELF.fetch(`https://example.com/api/backups/${backup.id}`, { method: 'DELETE', headers: { Cookie: cookie } })
    expect(deleted.status).toBe(200)
    expect(await env.BACKUPS.head(`_backups/${backup.id}/manifest.json`)).toBeNull()
  })
})

describe('uploads', () => {
  it('stores both image variants and creates a photo row', async () => {
    const collectionId = await seedCollection({ title: 'Upload', published: 0 })
    const { cookie } = await login()
    const form = new FormData()
    const webp = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])
    form.append('large', new File([webp], 'large.webp', { type: 'image/webp' }))
    form.append('thumb', new File([webp], 'thumb.webp', { type: 'image/webp' }))
    form.append('width', '100')
    form.append('height', '80')
    const response = await SELF.fetch(`https://example.com/api/collections/${collectionId}/photos`, {
      method: 'POST', headers: { Cookie: cookie }, body: form,
    })
    expect(response.status).toBe(200)
    const created = await response.json()
    expect(await env.PHOTOS.head(created.key_large)).not.toBeNull()
    expect(await env.PHOTOS.head(created.key_thumb)).not.toBeNull()
    expect(await env.DB.prepare('SELECT id FROM photos WHERE id = ?').bind(created.id).first()).not.toBeNull()
  })

  it('rejects malformed EXIF before writing R2 objects', async () => {
    const collectionId = await seedCollection({ title: 'Bad EXIF', published: 0 })
    const { cookie } = await login()
    const form = new FormData()
    const webp = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])
    form.append('large', new File([webp], 'large.webp', { type: 'image/webp' }))
    form.append('thumb', new File([webp], 'thumb.webp', { type: 'image/webp' }))
    form.append('width', '100')
    form.append('height', '80')
    form.append('exif', '{bad json')
    const response = await SELF.fetch(`https://example.com/api/collections/${collectionId}/photos`, {
      method: 'POST', headers: { Cookie: cookie }, body: form,
    })
    expect(response.status).toBe(400)
    expect((await env.PHOTOS.list()).objects).toHaveLength(0)
  })

  it('rejects files whose bytes do not match the declared image type', async () => {
    const collectionId = await seedCollection({ title: 'Fake image', published: 0 })
    const { cookie } = await login()
    const form = new FormData()
    form.append('large', new File([new Uint8Array([1, 2, 3])], 'fake.webp', { type: 'image/webp' }))
    form.append('thumb', new File([new Uint8Array([1, 2, 3])], 'fake.webp', { type: 'image/webp' }))
    form.append('width', '100')
    form.append('height', '80')
    const response = await SELF.fetch(`https://example.com/api/collections/${collectionId}/photos`, {
      method: 'POST', headers: { Cookie: cookie }, body: form,
    })
    expect(response.status).toBe(415)
    expect((await env.PHOTOS.list()).objects).toHaveLength(0)
  })

  it('removes previously written R2 objects when a later upload step fails', async () => {
    const large = { type: 'image/webp', stream: () => new ReadableStream() }
    const thumb = { type: 'image/webp', stream: () => new ReadableStream() }
    const deleted = []
    let puts = 0
    const bucket = {
      async put() { puts++; if (puts === 2) throw new Error('thumb failed') },
      async delete(keys) { deleted.push(...keys) },
    }
    await expect(persistUpload({
      bucket, keyLarge: 'large', keyThumb: 'thumb', large, thumb, insertPhoto: async () => ({ meta: {} }),
    })).rejects.toThrow('thumb failed')
    expect(deleted).toEqual(['large'])

    puts = 0
    deleted.length = 0
    bucket.put = async () => { puts++ }
    await expect(persistUpload({
      bucket, keyLarge: 'large', keyThumb: 'thumb', large, thumb,
      insertPhoto: async () => { throw new Error('db failed') },
    })).rejects.toThrow('db failed')
    expect(deleted).toEqual(['large', 'thumb'])
  })
})

describe('bulk photo operations', () => {
  it('soft-deletes many photos in one request and reassigns the cover', async () => {
    const collectionId = await seedCollection({ title: 'Bulk', published: 1 })
    const ids = []
    for (let i = 0; i < 3; i++) {
      const row = await env.DB.prepare(
        'INSERT INTO photos (collection_id, key_large, key_thumb, sort_order) VALUES (?, ?, ?, ?)'
      ).bind(collectionId, `bulk-l-${i}`, `bulk-t-${i}`, i).run()
      ids.push(row.meta.last_row_id)
    }
    await env.DB.prepare('UPDATE collections SET cover_photo_id = ? WHERE id = ?').bind(ids[0], collectionId).run()
    const { cookie } = await login()

    const response = await SELF.fetch('https://example.com/api/photos/bulk-delete', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [ids[0], ids[1]] }),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).deleted).toBe(2)

    const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE collection_id = ? AND deleted_at IS NULL')
      .bind(collectionId).first()
    expect(remaining.n).toBe(1)
    // 대표였던 사진이 지워졌으므로 남은 사진으로 옮겨져야 합니다.
    const col = await env.DB.prepare('SELECT cover_photo_id FROM collections WHERE id = ?').bind(collectionId).first()
    expect(col.cover_photo_id).toBe(ids[2])
  })

  it('moves many photos into a folder and rejects a folder from another collection', async () => {
    const collectionId = await seedCollection({ title: 'Move source' })
    const otherId = await seedCollection({ title: 'Move other' })
    const group = await env.DB.prepare('INSERT INTO groups (collection_id, name) VALUES (?, ?)')
      .bind(collectionId, 'Folder').run()
    const foreignGroup = await env.DB.prepare('INSERT INTO groups (collection_id, name) VALUES (?, ?)')
      .bind(otherId, 'Foreign').run()
    const ids = []
    for (let i = 0; i < 2; i++) {
      const row = await env.DB.prepare('INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, ?, ?)')
        .bind(collectionId, `mv-l-${i}`, `mv-t-${i}`).run()
      ids.push(row.meta.last_row_id)
    }
    const { cookie } = await login()

    const ok = await SELF.fetch('https://example.com/api/photos/bulk-move', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, group_id: group.meta.last_row_id }),
    })
    expect(ok.status).toBe(200)
    const moved = await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE group_id = ?')
      .bind(group.meta.last_row_id).first()
    expect(moved.n).toBe(2)

    const rejected = await SELF.fetch('https://example.com/api/photos/bulk-move', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, group_id: foreignGroup.meta.last_row_id }),
    })
    expect(rejected.status).toBe(400)
  })
})

describe('sort order writes', () => {
  it('stores the given order and ignores ids from another collection', async () => {
    const collectionId = await seedCollection({ title: 'Order' })
    const otherId = await seedCollection({ title: 'Order other' })
    const ids = []
    for (let i = 0; i < 3; i++) {
      const row = await env.DB.prepare('INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, ?, ?)')
        .bind(collectionId, `ord-l-${i}`, `ord-t-${i}`).run()
      ids.push(row.meta.last_row_id)
    }
    const foreign = await env.DB.prepare('INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, ?, ?)')
      .bind(otherId, 'foreign-l', 'foreign-t').run()
    const { cookie } = await login()

    const reversed = [...ids].reverse()
    const response = await SELF.fetch(`https://example.com/api/collections/${collectionId}/photo-order`, {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...reversed, foreign.meta.last_row_id] }),
    })
    expect(response.status).toBe(200)

    const { results } = await env.DB.prepare('SELECT id, sort_order FROM photos WHERE collection_id = ? ORDER BY sort_order')
      .bind(collectionId).all()
    expect(results.map((r) => r.id)).toEqual(reversed)
    // 다른 컬렉션 사진은 소유권 검사에 걸려 변경되지 않아야 합니다.
    const untouched = await env.DB.prepare('SELECT sort_order FROM photos WHERE id = ?').bind(foreign.meta.last_row_id).first()
    expect(untouched.sort_order).toBeNull()
  })

  it('rejects a malformed id list', async () => {
    const collectionId = await seedCollection({ title: 'Order invalid' })
    const { cookie } = await login()
    const response = await SELF.fetch(`https://example.com/api/collections/${collectionId}/photo-order`, {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['abc'] }),
    })
    expect(response.status).toBe(400)
  })
})

describe('image serving', () => {
  it('caches published images long-term and answers revalidation with 304', async () => {
    const collectionId = await seedCollection({ title: 'Cache', published: 1 })
    await env.PHOTOS.put('p/cache/pic-l.webp', 'binary-data')
    await env.DB.prepare('INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, ?, ?)')
      .bind(collectionId, 'p/cache/pic-l.webp', 'p/cache/pic-t.webp').run()

    const first = await SELF.fetch('https://example.com/img/p/cache/pic-l.webp')
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toContain('max-age=2592000')
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()

    const revalidated = await SELF.fetch('https://example.com/img/p/cache/pic-l.webp', {
      headers: { 'If-None-Match': etag },
    })
    expect(revalidated.status).toBe(304)
    expect(await revalidated.text()).toBe('')
  })

  it('never caches images from unpublished collections', async () => {
    const collectionId = await seedCollection({ title: 'Draft cache', published: 0 })
    await env.PHOTOS.put('p/draft/pic-l.webp', 'binary-data')
    await env.DB.prepare('INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, ?, ?)')
      .bind(collectionId, 'p/draft/pic-l.webp', 'p/draft/pic-t.webp').run()

    expect((await SELF.fetch('https://example.com/img/p/draft/pic-l.webp')).status).toBe(404)
    const { cookie } = await login()
    const asAdmin = await SELF.fetch('https://example.com/img/p/draft/pic-l.webp', { headers: { cookie } })
    expect(asAdmin.status).toBe(200)
    expect(asAdmin.headers.get('cache-control')).toBe('private, no-store')
  })
})

describe('scheduled cleanup', () => {
  it('purges expired sessions and trash past the retention window', async () => {
    const staleDate = new Date(Date.now() - (trashRetentionDays() + 1) * 24 * 60 * 60 * 1000).toISOString()
    const freshDate = new Date().toISOString()

    await env.DB.prepare('INSERT INTO admin_sessions (id, expires_at) VALUES (?, ?)')
      .bind('expired-session', Date.now() - 1000).run()
    await env.DB.prepare('INSERT INTO admin_sessions (id, expires_at) VALUES (?, ?)')
      .bind('live-session', Date.now() + 60_000).run()

    // 보관기한이 지난 사진과, 아직 남아 있어야 하는 사진
    const collectionId = await seedCollection({ title: 'Retention', published: 1 })
    await env.PHOTOS.put('p/old/gone-l.webp', 'data')
    await env.DB.prepare('INSERT INTO photos (collection_id, key_large, key_thumb, deleted_at) VALUES (?, ?, ?, ?)')
      .bind(collectionId, 'p/old/gone-l.webp', 'p/old/gone-t.webp', staleDate).run()
    await env.DB.prepare('INSERT INTO photos (collection_id, key_large, key_thumb, deleted_at) VALUES (?, ?, ?, ?)')
      .bind(collectionId, 'p/new/keep-l.webp', 'p/new/keep-t.webp', freshDate).run()
    // 보관기한이 지난 컬렉션 (사진까지 함께 사라져야 함)
    const staleCollectionId = await seedCollection({ title: 'Old collection', deletedAt: staleDate })
    await env.DB.prepare('INSERT INTO photos (collection_id, key_large, key_thumb) VALUES (?, ?, ?)')
      .bind(staleCollectionId, 'p/oldcol/l.webp', 'p/oldcol/t.webp').run()

    const summary = await runScheduledCleanup(env)

    expect(summary.sessions).toBe(1)
    expect(summary.photos).toBe(1)
    expect(summary.collections).toBe(1)
    expect(await env.DB.prepare('SELECT id FROM admin_sessions WHERE id = ?').bind('live-session').first()).toBeTruthy()
    expect(await env.DB.prepare('SELECT id FROM admin_sessions WHERE id = ?').bind('expired-session').first()).toBeNull()
    // 기한 지난 사진의 R2 객체까지 지워졌는지
    expect(await env.PHOTOS.get('p/old/gone-l.webp')).toBeNull()
    // 최근 삭제된 사진은 휴지통에 남아 복구할 수 있어야 합니다.
    const kept = await env.DB.prepare('SELECT id FROM photos WHERE key_large = ?').bind('p/new/keep-l.webp').first()
    expect(kept).toBeTruthy()
    expect(await env.DB.prepare('SELECT id FROM collections WHERE id = ?').bind(staleCollectionId).first()).toBeNull()
  })
})

describe('photo stream pagination', () => {
  it('counts the total only on the first page', async () => {
    const collectionId = await seedCollection({ title: 'Stream', published: 1 })
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare('INSERT INTO photos (collection_id, key_large, key_thumb, sort_order) VALUES (?, ?, ?, ?)')
        .bind(collectionId, `stream-l-${i}`, `stream-t-${i}`, i).run()
    }

    const firstPage = await (await SELF.fetch('https://example.com/api/photos?offset=0&limit=2')).json()
    expect(firstPage.total).toBe(3)
    expect(firstPage.photos).toHaveLength(2)

    // 이후 페이지는 total을 다시 세지 않습니다(무한 스크롤마다 전체 스캔 방지).
    const secondPage = await (await SELF.fetch('https://example.com/api/photos?offset=2&limit=2')).json()
    expect(secondPage.total).toBeNull()
    expect(secondPage.photos).toHaveLength(1)
  })
})

describe('view counting', () => {
  const visit = (headers = {}) => SELF.fetch('https://example.com/', {
    headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', ...headers },
  })
  const totalViews = async () => (await env.DB.prepare('SELECT COALESCE(SUM(views), 0) AS n FROM site_daily_views').first()).n

  it('counts a real browser navigation but not link-preview bots', async () => {
    expect(await totalViews()).toBe(0)
    await visit()
    expect(await totalViews()).toBe(1)
    // Sec-Fetch 헤더가 없는 요청(미리보기 봇·스크래퍼)은 세지 않습니다.
    await SELF.fetch('https://example.com/')
    expect(await totalViews()).toBe(1)
  })

  it('stops counting a browser that opted out with ?nostat=1', async () => {
    await visit()
    expect(await totalViews()).toBe(1)

    const response = await SELF.fetch('https://example.com/?nostat=1', {
      headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
    })
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toContain('nostat=1')

    const countBefore = await totalViews()
    await visit({ cookie })
    await visit({ cookie })
    expect(await totalViews()).toBe(countBefore)
  })

  it('excludes a logged-in admin', async () => {
    const { cookie } = await login()
    const before = await totalViews()
    await visit({ cookie })
    expect(await totalViews()).toBe(before)
  })
})

describe('api caching', () => {
  it('caches public listings briefly but never caches admin responses', async () => {
    await seedCollection({ title: 'Cacheable', published: 1 })

    const anon = await SELF.fetch('https://example.com/api/collections')
    expect(anon.headers.get('cache-control')).toContain('max-age=60')
    // 로그인 여부에 따라 내용이 달라지므로 캐시가 섞이지 않아야 합니다.
    expect(anon.headers.get('vary')).toBe('Cookie')

    const { cookie } = await login()
    const asAdmin = await SELF.fetch('https://example.com/api/collections', { headers: { cookie } })
    expect(asAdmin.headers.get('cache-control')).toBe('private, no-store')
  })

  it('keeps draft-bearing endpoints uncacheable for admins', async () => {
    const collectionId = await seedCollection({ title: 'Draft only', published: 0 })
    const { cookie } = await login()
    for (const path of ['/api/photos', '/api/feature-photos', '/api/models', `/api/collections/${collectionId}`]) {
      const response = await SELF.fetch(`https://example.com${path}`, { headers: { cookie } })
      expect(response.headers.get('cache-control'), path).toBe('private, no-store')
    }
  })
})

describe('series parsing', () => {
  it('splits 작품 - 캐릭터 and unifies punctuation spacing', () => {
    expect(splitCharacterLine('체인소 맨 - 마키마')).toEqual({ series: '체인소 맨', character: '마키마' })
    // 콜론 앞 공백이 다른 두 표기가 같은 작품으로 모입니다.
    expect(splitCharacterLine('승리의 여신 : 니케 - 크러스트').series).toBe('승리의 여신: 니케')
    expect(splitCharacterLine('승리의 여신: 니케 - 헨젤').series).toBe('승리의 여신: 니케')
    expect(normalizeSeries('붕괴 :  스타레일')).toBe('붕괴: 스타레일')
  })

  it('uses the character itself as the series when there is no 작품 prefix', () => {
    // 오리지널·보컬로이드 계열: 괄호 앞 이름이 작품이 됩니다.
    expect(splitCharacterLine('하츠네 미쿠 (ver. 뱀파이어)')).toEqual({
      series: '하츠네 미쿠', character: '하츠네 미쿠 (ver. 뱀파이어)',
    })
    expect(splitCharacterLine('카루네 시에 (하츠네 미쿠 ver. 세균오염)').series).toBe('카루네 시에')
  })

  it('prefers a stored series list over the derived one', () => {
    expect(seriesOf({ series: ['보컬로이드', '카루네 시에'], character: '카루네 시에 (…)' }))
      .toEqual(['보컬로이드', '카루네 시에'])
    expect(seriesOf({ character: '나루토 - 사스케' })).toEqual(['나루토'])
    expect(seriesOf({})).toEqual([])
  })
})

describe('series storage', () => {
  it('saves multiple series on a folder and exposes them publicly', async () => {
    const collectionId = await seedCollection({ title: 'Series', published: 1 })
    const group = await env.DB.prepare(
      `INSERT INTO groups (collection_id, name, meta_json) VALUES (?, 'Folder', '{"character":"카루네 시에 (하츠네 미쿠 ver. 세균오염)"}')`
    ).bind(collectionId).run()
    const groupId = group.meta.last_row_id
    const { cookie } = await login()

    const response = await SELF.fetch(`https://example.com/api/groups/${groupId}`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ series: '보컬로이드, 카루네 시에' }),
    })
    expect(response.status).toBe(200)

    const collection = await (await SELF.fetch(`https://example.com/api/collections/${collectionId}`)).json()
    expect(collection.groups[0].series).toEqual(['보컬로이드', '카루네 시에'])
  })

  it('backfills series from existing character lines, with a dry run first', async () => {
    const collectionId = await seedCollection({ title: 'Backfill', published: 1 })
    await env.DB.prepare(
      `INSERT INTO groups (collection_id, name, meta_json) VALUES (?, 'A', '{"character":"승리의 여신 : 니케 - 크러스트"}')`
    ).bind(collectionId).run()
    await env.DB.prepare(
      `INSERT INTO groups (collection_id, name, meta_json) VALUES (?, 'B', '{"character":"체인소 맨 - 마키마","series":["체인소 맨"]}')`
    ).bind(collectionId).run()
    const { cookie } = await login()

    const preview = await (await SELF.fetch('https://example.com/api/groups/backfill-series?dry_run=1', {
      method: 'POST', headers: { cookie },
    })).json()
    // 이미 series가 있는 폴더는 대상에서 빠집니다.
    expect(preview.planned).toHaveLength(1)
    expect(preview.planned[0].series).toEqual(['승리의 여신: 니케'])
    expect(preview.updated).toBe(0)

    const applied = await (await SELF.fetch('https://example.com/api/groups/backfill-series', {
      method: 'POST', headers: { cookie },
    })).json()
    expect(applied.updated).toBe(1)

    // 두 번 돌려도 더 바뀌지 않아야 합니다.
    const again = await (await SELF.fetch('https://example.com/api/groups/backfill-series', {
      method: 'POST', headers: { cookie },
    })).json()
    expect(again.updated).toBe(0)
  })
})

describe('search index', () => {
  it('groups characters, series, models and collections for public search', async () => {
    const collectionId = await seedCollection({ title: 'acosta!', published: 1 })
    const draftId = await seedCollection({ title: 'Draft event', published: 0 })
    const group = await env.DB.prepare(
      `INSERT INTO groups (collection_id, name, meta_json) VALUES (?, '냉수', '{"twitter":["ice"],"character":"승리의 여신 : 니케 - 크러스트","series":["승리의 여신: 니케"]}')`
    ).bind(collectionId).run()
    await env.DB.prepare('INSERT INTO photos (collection_id, group_id, key_large, key_thumb) VALUES (?, ?, ?, ?)')
      .bind(collectionId, group.meta.last_row_id, 'idx-l', 'idx-t').run()
    // 비공개 컬렉션의 폴더는 방문자 색인에 나오지 않아야 합니다.
    const hidden = await env.DB.prepare(
      `INSERT INTO groups (collection_id, name, meta_json) VALUES (?, '비밀', '{"character":"체인소 맨 - 마키마"}')`
    ).bind(draftId).run()
    await env.DB.prepare('INSERT INTO photos (collection_id, group_id, key_large, key_thumb) VALUES (?, ?, ?, ?)')
      .bind(draftId, hidden.meta.last_row_id, 'hid-l', 'hid-t').run()

    const index = await (await SELF.fetch('https://example.com/api/search-index')).json()
    expect(index.series.map((s) => s.name)).toEqual(['승리의 여신: 니케'])
    expect(index.characters[0]).toMatchObject({
      character: '승리의 여신 : 니케 - 크러스트',
      series: ['승리의 여신: 니케'],
      photo_count: 1,
      collection_title: 'acosta!',
    })
    expect(index.models[0]).toMatchObject({ handle: 'ice', photo_count: 1 })
    expect(index.collections.map((c) => c.title)).toEqual(['acosta!'])

    // 관리자는 초안까지 봅니다.
    const { cookie } = await login()
    const asAdmin = await (await SELF.fetch('https://example.com/api/search-index', { headers: { cookie } })).json()
    expect(asAdmin.series.map((s) => s.name).sort()).toEqual(['승리의 여신: 니케', '체인소 맨'])
  })
})

describe('search aliases and series cover', () => {
  it('finds a collection by its Korean nickname through the search index', async () => {
    const collectionId = await seedCollection({ title: 'Comic World', published: 1 })
    const { cookie } = await login()

    // 쉼표로 여러 통칭을 한 번에 등록
    const added = await SELF.fetch('https://example.com/api/search-aliases', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      // 행사 별칭은 이름 기준입니다(같은 이름의 다른 회차도 함께 적용).
      body: JSON.stringify({ kind: 'collection', target: 'Comic World', alias: '서코, 부코, 코믹월드' }),
    })
    expect((await added.json()).added).toBe(3)

    const index = await (await SELF.fetch('https://example.com/api/search-index')).json()
    const target = index.collections.find((c) => c.id === collectionId)
    expect(target.aliases.sort()).toEqual(['부코', '서코', '코믹월드'])

    // 삭제
    const removed = await SELF.fetch(
      `https://example.com/api/search-aliases?kind=collection&target=${encodeURIComponent('Comic World')}&alias=${encodeURIComponent('부코')}`,
      { method: 'DELETE', headers: { cookie } })
    expect(removed.status).toBe(200)
    const after = await (await SELF.fetch('https://example.com/api/search-index')).json()
    expect(after.collections.find((c) => c.id === collectionId).aliases.sort()).toEqual(['서코', '코믹월드'])
  })

  it('rejects an unknown alias kind', async () => {
    const { cookie } = await login()
    const response = await SELF.fetch('https://example.com/api/search-aliases', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'nonsense', target: '1', alias: 'x' }),
    })
    expect(response.status).toBe(400)
  })

  it('uses the chosen cover photo for a series and falls back when cleared', async () => {
    const collectionId = await seedCollection({ title: 'Cover test', published: 1 })
    const group = await env.DB.prepare(
      `INSERT INTO groups (collection_id, name, meta_json) VALUES (?, 'A', '{"character":"체인소 맨 - 마키마","series":["체인소 맨"]}')`
    ).bind(collectionId).run()
    const gid = group.meta.last_row_id
    const first = await env.DB.prepare('INSERT INTO photos (collection_id, group_id, key_large, key_thumb, sort_order) VALUES (?, ?, ?, ?, 0)')
      .bind(collectionId, gid, 'cov-l-1', 'cov-t-1').run()
    const second = await env.DB.prepare('INSERT INTO photos (collection_id, group_id, key_large, key_thumb, sort_order) VALUES (?, ?, ?, ?, 1)')
      .bind(collectionId, gid, 'cov-l-2', 'cov-t-2').run()
    const { cookie } = await login()

    // 지정 전에는 표시 순서상 첫 사진
    let data = await (await SELF.fetch('https://example.com/api/characters')).json()
    expect(data.series.find((s) => s.name === '체인소 맨').thumb).toBe('cov-t-1')

    await SELF.fetch('https://example.com/api/series-cover', {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '체인소 맨', photo_id: second.meta.last_row_id }),
    })
    data = await (await SELF.fetch('https://example.com/api/characters')).json()
    const withCover = data.series.find((s) => s.name === '체인소 맨')
    expect(withCover.thumb).toBe('cov-t-2')
    expect(withCover.cover_set).toBe(true)

    // 해제하면 다시 첫 사진으로
    await SELF.fetch('https://example.com/api/series-cover', {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '체인소 맨', photo_id: null }),
    })
    data = await (await SELF.fetch('https://example.com/api/characters')).json()
    expect(data.series.find((s) => s.name === '체인소 맨').thumb).toBe('cov-t-1')
    expect(first.meta.last_row_id).toBeTruthy()
  })
})

describe('collection aliases apply to every event with the same name', () => {
  it('shares one alias across same-titled collections', async () => {
    const may = await seedCollection({ title: 'Comic World', published: 1 })
    const july = await seedCollection({ title: 'Comic World', published: 1 })
    const other = await seedCollection({ title: 'PlayX4', published: 1 })
    await env.DB.prepare('UPDATE collections SET date = ? WHERE id = ?').bind('2026-05', may).run()
    await env.DB.prepare('UPDATE collections SET date = ? WHERE id = ?').bind('2026-07', july).run()
    const { cookie } = await login()

    // 이름 기준으로 한 번만 등록
    await SELF.fetch('https://example.com/api/search-aliases', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'collection', target: 'Comic World', alias: '서코, 부코' }),
    })

    const index = await (await SELF.fetch('https://example.com/api/search-index')).json()
    const comicWorlds = index.collections.filter((c) => c.title === 'Comic World')
    expect(comicWorlds).toHaveLength(2)
    // 회차가 달라도 둘 다 같은 검색어를 갖습니다.
    for (const col of comicWorlds) expect(col.aliases.sort()).toEqual(['부코', '서코'])
    // 다른 행사에는 번지지 않습니다.
    expect(index.collections.find((c) => c.id === other).aliases).toEqual([])
  })
})
