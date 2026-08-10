'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = [
  path.join(__dirname, '..', 'src'),
  path.join(__dirname, '..', 'test'),
  path.join(__dirname, '..', 'scripts'),
];

const files = [];
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const entry of fs.readdirSync(root)) {
    if (entry.endsWith('.js')) files.push(path.join(root, entry));
  }
}

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`语法错误 ${file}:\n${result.stderr || result.stdout}`);
  }
}

if (failed) {
  process.exit(1);
}
console.log(`语法检查通过（${files.length} 个文件）`);
