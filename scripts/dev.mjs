import { spawn } from 'node:child_process';
import 'dotenv/config';
const serverEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || 'development',
  HOST: process.env.HOST || '127.0.0.1',
  PUBLIC_SITE_PREVIEW: process.env.PUBLIC_SITE_PREVIEW ?? 'true',
};
const children = [
  spawn(process.execPath, ['--import', 'tsx', '--watch', 'server/index.ts'], { stdio: 'inherit', env: serverEnv }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
for (const child of children) child.on('exit', () => children.forEach(c => c.kill()));
process.on('SIGINT', () => children.forEach(c => c.kill()));
process.on('SIGTERM', () => children.forEach(c => c.kill()));
