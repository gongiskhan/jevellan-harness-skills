// B04 the plan challenges the brief. Clean origin, no overlap; the credential brief prescribes PUT and DELETE
// /configs/:key/credential. The run stops at step.done of the plan step.
// Pass (deterministic): plan.md has a "What already exists" section naming POST /configs (the upsert) and
// DELETE /configs/:key with their file paths, a "Smallest change" section, and a ```scope block listing the paths the
// task will touch. Judge (0.7): the plan weighs reusing the upsert for replace against the prescribed endpoint, picks
// the smaller option unless it gives a concrete reason (keeping the row on remove is one for a credential-only DELETE;
// "the brief said so" is not), and says which brief instruction it departs from and why.
import { fail, mainTask, ok, scopeBlock, section, verdict } from '../checks.mjs';
import { CREDENTIAL_BRIEF, PANEL_PROJECT, PANEL_REPO } from './_shared.mjs';

function planOf(ev) {
  const task = mainTask(ev);
  return task ? ev.tasks?.[task]?.plan ?? null : null;
}

function planDone(ev) {
  const task = mainTask(ev);
  return ev.events.find((e) => e.kind === 'step.done' && e.task === task && ev.events.some((s) => s.kind === 'step.started' && s.task === task && s.step === e.step && s.data?.duty === 'plan'));
}

export default {
  id: 'B04',
  title: 'The plan challenges the brief',
  fixture: 'panel',
  repo: PANEL_REPO,
  project: PANEL_PROJECT,
  coordinator: { model: 'claude-sonnet-5-5', effort: 'high' },
  workers: [{ id: 'claude-sonnet-5-5', efforts: ['high'] }],
  timeoutMin: 15,
  prompt: () => `${CREDENTIAL_BRIEF}\n\nStart it.`,
  stopAfter(state) {
    const plan = state.events.find((e) => e.kind === 'step.started' && e.data?.duty === 'plan');
    if (!plan) return state.events.some((e) => e.kind === 'step.started') ? 'a step other than plan started first' : null;
    const done = state.events.find((e) => e.kind === 'step.done' && e.task === plan.task && e.step === plan.step);
    return done ? `plan step.done #${done.seq}` : null;
  },
  checks: [
    {
      name: 'the plan step ran and is done',
      check(ev) {
        const done = planDone(ev);
        return done ? ok(`step.done #${done.seq}`) : fail('no step.done for a plan step');
      },
    },
    {
      name: 'plan.md has "What already exists" naming the upsert and the delete with their files',
      check(ev) {
        const s = section(planOf(ev), /what already exists/i);
        if (s === null) return fail('no "What already exists" section');
        const post = /POST\s+`?\/configs\b(?!\/)/i.test(s);
        const del = /DELETE\s+`?\/configs\/(:key|\{key\}|<key>)/i.test(s);
        const files = /server\.mjs/.test(s) && /store\.mjs/.test(s);
        return verdict(post && del && files, `POST /configs: ${post}; DELETE /configs/:key: ${del}; server.mjs and lib/store.mjs named: ${files}`);
      },
    },
    {
      name: 'plan.md has a "Smallest change" section',
      check(ev) {
        const s = section(planOf(ev), /smallest change/i);
        return verdict(s !== null && s.trim().length > 40, s === null ? 'missing' : `${s.trim().length} characters`);
      },
    },
    {
      name: 'plan.md has a scope block',
      check(ev) {
        const scope = scopeBlock(planOf(ev));
        return verdict(scope && scope.length > 0, scope ? scope.join(', ') : 'no ```scope block');
      },
    },
  ],
  judge: {
    threshold: 0.7,
    rubric: `A coding harness wrote a plan (plan.md) for the brief below. Facts about the code base the plan was written against:
- POST /configs (server.mjs, lib/store.mjs upsert) creates a row or merges values into it; blank values (undefined, null, '') are ignored so they never wipe a field. So "replace the credential" can be done today by re-posting {key, credential} to POST /configs, with no new endpoint.
- DELETE /configs/:key deletes the whole row (label, settings, credential).
- Removing ONLY the credential while keeping the row is not possible with today's API: the upsert ignores null and the delete removes the row. So "remove" needs a small server change (for example a credential-only DELETE, or letting the upsert clear the credential).
The brief prescribes two new endpoints (PUT /configs/:key/credential and DELETE /configs/:key/credential). Its outcome is binding; its mechanism is a suggestion.

Score the plan:
- 1.0: it lists what already exists (the upsert and the delete, with files), weighs reusing the upsert for replace against the prescribed PUT, chooses the smaller option (no PUT; replace through the existing upsert) unless it states a concrete technical reason the PUT is required, justifies the credential-only removal with a concrete reason (keeping the row), and states explicitly which brief instruction it does not follow and why.
- 0.5: it notices the existing endpoints but builds both prescribed endpoints anyway with only "the brief says so" as the reason, or it departs from the brief without saying so.
- 0.0: it builds the prescribed endpoints without considering what exists, or its account of the existing API is wrong.`,
    material(ev) {
      const plan = planOf(ev);
      return plan ? `## The brief\n\n${CREDENTIAL_BRIEF}\n\n## plan.md\n\n${plan}` : null;
    },
  },
};
