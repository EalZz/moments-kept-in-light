import { describe, expect, it } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { persistUpload } from '../src/worker.js'

async function login(password = 'test-password') {
  const response = await SELF.fetch('https://example.com/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

async function seedCollection({ title, published = 1, deletedAt = null } = {}) {
  const result = await env.DB.prepare(
    'INSERT INTO collections (title, description, published, deleted_at) VALUES (?, ?, ?, ?)'
  ).bind(title || 'Collection', 'Description', published, deletedAt).run()
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
