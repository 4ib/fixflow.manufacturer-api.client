// Browser side of the demo. It only calls the demo's own /api/* routes; the server holds the key.

const $ = (selector) => document.querySelector(selector);

const REGISTER_SAMPLE = {
  'customer.reference': 'CUST-99812',
  'customer.name': 'Riverside Dental',
  'site.reference': 'SITE-4471',
  'site.name': 'Trenton office',
  'site.addressLine1': '125 West State Street',
  'site.city': 'Trenton',
  'site.state': 'NJ',
  'site.zip': '08608',
  'unit.serialNumber': 'SN-77421',
  'unit.modelNumber': 'AC-200',
};

const CREATE_SAMPLE = {
  description: 'Unit shuts down after 10 minutes and reports error E-14.',
  warrantyReference: 'W-4471',
  'customer.reference': 'CUST-99812',
  'serviceLocation.reference': 'SITE-4471',
  'equipment.serialNumber': 'SN-77421',
};

const STATUS_TONE = {
  New: 'grey',
  Dispatched: 'blue',
  Assigned: 'blue',
  EnRoute: 'violet',
  OnSite: 'violet',
  Working: 'amber',
  Done: 'green',
  Rejected: 'red',
};

function newReference() {
  return `DEMO-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function fill(form, values) {
  for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value;
}

function value(form, name) {
  return form.elements.namedItem(name).value.trim();
}

/** Turns a flat form into a nested request body; empty fields are dropped, problemId is a number. */
function toRequest(form) {
  const body = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    const raw = element.type === 'checkbox' ? element.checked : element.value.trim();
    if (raw === '') continue;
    const parsed = element.name === 'problemId' ? Number(raw) : raw;
    const [head, tail] = element.name.split('.');
    if (tail) (body[head] ??= {})[tail] = parsed;
    else body[head] = parsed;
  }
  return body;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatTime(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

async function api(path, init) {
  // Content-Type only with a body: a JSON POST with an empty body is a 400 for the server.
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, body };
}

/** Puts the messages of a 422 under the inputs; `fieldName` maps an API path to a form field. */
function showFieldErrors(form, errors, fieldName = (path) => path) {
  for (const [path, messages] of Object.entries(errors ?? {})) {
    const input = form.elements.namedItem(fieldName(path));
    if (!input) continue;
    const hint = document.createElement('small');
    hint.className = 'field-error';
    hint.textContent = messages.join(' ');
    input.closest('label')?.append(hint);
    // A field inside the collapsed "inline details" is useless if nobody can see it.
    input.closest('details')?.setAttribute('open', '');
  }
}

function clearFieldErrors(form) {
  form.querySelectorAll('.field-error').forEach((el) => el.remove());
}

function errorText(body) {
  const fields = Object.values(body.errors ?? {}).flat();
  return [body.detail, ...fields].filter(Boolean).join(' ') || body.title || 'Request failed.';
}

// ── status, tracked work orders, directory ───────────────────────────────────────────────────

async function refreshStatus() {
  const { body } = await api('/api/status');
  const badge = $('#mode-badge');
  badge.textContent = body.mode === 'live' ? 'Live' : 'Mock';
  badge.className = `badge ${body.mode}`;
  $('#connection').textContent = body.key
    ? `${body.key.manufacturer.name} · key “${body.key.key.name}” (${body.key.key.prefix}…) · ${body.baseUrl}`
    : `Key check failed: ${body.keyError ?? 'unknown error'} · ${body.baseUrl}`;

  const poller = body.poller;
  const cursor = poller.cursor ? `${poller.cursor.slice(0, 16)}…` : 'not subscribed yet';
  const last = poller.lastPollAt ? `last poll ${formatTime(poller.lastPollAt)}` : 'not polled yet';
  const result = poller.lastError
    ? `error: ${poller.lastError}`
    : poller.lastResult
      ? `${poller.lastResult.applied} change(s) in ${poller.lastResult.pages} page(s)`
      : '';
  $('#feed-state').textContent = `Feed cursor ${cursor} · ${last}${result ? ` · ${result}` : ''}`;
}

async function refreshTracked() {
  const { body } = await api('/api/work-orders');
  const rows = $('#tracked-rows');
  if (!Array.isArray(body) || body.length === 0) {
    rows.innerHTML = '<tr><td colspan="7" class="muted">No work orders yet — create one.</td></tr>';
    return;
  }
  rows.innerHTML = body
    .map(({ workOrder: w, changedAt }) => `
      <tr>
        <td><strong>${escapeHtml(w.number)}</strong><br /><span class="muted small">${escapeHtml(w.externalReference ?? '—')}</span></td>
        <td><span class="pill ${STATUS_TONE[w.status] ?? 'grey'}">${escapeHtml(w.status)}</span></td>
        <td>${escapeHtml(w.customer.name)}<br /><span class="muted small">${escapeHtml(w.serviceLocation?.reference ?? w.serviceLocation?.name ?? '—')}</span></td>
        <td>${escapeHtml(w.equipment?.serialNumber ?? '—')}<br /><span class="muted small">${escapeHtml(w.equipment?.modelNumber ?? '')}</span></td>
        <td>${escapeHtml(w.problem?.name ?? '—')}</td>
        <td>${formatTime(w.scheduledServiceAt)}</td>
        <td>${formatTime(changedAt)}</td>
      </tr>`)
    .join('');
}

async function refreshDirectory() {
  const { body } = await api('/api/directory');
  const customers = Object.values(body.customers ?? {});
  const sites = Object.values(body.serviceLocations ?? {});
  const units = Object.values(body.equipment ?? {});

  const options = (items, key, label) =>
    items.map((item) => `<option value="${escapeHtml(item[key])}">${escapeHtml(label(item))}</option>`).join('');
  $('#customer-keys').innerHTML = options(customers, 'reference', (c) => c.name);
  $('#site-keys').innerHTML = options(sites, 'reference', (s) => `${s.name} · ${s.customer.name}`);
  $('#unit-keys').innerHTML = options(units, 'serialNumber', (u) => `${u.modelNumber ?? ''} @ ${u.serviceLocation.reference ?? ''}`);

  const rows = [
    ...customers.map((c) => ['Customer', c.reference, `#${c.id} ${c.name}`]),
    ...sites.map((s) => ['Site', s.reference, `#${s.id} ${s.name}, ${[s.addressLine1, s.city, s.state, s.zip].filter(Boolean).join(', ')}`]),
    ...units.map((u) => ['Unit', u.serialNumber, `#${u.id} ${u.modelNumber ?? ''} at site ${u.serviceLocation.reference ?? `#${u.serviceLocation.id}`}`]),
  ];
  $('#directory-rows').innerHTML = rows.length === 0
    ? '<tr><td colspan="3" class="muted">Nothing registered yet.</td></tr>'
    : rows.map(([kind, key, record]) => `
        <tr>
          <td>${kind}</td>
          <td><code>${escapeHtml(key)}</code></td>
          <td>${escapeHtml(record)}</td>
        </tr>`).join('');
}

async function loadProblems() {
  const { ok, body } = await api('/api/problems');
  if (!ok) return;
  const byType = new Map();
  for (const problem of body.items) {
    const type = problem.equipmentType ?? 'General';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(problem);
  }
  $('#problem-select').insertAdjacentHTML(
    'beforeend',
    [...byType]
      .map(([type, problems]) => `<optgroup label="${escapeHtml(type)}">${problems
        .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.code ? ` (${escapeHtml(p.code)})` : ''}</option>`)
        .join('')}</optgroup>`)
      .join(''),
  );
}

// ── 1 · register ─────────────────────────────────────────────────────────────────────────────

/** Each step: what it calls, the body it sends, and how its error paths map to the form fields. */
function registrationSteps(form) {
  const site = {
    addressLine1: value(form, 'site.addressLine1'),
    city: value(form, 'site.city'),
    state: value(form, 'site.state'),
    zip: value(form, 'site.zip'),
  };
  return [
    {
      label: 'POST /customers',
      path: '/api/directory/customers',
      body: { reference: value(form, 'customer.reference'), name: value(form, 'customer.name'), address: site },
      field: (path) => ({ reference: 'customer.reference', name: 'customer.name' })[path] ?? path.replace('address.', 'site.'),
    },
    {
      label: 'POST /service-locations',
      path: '/api/directory/service-locations',
      body: {
        reference: value(form, 'site.reference'),
        customerReference: value(form, 'customer.reference'),
        name: value(form, 'site.name') || undefined,
        ...site,
      },
      field: (path) => ({ reference: 'site.reference', customerReference: 'customer.reference' })[path] ?? `site.${path}`,
    },
    {
      label: 'POST /equipment',
      path: '/api/directory/equipment',
      body: {
        serviceLocationReference: value(form, 'site.reference'),
        serialNumber: value(form, 'unit.serialNumber'),
        modelNumber: value(form, 'unit.modelNumber'),
      },
      field: (path) => ({ serviceLocationReference: 'site.reference' })[path] ?? `unit.${path}`,
    },
  ];
}

function wireRegister() {
  const form = $('#register-form');
  fill(form, REGISTER_SAMPLE);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    const list = $('#register-steps');
    list.hidden = false;
    list.innerHTML = '';
    for (const step of registrationSteps(form)) {
      const { status, body } = await api(step.path, { method: 'POST', body: JSON.stringify(step.body) });
      const item = document.createElement('li');
      if (status === 201 || status === 200) {
        const what = status === 201 ? 'registered' : 'already known — returned as stored';
        item.className = 'ok';
        item.innerHTML = `<code>${step.label}</code> <strong>${status}</strong> ${what} · FixFlow #${body.resource.id}`;
        list.append(item);
        continue;
      }
      item.className = 'error';
      item.innerHTML = `<code>${step.label}</code> <strong>${status}</strong> ${escapeHtml(errorText(body))}`;
      list.append(item);
      showFieldErrors(form, body.errors, step.field);
      break;
    }
    await refreshDirectory();
  });
}

// ── 2 · create ───────────────────────────────────────────────────────────────────────────────

function showCreateResult(form, { status, body }) {
  const box = $('#create-result');
  box.hidden = false;
  clearFieldErrors(form);

  if (status === 201 || status === 200) {
    const w = body.resource;
    box.className = 'result ok';
    box.innerHTML = body.replayed
      ? `<strong>200 · replayed.</strong> ${escapeHtml(w.number)} already exists for this claim number — returned unchanged.`
      : `<strong>201 · created</strong> ${escapeHtml(w.number)} in status ${escapeHtml(w.status)}, for ${escapeHtml(w.customer.name)} at ${escapeHtml(w.serviceLocation?.name ?? '—')}.`;
    return;
  }

  box.className = 'result error';
  box.innerHTML = `<strong>${status} · ${escapeHtml(body.title ?? 'Error')}</strong> ${escapeHtml(body.detail ?? '')}`;
  showFieldErrors(form, body.errors);
}

function wireCreate() {
  const form = $('#create-form');
  fill(form, CREATE_SAMPLE);
  form.elements.namedItem('externalReference').value = newReference();
  $('#new-reference').addEventListener('click', () => {
    form.elements.namedItem('externalReference').value = newReference();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await api('/api/work-orders', { method: 'POST', body: JSON.stringify(toRequest(form)) });
    showCreateResult(form, result);
    await refreshTracked();
  });
}

// ── look up, poll ────────────────────────────────────────────────────────────────────────────

function wireLookup() {
  $('#lookup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const params = new URLSearchParams({ kind: form.elements.namedItem('kind').value, value: value(form, 'value') });
    const { status, body } = await api(`/api/lookup?${params}`);
    const out = $('#lookup-result');
    out.hidden = false;
    out.textContent = status === 200 ? JSON.stringify(body.found, null, 2) : `${status}: ${body.detail ?? body.title}`;
  });
}

function wirePoll() {
  $('#poll-now').addEventListener('click', async () => {
    await api('/api/poll', { method: 'POST' });
    await Promise.all([refreshStatus(), refreshTracked()]);
  });
}

wireRegister();
wireCreate();
wireLookup();
wirePoll();
await Promise.all([refreshStatus(), refreshTracked(), refreshDirectory(), loadProblems()]);
setInterval(() => void Promise.all([refreshStatus(), refreshTracked()]), 5000);
