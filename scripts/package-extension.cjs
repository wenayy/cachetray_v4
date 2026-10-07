const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const files = [
  'manifest.json', 'background.js', 'content-script.js',
  'offscreen.html', 'offscreen.js', 'shared.js', 'collection-store.js', 'popup.html', 'popup.css', 'popup.js',
  'sidebar.html', 'sidebar.css', 'theme-boot.js', 'qr-code.js', 'transfer-config.js',
  'transfer-controller.js', 'transfer-ui.js', 'billing-ui.js', 'cloud-controller.js',
  'cloud-sync.js', 'cloud-ui.js', 'firebase-config.js', 'image-health.html',
  'image-health.js', 'icon.svg', 'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png',
  'images/image.png', 'QR_CODE_LICENSE.txt', 'SHARE_PACKAGE_README.txt'
];
for (const file of files) {
  const bytes = fs.readFileSync(path.join(root, file));
  if (/\.(js|html|css|json|txt|svg)$/.test(file)) {
    const text = bytes.toString('utf8');
    if (/whsec_[A-Za-z0-9+/=_-]+|\b[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      throw Error('Possible private credential in ' + file + '; package refused.');
    }
    if (file.endsWith('.html')) {
      for (const match of text.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        const ref = match[1].split(/[?#]/)[0];
        if (!ref.includes(':') && !files.includes(ref)) throw Error('Missing packaged HTML resource: ' + ref);
      }
    }
  }
}
const archive = path.join(root, `CacheTray-${manifest.version}.zip`);
if (fs.existsSync(archive)) throw Error('Archive already exists; refusing to overwrite: ' + archive);
execFileSync('zip', ['-q', archive, ...files], { cwd: root });
execFileSync('unzip', ['-tq', archive], { stdio: 'inherit' });
const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
if (entries.length !== files.length || entries.some(file => !files.includes(file))) throw Error('Unexpected archive contents');
const archivedManifest = JSON.parse(execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }));
if (archivedManifest.version !== manifest.version) throw Error('Archive version mismatch');
console.log(JSON.stringify({ archive, version: manifest.version, files: entries.length, bytes: fs.statSync(archive).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), credentialScan: 'passed' }, null, 2));
