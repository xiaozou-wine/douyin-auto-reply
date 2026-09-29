import path from 'node:path';
import { resolveFromRoot } from '../utils/paths.js';

export const PRIVATE_DIR = resolveFromRoot('vps-production-backup-20260717-private/payload/douyin-spark');
export const TEMPLATE_PATH = path.join(PRIVATE_DIR, '.env');
export const OUTPUT_PATH = path.join(PRIVATE_DIR, '.env.next');
export const OUTPUT_DISPLAY = 'vps-production-backup-20260717-private/payload/douyin-spark/.env.next';
