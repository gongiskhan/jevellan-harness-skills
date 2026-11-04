// What the panel cases share: the briefs (written the way the manager writes them for ekoa-code), the project
// settings, the pull requests of other people, and the stop rules. Not a case (the runner skips files starting
// with _).

import { prPattern } from '../checks.mjs';

// B01-B04: the credential feature, the shape of ekoa-code's T7E8XHB but small. It prescribes new endpoints on purpose
// (B04 checks whether the plan challenges that).
export const CREDENTIAL_BRIEF = `# Replace and remove a stored credential; the accounts page links to the integration's config

## Why

The owner, today: "there is no way to remove a credential and replace it! also the accounts page should link to the
integration's configuration instead of having its own connect form". In the integrations panel a stored credential
can only be seen (Ver) or the whole integration switched off (Desativar). When a token expires the only way out is to
edit the JSON store by hand. The accounts page (web/accounts.html) has its own «Ligar» form per account that saves a
credential from there, so there are two places that own the same connection.

## What to build

1. In the integrations panel (web/panel.html, web/panel.mjs), each integration with a stored credential gets two
   actions:
   - «Substituir credencial»: the owner enters a new credential and it replaces the old one;
   - «Remover credencial»: the credential is dropped, while the integration's row, its label and its settings stay
     (the panel then shows "sem credencial").
2. Add two endpoints to server.mjs for these actions: PUT /configs/:key/credential (body {credential}) and
   DELETE /configs/:key/credential.
3. The accounts page stops owning the connection: its «Ligar» form goes away and each account gets a link
   «Configurar integração» to its integration's panel (panel.html#config-<key>).

## Constraints

- UI copy in pt-PT, never the em dash (AGENTS.md).
- The credential is never shown in full: masked as ••••<last 4>, as today.
- Do not change what GET /configs returns.

## How the owner sees it

Open the panel: an integration with a stored credential shows «Substituir credencial» and «Remover credencial».
After removing, the row stays with "sem credencial" and its settings. On the accounts page each account has
«Configurar integração», which opens the panel at that integration.

## Tests

API tests for replace and remove, panel tests for the two actions and the masked credential, an accounts test for
the link. Check both pages at 390 and 1440 wide.`;

// B05, B06, B09: a small change to one screen.
export const REPLACE_BUTTON_BRIEF = `# A «Substituir» button on each integration panel

## Why

The owner wants to put a new credential over an old one without hunting for the «Nova integração» form and retyping
the integration's key.

## What to build

In the integrations panel (web/panel.mjs), each integration that has a stored credential gets a button «Substituir»
next to «Ver» and «Desativar». It opens the existing form (the dialog in web/panel.html) with that integration's key
and name already filled in; saving it stores the new credential through the existing POST /configs.

## Constraints

UI copy in pt-PT, never the em dash. Do not change the API.

## How the owner sees it

The panel at 390 and 1440 wide: «Substituir» on the Slack panel (which has a credential), not on the email panel
(which has none); clicking it opens the form with "slack" and "Slack" filled in.

## Tests

A panel test for the button (shown only with a credential).`;

export const PANEL_REPO = 'acme/cred-panel';

export const PANEL_PROJECT = {
  name: 'cred-panel',
  defaultBranch: 'main',
  landing: 'pr',
  testCommand: 'npm test',
  devCommand: 'npm run dev',
  setupCommand: undefined,
  checks: ['npm test'],
  riskyPaths: [],
  pushAfterLanding: false,
  retentionDays: 3,
};

// The pull request #7 of the overlap cases: the feature, merged by the owner from a cloud session, web only. Its
// «Remover credencial» deletes the whole row (DELETE /configs/:key), which is more than the brief asks.
export function mergedPr7({ mergeCommit, mergedAt, createdAt }) {
  return {
    number: 7,
    title: 'Credentials can be replaced and removed from the panel',
    body: 'Each integration with a stored credential gets «Substituir credencial» (the form again; saving re-posts to POST /configs, which merges into the row) and «Remover credencial» (DELETE /configs/:key). The accounts page loses its «Ligar» form and links to the integration in the panel.\n\nTests: panel and accounts tests updated. No browser check.',
    state: 'MERGED',
    headRefName: 'feat/credential-actions',
    baseRefName: 'main',
    headRefOid: mergeCommit,
    mergeCommit: { oid: mergeCommit },
    mergedAt,
    createdAt,
    updatedAt: mergedAt,
    author: { login: 'owner' },
    files: [
      { path: 'web/panel.mjs', additions: 14, deletions: 0 },
      { path: 'web/accounts.mjs', additions: 3, deletions: 12 },
      { path: 'tests/panel.test.mjs', additions: 6, deletions: 0 },
      { path: 'tests/accounts.test.mjs', additions: 4, deletions: 4 },
    ],
  };
}

export const PR7_MESSAGE = 'Credentials can be replaced and removed from the panel (#7)';

// #7 squash-merged on origin's main, and listed by the fake gh as merged `minutesAgo` ago.
export function landPr7(run, h, { minutesAgo = 30 } = {}) {
  const sha = h.seedCommit(run, { fixture: 'panel', overlay: 'pr7', message: PR7_MESSAGE });
  h.seedPush(run, 'main');
  const mergedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const createdAt = new Date(Date.now() - (minutesAgo + 40) * 60_000).toISOString();
  h.updateGhState(run, (s) => ({ ...s, prs: [...s.prs.filter((p) => p.number !== 7), mergedPr7({ mergeCommit: sha, mergedAt, createdAt })] }));
  run.facts.pr7 = { number: 7, commit: sha, mergedAt };
  return sha;
}

export const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

// ---- stop rules ---------------------------------------------------------------------------------------------------------

export const firstOf = (kinds) => (state) => {
  const e = state.events.find((x) => kinds.includes(x.kind));
  return e ? `${e.kind} #${e.seq}` : null;
};

export function implementStarted(state) {
  const e = state.events.find((x) => x.kind === 'step.started' && x.data?.duty === 'implement');
  return e ? `implement step started (#${e.seq})` : null;
}

export function anyOwnerQuestion(state) {
  const asked = state.events.find((x) => x.kind === 'task.asked');
  if (asked) return `task.asked #${asked.seq}`;
  return null;
}

// Owner-facing text that names pull request n, for the checks: the chat and the run's recorded lines.
export function namesPr(ev, n) {
  return prPattern(n);
}

// The coordinator's messages and the run's owner questions, for a judge.
export function ownerFacing(ev) {
  const questions = ev.events.filter((e) => e.kind === 'task.asked').map((e) => `task.asked #${e.seq}: ${e.data?.question ?? ''}\n  options: ${JSON.stringify(e.data?.options ?? [])}\n  reason: ${e.data?.reason ?? ''}`);
  const chat = (ev.coordinator?.texts ?? []).map((t, i) => `[coordinator message ${i + 1}]\n${t.text}`);
  return [`## Questions recorded for the owner\n\n${questions.join('\n\n') || '(none)'}`, `## What the coordinator said to the owner, in order\n\n${chat.join('\n\n') || '(nothing)'}`].join('\n\n');
}

export function stepsSummary(ev) {
  const lines = [];
  for (const e of ev.events) {
    if (e.kind === 'task.created') lines.push(`#${e.seq} task.created ${e.task} (${e.data?.kind}): ${e.data?.title}`);
    if (e.kind === 'step.started') lines.push(`#${e.seq} step ${e.step} started: ${e.data?.duty} on ${e.data?.model} ${e.data?.effort}`);
    if (e.kind === 'step.report') lines.push(`#${e.seq} step ${e.step} report ${e.data?.status}: ${String(e.data?.summary ?? '').slice(0, 1500)}${e.data?.question ? `\n  question: ${e.data.question}` : ''}`);
    if (e.kind === 'note') lines.push(`#${e.seq} note: ${JSON.stringify(e.data).slice(0, 1500)}`);
    if (['landing.decided', 'task.landed', 'task.asked'].includes(e.kind)) lines.push(`#${e.seq} ${e.kind}: ${JSON.stringify(e.data).slice(0, 800)}`);
  }
  return lines.join('\n') || '(no ledger lines)';
}
