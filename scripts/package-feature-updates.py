#!/usr/bin/env python3
"""Maintainer-only: build explicit feature assets without personal project files."""
from pathlib import Path
import argparse, hashlib, json, zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
sums = []
for module in sorted((root / 'updates/modules').iterdir()):
    if not module.is_dir():
        continue
    manifest = json.loads((module / 'manifest.json').read_text())
    patch = (module / 'update.patch').read_bytes()
    if hashlib.sha256(patch).hexdigest() != manifest['patchSha256']:
        raise SystemExit('Patch hash mismatch: ' + module.name)
    target = out / (manifest['id'] + '-' + manifest['version'] + '.zip')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for name in ['README.md', 'CODEX.md', 'manifest.json', 'update.patch']:
            info = zipfile.ZipInfo(module.name + '/' + name, (2026, 10, 26, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, (module / name).read_bytes())
        info = zipfile.ZipInfo(module.name + '/check.mjs', (2026, 10, 26, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        bundle.writestr(info, (root / 'scripts/check-feature-update.mjs').read_bytes())
    sums.append(hashlib.sha256(target.read_bytes()).hexdigest() + '  ' + target.name)
(out / 'SHA256SUMS.txt').write_text('\n'.join(sums) + '\n')
print('\n'.join(sums))
