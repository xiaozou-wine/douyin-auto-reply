import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import type { NormalizedCredentials } from './normalize.js';
import { CredentialRefreshError } from './errors.js';

export interface CandidateSemanticReport {
  taskCount: number;
  userIdIsDecimal: boolean;
  requiredCookieNamesPresent: boolean;
  sessionMatchesCookie: boolean;
  credentialAssignmentCount: number;
}

export type PythonProbe = (candidate: string) => string;

export function renderCandidateEnv(template: string, credentials: NormalizedCredentials): string {
  requireSingleAssignment(template, 'TASKS');
  const parsed = dotenv.parse(template);
  const task = parseSingleTask(parsed.TASKS);
  if (task.user_id !== credentials.userId) {
    throw new CredentialRefreshError('ACCOUNT_MISMATCH', 'Browser account does not match template');
  }

  const cookieKey = `COOKIES_${credentials.userId}`;
  const sessionKey = `SESSIONID_${credentials.userId}`;
  requireOnlyCredentialAssignments(template, cookieKey, sessionKey);
  requireSingleAssignment(template, cookieKey);
  requireSingleAssignment(template, sessionKey);

  let candidate = replaceAssignment(template, cookieKey, quoteConservative(credentials.cookieHeader));
  candidate = replaceAssignment(candidate, sessionKey, quoteConservative(credentials.sessionId));
  return candidate;
}

export function validateCandidateSemantics(
  template: string,
  candidate: string,
  credentials: NormalizedCredentials,
  runPythonProbe: PythonProbe = defaultPythonProbe,
): CandidateSemanticReport {
  const parsed = dotenv.parse(candidate);
  const cookieKey = `COOKIES_${credentials.userId}`;
  const sessionKey = `SESSIONID_${credentials.userId}`;
  if (parsed[cookieKey] !== credentials.cookieHeader || parsed[sessionKey] !== credentials.sessionId) {
    throw new CredentialRefreshError('TEMPLATE_INVALID', 'Candidate dotenv parsing changed credential values');
  }
  assertNonCredentialTextUnchanged(template, candidate, cookieKey, sessionKey);

  let stdout: string;
  try {
    stdout = runPythonProbe(candidate);
  } catch {
    throw new CredentialRefreshError('PYTHON_DOTENV_UNAVAILABLE', 'Python dotenv validation is unavailable');
  }

  let report: CandidateSemanticReport;
  try {
    report = JSON.parse(stdout) as CandidateSemanticReport;
  } catch {
    throw new CredentialRefreshError('TEMPLATE_INVALID', 'Candidate dotenv validation failed');
  }
  if (
    report.taskCount !== 1 ||
    !report.userIdIsDecimal ||
    !report.requiredCookieNamesPresent ||
    !report.sessionMatchesCookie ||
    report.credentialAssignmentCount !== 2
  ) {
    throw new CredentialRefreshError('TEMPLATE_INVALID', 'Candidate dotenv validation failed');
  }
  return report;
}

function defaultPythonProbe(candidate: string): string {
  const executable = process.platform === 'win32' ? 'python' : 'python3';
  return execFileSync(
    executable,
    [path.resolve('tests/credentials/python-dotenv-probe.py')],
    { input: candidate, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
  );
}

export interface ParsedTemplateAccount {
  userId: string;
}

export interface ParsedCookieHeader {
  values: Record<string, string>;
  duplicateNames: ReadonlySet<string>;
  malformed: boolean;
}

export function parseSingleTemplateAccount(text: string): ParsedTemplateAccount | null {
  try {
    requireSingleAssignment(text, 'TASKS');
    const task = parseSingleTask(dotenv.parse(text).TASKS);
    return { userId: task.user_id };
  } catch {
    return null;
  }
}

export function hasParseableAssignments(text: string): boolean {
  try {
    return Object.keys(dotenv.parse(text)).length > 0;
  } catch {
    return false;
  }
}

export function countAssignments(text: string, key: string): number {
  return (text.match(new RegExp(`^${escapeRegExp(key)}=.*$`, 'gm')) ?? []).length;
}

export function redactCredentialAssignments(text: string, cookieKey: string, sessionKey: string): string {
  return text
    .replace(new RegExp(`^${escapeRegExp(cookieKey)}=.*$`, 'm'), `${cookieKey}=<credential>`)
    .replace(new RegExp(`^${escapeRegExp(sessionKey)}=.*$`, 'm'), `${sessionKey}=<credential>`);
}

export function parseCookieHeader(text: string): ParsedCookieHeader {
  const values: Record<string, string> = {};
  const duplicateNames = new Set<string>();
  let malformed = false;

  for (const rawItem of text.split(';')) {
    const item = rawItem.trim();
    const separator = item.indexOf('=');
    if (!item || separator <= 0) {
      malformed = true;
      continue;
    }
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1);
    if (!name || !value) {
      malformed = true;
      continue;
    }
    if (Object.hasOwn(values, name)) {
      duplicateNames.add(name);
      continue;
    }
    values[name] = value;
  }
  return { values, duplicateNames, malformed };
}

export function parseEnv(text: string): Record<string, string> {
  return dotenv.parse(text);
}

export interface PrivatePaths {
  dir: string;
  templatePath: string;
  outputPath: string;
}

export interface PrivateSecurityAdapter {
  isIgnored(outputPath: string): boolean;
  preparePrivateFile(filePath: string): void;
  assertAclSafe(filePath: string): void;
  validateWrittenText?(text: string): void;
  syncDirectory?(directory: string): void;
}

export function preflightPrivatePaths(paths: PrivatePaths, adapter: PrivateSecurityAdapter): void {
  let realDir: string;
  let templateStat: fs.Stats;
  try {
    realDir = fs.realpathSync(paths.dir);
    templateStat = fs.lstatSync(paths.templatePath);
  } catch {
    failUnsafe();
  }

  if (!templateStat!.isFile() || templateStat!.isSymbolicLink()) failUnsafe();
  if (path.dirname(path.resolve(paths.outputPath)) !== realDir!) failUnsafe();

  try {
    const outputStat = fs.lstatSync(paths.outputPath);
    if (outputStat.isSymbolicLink()) failUnsafe();
    throw new CredentialRefreshError('OUTPUT_EXISTS', 'Credential candidate already exists');
  } catch (error) {
    if (error instanceof CredentialRefreshError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failUnsafe();
  }

  try {
    if (path.dirname(fs.realpathSync(paths.templatePath)) !== realDir! || !adapter.isIgnored(paths.outputPath)) failUnsafe();
  } catch (error) {
    if (error instanceof CredentialRefreshError) throw error;
    failUnsafe();
  }
}

export function installCandidateEnv(paths: PrivatePaths, candidate: string, adapter: PrivateSecurityAdapter): void {
  preflightPrivatePaths(paths, adapter);
  const tempPath = path.join(paths.dir, `.env.next.tmp-${process.pid}-${crypto.randomUUID()}`);
  let tempCreated = false;
  let outputCreated = false;

  try {
    const handle = fs.openSync(tempPath, 'wx', 0o600);
    tempCreated = true;
    try {
      adapter.preparePrivateFile(tempPath);
      adapter.assertAclSafe(tempPath);
      fs.writeFileSync(handle, candidate, { encoding: 'utf8' });
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }

    if (process.platform !== 'win32') fs.chmodSync(tempPath, 0o600);
    const written = fs.readFileSync(tempPath, 'utf8');
    adapter.validateWrittenText?.(written);
    fs.linkSync(tempPath, paths.outputPath);
    outputCreated = true;
    if (process.platform !== 'win32') fs.chmodSync(paths.outputPath, 0o600);
    try {
      adapter.assertAclSafe(paths.outputPath);
    } catch {
      fs.rmSync(paths.outputPath, { force: true });
      outputCreated = false;
      failUnsafe();
    }
    (adapter.syncDirectory ?? fsyncDirectory)(paths.dir);
  } catch (error) {
    if (outputCreated) fs.rmSync(paths.outputPath, { force: true });
    if (error instanceof CredentialRefreshError) throw error;
    throw new CredentialRefreshError('WRITE_FAILED', 'Could not write credential candidate');
  } finally {
    if (tempCreated) fs.rmSync(tempPath, { force: true });
  }
}

export function createDefaultSecurityAdapter(): PrivateSecurityAdapter {
  return {
    isIgnored: (outputPath) => {
      try {
        execFileSync('git', ['check-ignore', '--quiet', outputPath], { stdio: 'ignore', windowsHide: true });
        return true;
      } catch {
        return false;
      }
    },
    preparePrivateFile: process.platform === 'win32' ? protectWindowsAcl : assertPosixModeSafe,
    assertAclSafe: process.platform === 'win32' ? assertWindowsAclSafe : assertPosixModeSafe,
    syncDirectory: fsyncDirectory,
  };
}

function assertPosixModeSafe(filePath: string): void {
  if ((fs.statSync(filePath).mode & 0o777) !== 0o600) failUnsafe();
}

function protectWindowsAcl(filePath: string): void {
  const script = [
    '$ErrorActionPreference="Stop"',
    `$acl=Get-Acl -LiteralPath ${powershellLiteral(filePath)}`,
    '$acl.SetAccessRuleProtection($true,$true)',
    `Set-Acl -LiteralPath ${powershellLiteral(filePath)} -AclObject $acl`,
  ].join(';');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    failUnsafe();
  }
}

function assertWindowsAclSafe(filePath: string): void {
  const script = [
    '$ErrorActionPreference="Stop"',
    `$acl=Get-Acl -LiteralPath ${powershellLiteral(filePath)}`,
    '$owner=(New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '$rows=@($acl.Access | ForEach-Object {',
    '  $sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '  [pscustomobject]@{sid=$sid;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString();inherited=$_.IsInherited}',
    '})',
    '[pscustomobject]@{protected=$acl.AreAccessRulesProtected;owner=$owner;rows=$rows}|ConvertTo-Json -Compress -Depth 4',
  ].join(';');

  let parsed: WindowsAclReport;
  try {
    parsed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })) as WindowsAclReport;
  } catch {
    failUnsafe();
  }

  const allowedSids = new Set([parsed!.owner, 'S-1-5-18']);
  if (!parsed!.protected || parsed!.rows.length !== allowedSids.size || allowedSids.size !== 2) failUnsafe();
  if (parsed!.rows.some((row) => (
    row.type !== 'Allow' ||
    row.inherited ||
    !allowedSids.has(row.sid) ||
    row.rights !== 'FullControl'
  ))) failUnsafe();
  if (new Set(parsed!.rows.map((row) => row.sid)).size !== allowedSids.size) failUnsafe();
}

interface WindowsAclReport {
  protected: boolean;
  owner: string;
  rows: Array<{ sid: string; type: string; rights: string; inherited: boolean }>;
}

function fsyncDirectory(directory: string): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(directory, 'r');
    fs.fsyncSync(handle);
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function failUnsafe(): never {
  throw new CredentialRefreshError('PRIVATE_DIR_UNSAFE', 'Private directory is unsafe');
}

function parseSingleTask(raw: string | undefined): { user_id: string } {
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') throw new Error();
    const userId = (parsed[0] as Record<string, unknown>).user_id;
    if (typeof userId !== 'string' || !/^\d+$/.test(userId)) throw new Error();
    return { user_id: userId };
  } catch {
    throw new CredentialRefreshError('TEMPLATE_INVALID', 'Template is invalid');
  }
}

function quoteConservative(value: string): string {
  if (/['"\\$\r\n\0]/.test(value)) {
    throw new CredentialRefreshError('TEMPLATE_INVALID', 'Credential value cannot be represented safely');
  }
  return `'${value}'`;
}

function requireOnlyCredentialAssignments(text: string, cookieKey: string, sessionKey: string): void {
  const assignments = text.match(/^(?:COOKIES|SESSIONID)_\d+=.*$/gm) ?? [];
  if (
    assignments.length !== 2 ||
    !assignments.some((line) => line.startsWith(`${cookieKey}=`)) ||
    !assignments.some((line) => line.startsWith(`${sessionKey}=`))
  ) {
    throw new CredentialRefreshError('TEMPLATE_INVALID', 'Template is invalid');
  }
}

function requireSingleAssignment(text: string, key: string): void {
  const matches = text.match(new RegExp(`^${escapeRegExp(key)}=.*$`, 'gm')) ?? [];
  if (matches.length !== 1) throw new CredentialRefreshError('TEMPLATE_INVALID', 'Template is invalid');
}

function replaceAssignment(text: string, key: string, encodedValue: string): string {
  return text.replace(new RegExp(`^${escapeRegExp(key)}=.*$`, 'm'), `${key}=${encodedValue}`);
}

export function assertNonCredentialTextUnchanged(template: string, candidate: string, cookieKey: string, sessionKey: string): void {
  if (redactCredentialAssignments(template, cookieKey, sessionKey)
    !== redactCredentialAssignments(candidate, cookieKey, sessionKey)) {
    throw new CredentialRefreshError('TEMPLATE_INVALID', 'Non-credential template text changed');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
