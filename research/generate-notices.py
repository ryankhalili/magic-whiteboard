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
    declared_license = package.get('license') or ' OR '.join(item['type'] for item in package.get('licenses', []))
    if not declared_license and name == 'khroma':
        # khroma 2.1.0 omits the package.json field but includes its MIT license.
        declared_license = 'MIT'
    row = dict(name=name, version=version, license=declared_license or 'UNKNOWN',
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
    if name == '@excalidraw/excalidraw':
        content.extend(['--- upstream Excalidraw license ---', (ROOT / 'research/licenses/excalidraw/excalidraw-MIT.txt').read_text(encoding='utf-8').strip()])
    if name.startswith('@radix-ui/') and not files:
        content.extend(['--- upstream Radix Primitives license ---', (ROOT / 'research/licenses/excalidraw/radix-primitives-LICENSE.txt').read_text(encoding='utf-8').strip()])
    if name in ('fastdom', 'strictdom'):
        readme = (directory / 'README.md').read_text(encoding='utf-8')
        content.extend(['--- README license section ---', readme[readme.rindex('## License'):].strip()])
    if name == 'react-remove-scroll-bar' and not files:
        content.extend(['--- package declaration / remaining provenance gap ---',
                        'The package and README declare MIT. No copyright/license-text file was packaged, and the published gitHead was unavailable from its repository during this update. Attribution still needs verification.', mit_body])
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

inventory = dict(auditedAt=str(date.today()), scope='Installed production packages with the Excalidraw port; includes backend and nested instances',
                 instanceCount=len(rows), uniquePackageVersions=len(seen), licenses=dict(Counter(row['license'] for row in rows)), packages=rows)
(ROOT / 'research/production-license-inventory.json').write_text(json.dumps(inventory, indent=2) + '\n', encoding='utf-8')

font_rows = json.loads((ROOT / 'research/font-license-metadata.json').read_text(encoding='utf-8'))
font_notices = sorted({notice for row in font_rows for notice in row['notices']['13']})
ofl = (ROOT / 'research/licenses/OFL-1.1.txt').read_text(encoding='utf-8')
ofl = ofl[ofl.index('-----------------------------------------------------------'):]
sections.append('KaTeX font binaries distributed by KaTeX and MathLive\n\n' + '\n\n'.join(font_notices) + '\n\n' + ofl)
font_dir = ROOT / 'research/licenses/excalidraw'
font_sections = ['Excalidraw 0.18.1 bundled fonts',
                 'These files are copied unchanged from the installed Excalidraw package. The retained font metadata and upstream license texts follow. The bundled Liberation 1.05 font uses GPL v2 with the Liberation font exception; it is not the later OFL-licensed Liberation 2.x family.']
for path in sorted(font_dir.glob('*.txt')):
    if path.name in ('excalidraw-MIT.txt', 'radix-primitives-LICENSE.txt'):
        continue
    font_sections.extend([f'--- {path.name} ---', path.read_text(encoding='utf-8').strip()])
font_sections.extend(['--- SIL Open Font License 1.1 ---', ofl])
sections.append('\n\n'.join(font_sections))
header = f'''MagiBoard — Third-party software and font notices
Generated {date.today()} from the installed production dependency tree.
These packages retain their own licenses, independently of the application's license.
This artifact includes backend dependencies as well as browser dependencies.
Remaining notice-provenance gaps: @arnog/colors and react-remove-scroll-bar (see their entries).
This includes software and font licenses with different terms; it is not a legal clearance for distribution.
'''
text = header + '\n' + ('\n\n' + '=' * 78 + '\n\n').join(sections) + '\n'
# Normalize generated formatting without changing the retained source license files.
text = '\n'.join(line.rstrip(' \t') for line in text.split('\n'))
(ROOT / 'THIRD_PARTY_NOTICES.txt').write_text(text, encoding='utf-8')
(ROOT / 'public/THIRD_PARTY_NOTICES.txt').write_text(text, encoding='utf-8')
print(json.dumps({'instances': len(rows), 'unique': len(seen), 'licenses': inventory['licenses'], 'noticeBytes': len(text.encode())}))
