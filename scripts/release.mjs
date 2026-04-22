#!/usr/bin/env node
/**
 * 一键发版：
 *   npm run release 1.0.4               → 改 package.json version、commit、tag、push
 *   npm run release 1.0.4 --dry-run     → 只改版本，不 commit/tag/push
 *   npm run release patch|minor|major   → 按 semver 自动 +1
 *
 * 前置要求：工作区干净（没有未提交改动）。
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bumpArg = args.find((a) => !a.startsWith('--'));
if (!bumpArg) {
    console.error('Usage: npm run release <version|patch|minor|major> [--dry-run]');
    process.exit(1);
}

function run(cmd, opts = {}) {
    console.log('$', cmd);
    return execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
}

function check(cmd) {
    return execSync(cmd, { cwd: root }).toString().trim();
}

// 检查工作区
const status = check('git status --porcelain');
if (status && !dryRun) {
    console.error('✗ 工作区不干净，请先提交或暂存：\n' + status);
    process.exit(1);
}

// 读取当前版本
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cur = pkg.version;
const [maj, min, pat] = cur.split('.').map(Number);

let next;
if (bumpArg === 'patch') next = `${maj}.${min}.${pat + 1}`;
else if (bumpArg === 'minor') next = `${maj}.${min + 1}.0`;
else if (bumpArg === 'major') next = `${maj + 1}.0.0`;
else if (/^\d+\.\d+\.\d+(-.+)?$/.test(bumpArg)) next = bumpArg;
else {
    console.error('✗ 无效版本号：' + bumpArg);
    process.exit(1);
}

console.log(`→ ${cur}  →  ${next}${dryRun ? '  (dry-run)' : ''}`);

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('✓ package.json updated');

if (dryRun) {
    console.log('⋯ dry-run 完成（未提交 / 未打 tag / 未推送）');
    process.exit(0);
}

run('git add package.json');
run(`git commit -m "release: v${next}"`);
run(`git tag v${next}`);
run('git push');
run(`git push origin v${next}`);

console.log(`\n✓ 已发布 v${next}`);
console.log('  查看 CI：https://github.com/finalpi/MqttMountain/actions');
console.log(`  查看 Release：https://github.com/finalpi/MqttMountain/releases/tag/v${next}`);
