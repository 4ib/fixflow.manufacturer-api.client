// Browser side of the demo. It only calls the demo's own /api/* routes; the server holds the key.

const $ = (selector) => document.querySelector(selector);

const SAMPLE = {
  description: 'Unit shuts down after 10 minutes and reports error E-14.',
  warrantyReference: 'W-4471',
  'customer.name': 'Riverside Dental',
  'customer.reference': 'CUST-99812',
  'serviceLocation.addressLine1': '125 West State Street',
  'serviceLocation.city': 'Trenton',
  'serviceLocation.state': 'NJ',
  'serviceLocation.zip': '08608',
  'equipment.modelNumber': 'AC-200',
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

function fillSample(form) {
  for (const [name, value] of Object.entries(SAMPLE)) form.elements.namedItem(name).value = value;
  form.elements.namedItem('externalReference').value = newReference();
}

/** Turns the flat form into the nested CreateWorkOrderRequest body; empty optional fields are dropped. */
function toRequest(form) {
  const body = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    const value = element.type === 'checkbox' ? element.checked : element.value.trim();
    if (value === '') continue;
    const [head, tail] = element.name.split('.');
    if (tail) (body[head] ??= {})[tail] = value;
    else body[head] = value;
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatTime(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

async function api(path, init) {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, body };
}

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
        <td><strong>${escapeHtml(w.number)}</strong></td>
        <td>${escapeHtml(w.externalReference ?? '—')}</td>
        <td><span class="pill ${STATUS_TONE[w.status] ?? 'grey'}">${escapeHtml(w.status)}</span></td>
        <td>${escapeHtml(w.customer.name)}</td>
        <td>${escapeHtml(w.equipment?.modelNumber ?? '—')}${w.equipment?.serialNumber ? ` · ${escapeHtml(w.equipment.serialNumber)}` : ''}</td>
        <td>${formatTime(w.scheduledServiceAt)}</td>
        <td>${formatTime(changedAt)}</td>
      </tr>`)
    .join('');
}

function showCreateResult(form, { status, body }) {
  const box = $('#create-result');
  box.hidden = false;
  form.querySelectorAll('.field-error').forEach((el) => el.remove());

  if (status === 201 || status === 200) {
    const w = body.workOrder;
    box.className = 'result ok';
    box.innerHTML = body.replayed
      ? `<strong>200 · replayed.</strong> ${escapeHtml(w.number)} already exists for this reference — returned unchanged.`
      : `<strong>201 · created</strong> ${escapeHtml(w.number)} in status ${escapeHtml(w.status)}.`;
    return;
  }

  box.className = 'result error';
  box.innerHTML = `<strong>${status} · ${escapeHtml(body.title ?? 'Error')}</strong> ${escapeHtml(body.detail ?? '')}`;
  for (const [path, messages] of Object.entries(body.errors ?? {})) {
    const input = form.elements.namedItem(path);
    const hint = document.createElement('small');
    hint.className = 'field-error';
    hint.textContent = messages.join(' ');
    (input?.closest('label') ?? box).append(hint);
  }
}

function wireCreate() {
  const form = $('#create-form');
  fillSample(form);
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

function wireLookup() {
  $('#lookup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = event.target.elements.namedItem('query').value.trim();
    if (!query) return;
    const param = /^\d+$/.test(query) ? `id=${query}` : `reference=${encodeURIComponent(query)}`;
    const { status, body } = await api(`/api/lookup?${param}`);
    const out = $('#lookup-result');
    out.hidden = false;
    out.textContent = status === 200 ? JSON.stringify(body.workOrder, null, 2) : `${status}: ${body.detail ?? body.title}`;
  });
}

function wirePoll() {
  $('#poll-now').addEventListener('click', async () => {
    await api('/api/poll', { method: 'POST' });
    await Promise.all([refreshStatus(), refreshTracked()]);
  });
}

wireCreate();
wireLookup();
wirePoll();
await Promise.all([refreshStatus(), refreshTracked()]);
setInterval(() => void Promise.all([refreshStatus(), refreshTracked()]), 5000);
