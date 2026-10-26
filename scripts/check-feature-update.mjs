#!/usr/bin/env node
// 읽기 전용: 프로젝트 파일이나 Git 기록을 수정하지 않습니다.
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { resolve, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const bundled = existsSync(resolve(scriptDir, 'manifest.json'))
const [first, second] = process.argv.slice(2)
const moduleDir = bundled ? scriptDir : resolve(scriptDir, '../updates/modules', first || '')
const project = realpathSync(resolve((bundled ? first : second) || process.cwd()))
const fail = (message) => { console.error(message); process.exit(1) }
if (!bundled && !/^[a-z][a-z0-9-]+$/.test(first || '')) fail('사용법: node scripts/check-feature-update.mjs <기능 ID> [대상 프로젝트 폴더]')
const manifest = JSON.parse(readFileSync(resolve(moduleDir, 'manifest.json'), 'utf8'))
const patch = resolve(moduleDir, 'update.patch')
const content = readFileSync(patch)
if (createHash('sha256').update(content).digest('hex') !== manifest.patchSha256) fail('패치 파일 무결성 확인 실패. ZIP을 다시 내려받으세요.')
const allowed = new Set(['public/admin.js', 'public/admin.html', 'public/app.js', 'public/style.css', 'src/worker.js'])
const declared = new Set()
for (const item of manifest.files) {
  const path = item.path
  if (!allowed.has(path) && !/^test\/[a-z0-9.-]+\.(?:js|mjs)$/.test(path)) fail('허용되지 않은 변경 경로: ' + path)
  if (declared.has(path)) fail('중복 변경 경로: ' + path)
  declared.add(path)
  const target = resolve(project, path)
  const parent = existsSync(target) ? realpathSync(target) : realpathSync(dirname(target))
  const rel = relative(project, parent)
  if (rel.startsWith('..') || isAbsolute(rel)) fail('프로젝트 외부를 가리키는 경로: ' + path)
}
const patchPaths = [...content.toString('utf8').matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
if (patchPaths.length !== declared.size || patchPaths.some(([, a, b]) => a !== b || !declared.has(a))) fail('패치 경로와 기능 설명이 일치하지 않습니다.')
for (const guard of manifest.requiredMarkers || []) {
  if (!readFileSync(resolve(project, guard.path), 'utf8').includes(guard.text)) fail('선행 기능이 필요합니다: ' + manifest.requires.join(', ') + '\n확인 항목: ' + guard.path)
}
const run = (reverse = false) => spawnSync('git', ['apply', '--check', ...(reverse ? ['--reverse'] : []), patch], { cwd: project, encoding: 'utf8' })
const check = run()
if (check.error) fail('Git을 실행할 수 없습니다. Git 설치 상태를 확인하세요.')
if (check.status !== 0) {
  if (run(true).status === 0) { console.log(manifest.title + ': 이미 적용된 변경입니다. 다시 적용하지 마세요.'); process.exit(0) }
  console.error(check.stderr)
  fail('자동 적용할 수 없습니다. CODEX.md의 요청문으로 현재 코드와 비교해 적용하세요. 파일은 변경하지 않았습니다.')
}
console.log(manifest.title + ': 패치 적용 검사 통과. 파일은 변경하지 않았습니다.')
console.log('변경 파일: ' + [...declared].join(', '))
console.log('다음 단계: README.md에 따라 백업 후 적용 → 테스트 → 본인 Cloudflare에 배포')
