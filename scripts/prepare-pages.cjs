const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'cachetraywebsite');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cachetray-pages-'));
let count = 0;
function copy(source, target) {
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === 'vercel.json' || /\.(zip|log|md)$/.test(item.name)) continue;
    const input = path.join(source, item.name), output = path.join(target, item.name);
    if (item.isDirectory()) { fs.mkdirSync(output); copy(input, output); continue; }
    if (/\.(js|html|json|webmanifest|txt)$/.test(item.name)) {
      const text = fs.readFileSync(input, 'utf8');
      if (/whsec_[A-Za-z0-9+/=_-]+|\b[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,}\b|-----BEGIN .*PRIVATE KEY-----/.test(text)) throw Error('Possible credential in ' + input);
    }
    fs.copyFileSync(input, output); count++;
  }
}
copy(root, stage);
console.log(JSON.stringify({ directory: stage, files: count, credentialScan: 'passed' }));
