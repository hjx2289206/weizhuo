import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const aiPython = process.env.AI_PYTHON || join(root, '.ai', 'venv', 'bin', 'python');
export const aiModelDir = process.env.AI_MODEL_DIR || join(root, '.ai', 'models');
