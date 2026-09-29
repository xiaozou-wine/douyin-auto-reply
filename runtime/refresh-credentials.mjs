#!/usr/bin/env node
// Refresh production douyin credentials in one pass, with hard gates.
//
// Replaces the manual three-step sequence:
//   1. dy-freeze-export.mjs   browser -> local JSON (session frozen first)
//   2. dy-push-env.mjs        local JSON -> VPS .pending-env-update.json
//   3. deploy-env.py          VPS: atomic .env replace, mode 600
//
// Why freezing matters: an open douyin tab keeps rotating sessionid. Exporting
// while the tab is live can produce a value that is already stale before it
// lands on the VPS. Observed 2026-09-25: a non-frozen export yielded
// ttl=0.25d and was rejected immediately, while a frozen export a minute later
// yielded ttl=60d and worked.
//
// Gates, all checked BEFORE anything reaches production:
//   - sid_guard ttl >= --min-ttl-days        (default 30)
//   - cookie count  >= --min-cookies         (default 60)
//   - required cookie fields all present
// And after deploy:
//   - check_sessionid.py must report verdict=valid, else .env is rolled back.
//
// Credential values are never printed; only lengths, hashes and field names.
//
// Usage:
//   node runtime/refresh-credentials.mjs
//   node runtime/refresh-credentials.mjs --no-deploy      # export + gate only
//   node runtime/refresh-credentials.mjs --cdp http://127.0.0.1:9333 --vps root@host
//
// --vps is required for the deploy steps; DOUYIN_VPS is read as the default.
// The production host is deliberately not committed to this repo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Fields that were missing from the ttl=0.25d export. If any is absent the
// export was taken mid-flight and must not be deployed.
const REQUIRED_COOKIES = [
  'UIFID', 's_v_web_id', 'sid_guard', 'login_time',
  'passport_assist_user', 'x_tt_token', 'is_dbsc',
];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

function parseArgs(argv) {
  const out = {
    cdp: 'http://127.0.0.1:9333',
    // 生产主机地址不入库：部署时用 --vps 或 DOUYIN_VPS 指定。
    vps: process.env.DOUYIN_VPS ?? '',
    remoteDir: '/root/douyin-spark',
    minTtlDays: 30,
    minCookies: 60,
    deploy: true,
    fromExport: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cdp') out.cdp = argv[++i];
    else if (a === '--from-export') out.fromExport = argv[++i];
    else if (a === '--vps') out.vps = argv[++i];
    else if (a === '--min-ttl-days') out.minTtlDays = Number(argv[++i]);
    else if (a === '--min-cookies') out.minCookies = Number(argv[++i]);
    else if (a === '--no-deploy') out.deploy = false;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function run(cmd, args, label) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`\n[FAIL] ${label}`);
    if (res.stdout) console.error(res.stdout.trim());
    if (res.stderr) console.error(res.stderr.trim());
    process.exit(res.status ?? 1);
  }
  return res.stdout ?? '';
}

function ssh(vps, command, label) {
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', vps, command], label);
}

function abort(message) {
  console.error(`\n[GATE FAILED] ${message}`);
  console.error('refusing to deploy; production .env untouched');
  process.exit(1);
}

function describeGuard(raw) {
  const parts = decodeURIComponent(raw ?? '').split('|');
  if (parts.length < 3) return null;
  const issued = new Date(Number(parts[1]) * 1000);
  const ttlDays = Number(parts[2]) / 86400;
  return { issued, ttlDays };
}

const args = parseArgs(process.argv.slice(2));
if (args.deploy && !args.vps) {
  console.error('missing target host: pass --vps root@host or set DOUYIN_VPS');
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-refresh-'));
const exportPath = path.join(work, 'export.json');
const payloadPath = path.join(work, 'payload.json');
let keepWork = false;

try {
  // ---- 1. frozen export -------------------------------------------------
  // --from-export bypasses the browser entirely. Loading douyin.com rotates
  // sessionid, which can invalidate a credential that is currently working, so
  // the browser path must only run when the deployed credential is already dead.
  if (args.fromExport) {
    console.log(`[1/5] reusing export ${args.fromExport} (browser NOT touched)`);
    fs.copyFileSync(args.fromExport, exportPath);
  } else {
    console.log(`[1/5] frozen export via ${args.cdp}`);
    run('node', [
      path.join(HERE, 'dy-freeze-export.mjs'),
      '--out', exportPath,
      '--cdp', args.cdp,
    ], 'freeze-export');
  }

  const exp = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  const cookies = exp.cookies ?? {};
  const names = Object.keys(cookies);
  console.log(`      sessionid sha8=${sha(exp.sessionid)} len=${exp.sessionid.length}`);
  console.log(`      ms_token  len=${(exp.msToken ?? '').length}`);
  console.log(`      cookies   n=${names.length}`);

  // ---- 2. gates ---------------------------------------------------------
  console.log('[2/5] gates');

  const missing = REQUIRED_COOKIES.filter((k) => !names.includes(k));
  if (missing.length > 0) {
    abort(`required cookie field(s) absent: ${missing.join(', ')} — export taken mid-flight`);
  }
  if (names.length < args.minCookies) {
    abort(`only ${names.length} cookies, need >= ${args.minCookies}`);
  }
  if (!exp.msToken) {
    abort('msToken (localStorage "xmst") is empty; config validation would drop the account');
  }

  const guard = describeGuard(cookies.sid_guard?.value);
  if (!guard) {
    abort('sid_guard is absent or unparsable; cannot confirm session lifetime');
  }
  console.log(`      sid_guard issued=${guard.issued.toISOString().slice(0, 16)}Z ttl=${guard.ttlDays.toFixed(2)}d`);
  if (!(guard.ttlDays >= args.minTtlDays)) {
    abort(`sid_guard ttl is ${guard.ttlDays.toFixed(2)}d, need >= ${args.minTtlDays}d — this is the short-lived signature`);
  }
  console.log('      all gates passed');

  if (!args.deploy) {
    console.log('\n[--no-deploy] stopping before push');
    keepWork = true;
    console.log(`export kept at ${exportPath}`);
    process.exit(0);
  }

  // ---- 3. push + deploy -------------------------------------------------
  console.log('[3/5] push payload to VPS');
  const pending = `${args.vps}:${args.remoteDir}/.pending-env-update.json`;
  run('node', [
    path.join(HERE, 'dy-push-env.mjs'),
    '--in', exportPath,
    '--out', payloadPath,
    '--push', pending,
  ], 'push-env');

  console.log('[4/5] apply to .env (atomic, mode 600)');
  const deployOut = ssh(args.vps, `cd ${args.remoteDir} && python3 ${args.remoteDir}/tools/deploy-env.py`,
    'deploy-env.py');
  process.stdout.write(deployOut);
  if (!deployOut.includes('DEPLOY_OK')) {
    abort('deploy-env.py did not report DEPLOY_OK');
  }

  // ---- 5. verify, roll back on failure ----------------------------------
  console.log('[5/5] verify against live endpoint');
  const verify = ssh(args.vps,
    `cd ${args.remoteDir} && timeout 120 .venv/bin/python3 check_sessionid.py 2>&1 | tail -3`,
    'check_sessionid.py');
  process.stdout.write(verify);

  if (verify.includes('verdict=valid')) {
    console.log('\nRESULT=REFRESHED');
    process.exit(0);
  }

  // deploy-env.py backs up the previous .env before replacing, so the newest
  // .env.bak.refresh-* is exactly the pre-deploy state.
  console.error('\n[verify failed] rolling back');
  const rollback = ssh(args.vps,
    `cd ${args.remoteDir} && f=$(ls -t .env.bak.refresh-* 2>/dev/null | head -1) && ` +
    `if [ -n "$f" ]; then cp -p "$f" .env && echo "restored $f"; else echo "NO_BACKUP"; fi`,
    'rollback');
  process.stdout.write(rollback);
  console.error('RESULT=ROLLED_BACK');
  process.exit(1);
} finally {
  if (!keepWork) {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
