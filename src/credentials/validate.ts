import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  countAssignments,
  createDefaultSecurityAdapter,
  hasParseableAssignments,
  parseCookieHeader,
  parseEnv,
  parseSingleTemplateAccount,
  redactCredentialAssignments,
} from './env-file.js';
import { toSafeError } from './errors.js';
import { OUTPUT_PATH, TEMPLATE_PATH } from './paths.js';

export const STABLE_CHECK_NAMES = [
  'regularFile',
  'privatePermissions',
  'gitIgnored',
  'templateParses',
  'candidateParses',
  'accountMatches',
  'credentialAssignmentsUnique',
  'requiredCookiesPresent',
  'sessionMatchesCookie',
  'nonCredentialTextUnchanged',
] as const;

export type ValidationCheckName = typeof STABLE_CHECK_NAMES[number];
export type ValidationReport = Record<ValidationCheckName, boolean>;

export interface CandidateTextValidationInput {
  file: Pick<ValidationReport, 'regularFile' | 'privatePermissions' | 'gitIgnored'>;
  template: string;
  candidate: string;
}

interface ValidationDependencies {
  validate(): ValidationReport | Partial<ValidationReport>;
  writeOut(line: string): void;
  writeErr(line: string): void;
}

export async function runCandidateValidation(overrides: Partial<ValidationDependencies> = {}): Promise<number> {
  const dependencies: ValidationDependencies = {
    validate: validateDefaultCandidate,
    writeOut: (line) => process.stdout.write(`${line}\n`),
    writeErr: (line) => process.stderr.write(`${line}\n`),
    ...overrides,
  };

  try {
    const report = dependencies.validate();
    for (const name of STABLE_CHECK_NAMES) {
      if (Object.hasOwn(report, name)) {
        dependencies.writeOut(`${name}: ${report[name] === true ? 'PASS' : 'FAIL'}`);
      }
    }
    return STABLE_CHECK_NAMES.every((name) => report[name] === true) ? 0 : 1;
  } catch (error) {
    const safe = toSafeError(error);
    dependencies.writeErr(`${safe.code}: ${safe.message}`);
    return 1;
  }
}

export function validateCandidateText(input: CandidateTextValidationInput): ValidationReport {
  const templateAccount = parseSingleTemplateAccount(input.template);
  const candidateAccount = parseSingleTemplateAccount(input.candidate);
  const templateParses = templateAccount !== null && hasParseableAssignments(input.template);
  const candidateParses = candidateAccount !== null && hasParseableAssignments(input.candidate);
  const accountMatches = templateParses && candidateParses && candidateAccount!.userId === templateAccount!.userId;
  const userId = accountMatches ? templateAccount!.userId : '';
  const cookieKey = `COOKIES_${userId}`;
  const sessionKey = `SESSIONID_${userId}`;
  const candidateEnv = candidateParses ? parseEnv(input.candidate) : {};
  const cookies = parseCookieHeader(accountMatches ? candidateEnv[cookieKey] ?? '' : '');
  const credentialAssignmentsUnique = accountMatches
    && countAssignments(input.candidate, cookieKey) === 1
    && countAssignments(input.candidate, sessionKey) === 1;
  const requiredNames = ['sessionid', 'ms_token', 's_v_web_id', 'UIFID'];
  const requiredCookiesPresent = accountMatches
    && !cookies.malformed
    && cookies.duplicateNames.size === 0
    && requiredNames.every((name) => Boolean(cookies.values[name]));
  const sessionMatchesCookie = requiredCookiesPresent
    && cookies.values.sessionid === candidateEnv[sessionKey];

  return {
    ...input.file,
    templateParses,
    candidateParses,
    accountMatches,
    credentialAssignmentsUnique,
    requiredCookiesPresent,
    sessionMatchesCookie,
    nonCredentialTextUnchanged: accountMatches
      && redactCredentialAssignments(input.template, cookieKey, sessionKey)
        === redactCredentialAssignments(input.candidate, cookieKey, sessionKey),
  };
}

function validateDefaultCandidate(): ValidationReport {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const candidate = fs.readFileSync(OUTPUT_PATH, 'utf8');
  return validateCandidateText({
    file: inspectDefaultCandidateFile(),
    template,
    candidate,
  });
}

function inspectDefaultCandidateFile(): Pick<ValidationReport, 'regularFile' | 'privatePermissions' | 'gitIgnored'> {
  const stat = fs.lstatSync(OUTPUT_PATH);
  let privatePermissions = true;
  try {
    createDefaultSecurityAdapter().assertAclSafe(OUTPUT_PATH);
  } catch {
    privatePermissions = false;
  }
  let gitIgnored = true;
  try {
    execFileSync('git', ['check-ignore', '--quiet', OUTPUT_PATH], { stdio: 'ignore', windowsHide: true });
  } catch {
    gitIgnored = false;
  }
  return {
    regularFile: stat.isFile() && !stat.isSymbolicLink(),
    privatePermissions,
    gitIgnored,
  };
}

function isDirectRun(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) process.exitCode = await runCandidateValidation();
