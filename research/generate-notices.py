"""Regenerate installed production notices without changing packages or reading secrets.

Run after npm ci: python research/generate-notices.py
"""
from collections import Counter
from datetime import date
from pathlib import Path
import json
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
NPM = shutil.which('npm.cmd') or shutil.which('npm')
paths = subprocess.check_output([NPM, 'ls', '--omit=dev', '--all', '--parseable'], cwd=ROOT, text=True).splitlines()[1:]
direct = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['dependencies']
rows, sections, seen = [], [], set()
mit = (ROOT / 'node_modules/katex/LICENSE').read_text(encoding='utf-8')
mit_body = mit[mit.index('Permission is hereby granted'):]

for raw in sorted(paths, key=str.casefold):
    directory = Path(raw)
    package = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
    name, version = package['name'], package['version']
    files = sorted(p for p in directory.iterdir() if p.is_file() and p.name.lower().startswith(('license', 'licence', 'copying', 'copyright', 'notice')))
    row = dict(name=name, version=version, license=package.get('license', 'UNKNOWN'),
               direct=name in direct and directory == ROOT / 'node_modules' / name,
               path=directory.relative_to(ROOT).as_posix(), licenseFiles=[p.name for p in files],
               repository=package.get('repository'))
    rows.append(row)
    identity = (name, version)
    if identity in seen:
        continue
    seen.add(identity)
    content = [f'{name}@{version}', f'Declared license: {row["license"]}', f'Installed path: {row["path"]}']
    for path in files:
        content.extend([f'--- {path.name} ---', path.read_text(encoding='utf-8-sig', errors='replace').strip()])
    if name == 'pako':
        content.extend(['--- bundled zlib port notice ---', (directory / 'lib/zlib/README').read_text(encoding='utf-8').strip()])
    if name == 'seedrandom':
        readme = (directory / 'README.md').read_text(encoding='utf-8')
        start = readme.rfind('The MIT License')
        if start < 0:
            start = readme.rfind('Copyright')
        content.extend(['--- README license section ---', readme[start:].strip()])
    if name == 'javascript-natural-sort':
        source = (directory / 'naturalSort.js').read_text(encoding='utf-8')
        content.extend(['--- distributed author/license declaration ---', source[:source.index('*/') + 2], mit_body])
    if name == '@arnog/colors':
        content.extend(['--- package declaration / remaining provenance gap ---',
                        'The installed package declares MIT. Its published repository is https://github.com/arnog/colors.',
                        'No copyright/license-text file was packaged; the repository was unavailable during the audit.',
                        'The standard MIT terms follow. Copyright attribution must be resolved before release.', mit_body])
    sections.append('\n\n'.join(content))

inventory = dict(auditedAt=str(date.today()), scope='Installed production packages after removal of tldraw; includes backend and nested instances',
                 instanceCount=len(rows), uniquePackageVersions=len(seen), licenses=dict(Counter(row['license'] for row in rows)), packages=rows)
(ROOT / 'research/production-license-inventory.json').write_text(json.dumps(inventory, indent=2) + '\n', encoding='utf-8')

font_rows = json.loads((ROOT / 'research/font-license-metadata.json').read_text(encoding='utf-8'))
font_notices = sorted({notice for row in font_rows for notice in row['notices']['13']})
ofl = (ROOT / 'research/licenses/OFL-1.1.txt').read_text(encoding='utf-8')
ofl = ofl[ofl.index('-----------------------------------------------------------'):]
sections.append('KaTeX font binaries distributed by KaTeX and MathLive\n\n' + '\n\n'.join(font_notices) + '\n\n' + ofl)
header = f'''Magic Whiteboard — Third-party software and font notices
Generated {date.today()} from the installed production dependency tree.
These packages retain their own licenses, independently of the application's license.
This artifact includes backend dependencies as well as browser dependencies.
Remaining notice-provenance gap: @arnog/colors (see its entry and research/COMMERCIALIZATION.md).
'''
text = header + '\n' + ('\n\n' + '=' * 78 + '\n\n').join(sections) + '\n'
(ROOT / 'THIRD_PARTY_NOTICES.txt').write_text(text, encoding='utf-8')
(ROOT / 'public/THIRD_PARTY_NOTICES.txt').write_text(text, encoding='utf-8')
print(json.dumps({'instances': len(rows), 'unique': len(seen), 'licenses': inventory['licenses'], 'noticeBytes': len(text.encode())}))
