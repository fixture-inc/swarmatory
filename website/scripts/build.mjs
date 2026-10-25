import { mkdir, cp, rm, copyFile } from 'node:fs/promises';
await rm('.build', { recursive: true, force: true });
await mkdir('.build/public', { recursive: true });
await cp('assets', '.build/public/assets', { recursive: true, filter: source => !source.endsWith('README.md') });
await copyFile('_headers', '.build/public/_headers');
await copyFile('install.md', '.build/public/install.md');
console.log('Prepared public assets only.');
