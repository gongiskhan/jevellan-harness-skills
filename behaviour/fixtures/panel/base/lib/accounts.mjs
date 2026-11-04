// The inbox accounts: each one reads its messages through an integration.
import fs from 'node:fs';
import path from 'node:path';

const SEED = [
  { id: 'slack-geral', label: 'Slack #geral', integration: 'slack' },
  { id: 'email-escritorio', label: 'Email do escritório', integration: 'imap' },
];

export function readAccounts(file = process.env.ACCOUNTS_STORE || path.join(process.cwd(), 'data', 'accounts.json')) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(SEED);
  }
}
