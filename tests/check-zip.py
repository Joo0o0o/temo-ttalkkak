"""Validate a ZIP from the extension without printing patient names."""
import json, sys, zipfile, re
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
names = z.namelist()
pdfs = [n for n in names if n.endswith('.pdf')]
pages = []
for n in pdfs:
    b = z.read(n)
    assert b.startswith(b'%PDF-'), n
    pages.append(len(re.findall(rb'/Type\s*/Page\b', b)))
manifest = json.loads(z.read('results.json'))
ok = [o for o in manifest['outcomes'] if o['status'] == 'success']
assert sorted(o['filename'] for o in ok) == sorted(pdfs)
assert all(re.fullmatch(r'.+ - \d{4}-\d{2}-\d{2}(?: \(\d+\))?\.pdf', n) for n in pdfs)
csv = z.read('결과목록.csv').decode('utf-8-sig')
print(json.dumps({'crc_ok': bad is None, 'entries': len(names), 'pdfs': len(pdfs), 'pages_total': sum(pages),
                  'pages_per_pdf': sorted(set(pages)), 'status': manifest['status'], 'month': manifest.get('month'),
                  'outcomes': len(manifest['outcomes']), 'issues': len(manifest['issues']), 'csv_rows': csv.count('\r\n') + 1}, ensure_ascii=False))
