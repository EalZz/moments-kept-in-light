import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const base = 'c1e54c341b420e2307ae381faa7be895b4c7a265'
const ids = ['model-display-names', 'tweet-import-select', 'gallery-layout', 'featured-photo-transition']
const patch = (id) => join(root, 'updates/modules', id, 'update.patch')
const inspect = (id, project) => spawnSync(process.execPath, [join(root, 'scripts/check-feature-update.mjs'), id, project], { encoding: 'utf8' })
function fixture(fn) {
  const temp = mkdtempSync(join(tmpdir(), 'pht-update-test-'))
  try {
    const archive = execFileSync('git', ['archive', base], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', temp], { input: archive })
    fn(temp)
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
function apply(id, project, reverse = false) {
  execFileSync('git', ['apply', ...(reverse ? ['--reverse'] : []), patch(id)], { cwd: project })
}
for (const id of ids) test(`${id}: read-only preflight, apply, detect installed, reverse`, () => fixture((project) => {
  if (id === 'tweet-import-select') apply('model-display-names', project)
  const manifest = JSON.parse(readFileSync(join(root, 'updates/modules', id, 'manifest.json')))
  const snapshot = () => manifest.files.map(({ path }) => existsSync(join(project, path)) ? readFileSync(join(project, path), 'utf8') : null)
  const before = snapshot()
  const check = inspect(id, project)
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /검사 통과/)
  assert.deepEqual(snapshot(), before, 'preflight must not modify target files')
  apply(id, project)
  const installed = inspect(id, project)
  assert.equal(installed.status, 0, installed.stderr)
  assert.match(installed.stdout, /이미 적용/)
  apply(id, project, true)
  assert.deepEqual(snapshot(), before, 'reverse must restore the target exactly')
}))
test('tweet package rejects a missing prerequisite without changing files', () => fixture((project) => {
  const before = readFileSync(join(project, 'public/admin.js'))
  const result = inspect('tweet-import-select', project)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /선행 기능/)
  assert.deepEqual(readFileSync(join(project, 'public/admin.js')), before)
}))
test('a conflicting customization is preserved', () => fixture((project) => {
  const target = join(project, 'public/app.js')
  writeFileSync(target, '/* my custom application */\n')
  const result = inspect('gallery-layout', project)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /자동 적용할 수 없습니다/)
  assert.equal(readFileSync(target, 'utf8'), '/* my custom application */\n')
}))
test('bundle preflight refuses a tampered patch', () => fixture((project) => {
  const bundle = join(project, 'bundle'); mkdirSync(bundle)
  cpSync(join(root, 'updates/modules/gallery-layout/manifest.json'), join(bundle, 'manifest.json'))
  cpSync(join(root, 'scripts/check-feature-update.mjs'), join(bundle, 'check.mjs'))
  writeFileSync(join(bundle, 'update.patch'), 'tampered')
  const result = spawnSync(process.execPath, [join(bundle, 'check.mjs'), project], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /무결성/)
}))
test('all four updates compose and reverse in dependency order', () => fixture((project) => {
  const files = ['public/app.js', 'public/admin.js', 'public/style.css', 'src/worker.js']
  const before = files.map((path) => readFileSync(join(project, path)))
  for (const id of ids) {
    const result = inspect(id, project)
    assert.equal(result.status, 0, id + ': ' + result.stderr)
    apply(id, project)
  }
  for (const id of [...ids].reverse()) apply(id, project, true)
  assert.deepEqual(files.map((path) => readFileSync(join(project, path))), before)
}))
