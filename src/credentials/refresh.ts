import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readBrowserCredentialSource, type BrowserCredentialSource } from './browser-source.js';
import {
  createDefaultSecurityAdapter,
  installCandidateEnv,
  preflightPrivatePaths,
  renderCandidateEnv,
  validateCandidateSemantics,
  type PrivatePaths,
} from './env-file.js';
import { CredentialRefreshError, toSafeError } from './errors.js';
import { normalizeCredentials, type NormalizedCredentials } from './normalize.js';
import { OUTPUT_DISPLAY, OUTPUT_PATH, PRIVATE_DIR, TEMPLATE_PATH } from './paths.js';

const USAGE = 'Usage: credentials:refresh -- --cdp-url http://127.0.0.1:<port>';

export interface RefreshDependencies {
  preflight(): void;
  readSource(cdpUrl: string): Promise<BrowserCredentialSource>;
  normalize(input: Parameters<typeof normalizeCredentials>[0]): NormalizedCredentials;
  readTemplate(): string;
  render(template: string, credentials: NormalizedCredentials): string;
  validate(template: string, candidate: string, credentials: NormalizedCredentials): void;
  install(template: string, credentials: NormalizedCredentials, candidate: string): void;
  nowSeconds(): number;
  writeOut(line: string): void;
  writeErr(line: string): void;
}

export async function runCredentialRefresh(
  argv: string[],
  overrides: Partial<RefreshDependencies> = {},
): Promise<number> {
  let dependencies: RefreshDependencies | undefined;
  try {
    const cdpUrl = parseArgs(argv);
    dependencies = { ...createDefaultRefreshDependencies(), ...overrides };
    dependencies.preflight();
    dependencies.writeOut('Preflight passed');

    const source = await dependencies.readSource(cdpUrl);
    dependencies.writeOut('Browser context selected');

    const credentials = dependencies.normalize({
      account: source.account,
      cookies: source.cookies,
      nowSeconds: dependencies.nowSeconds(),
    });
    dependencies.writeOut('Credential fields validated: 5/5');

    const template = dependencies.readTemplate();
    const candidate = dependencies.render(template, credentials);
    dependencies.validate(template, candidate, credentials);
    dependencies.install(template, credentials, candidate);
    dependencies.writeOut(`Candidate file created: ${OUTPUT_DISPLAY}`);
    return 0;
  } catch (error) {
    const safe = error instanceof CredentialRefreshError ? error : toSafeError(error);
    const writeErr = dependencies?.writeErr ?? overrides.writeErr ?? ((line: string) => process.stderr.write(`${line}\n`));
    writeErr(`${safe.code}: ${safe.message}`);
    return 1;
  }
}

function createDefaultRefreshDependencies(): RefreshDependencies {
  const paths: PrivatePaths = {
    dir: PRIVATE_DIR,
    templatePath: TEMPLATE_PATH,
    outputPath: OUTPUT_PATH,
  };
  const security = createDefaultSecurityAdapter();
  return {
    preflight: () => preflightPrivatePaths(paths, security),
    readSource: readBrowserCredentialSource,
    normalize: normalizeCredentials,
    readTemplate: () => fs.readFileSync(TEMPLATE_PATH, 'utf8'),
    render: renderCandidateEnv,
    validate: (template, candidate, credentials) => {
      validateCandidateSemantics(template, candidate, credentials);
    },
    install: (template, credentials, candidate) => installCandidateEnv(paths, candidate, {
      ...security,
      validateWrittenText: (written) => {
        validateCandidateSemantics(template, written, credentials);
      },
    }),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    writeOut: (line) => process.stdout.write(`${line}\n`),
    writeErr: (line) => process.stderr.write(`${line}\n`),
  };
}

function parseArgs(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--cdp-url' || !argv[1]) {
    throw new CredentialRefreshError('INVALID_ARGUMENT', USAGE);
  }
  return argv[1];
}

function isDirectRun(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  process.exitCode = await runCredentialRefresh(process.argv.slice(2));
}
