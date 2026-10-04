const $ = (id) => document.getElementById(id);
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

const ERRORS = {
  not_connected: 'Twitch session expired, please reconnect.',
  auth_failed: 'Connection refused. Check the Client ID and the redirect URL.',
  twitch_429: 'Too many requests to Twitch, try again in a moment.',
};

// Version of the state format expected from the service worker (`api` field of its reply).
const STATE_API = 2;

let current = null;
let tab = 'all';

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
}

async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) throw new Error(res?.error || 'unknown_error');
  return res.data;
}

function showError(e) {
  const code = e ? e.message || String(e) : '';
  $('error').hidden = !code;
  $('error').textContent = ERRORS[code] || (code ? `Error: ${code}` : '');
}

function row(f, s) {
  const stream = s.live[f.id];
  const open = s.managed.includes(f.id);

  const avatar = f.avatar
    ? el('img', { src: f.avatar, alt: '', loading: 'lazy' })
    : el('div', { className: 'ph', textContent: f.name[0].toUpperCase() });

  const box = el('input', { type: 'checkbox', checked: !!s.selected[f.id] });
  box.setAttribute('aria-label', `Auto-open ${f.name}`);
  box.addEventListener('change', async () => {
    if (box.checked) s.selected[f.id] = true;
    else delete s.selected[f.id];
    renderStats(s);
    try {
      s.managed = await send('select', { id: f.id, checked: box.checked });
      chrome.storage.local.set({ cache: s });
      render(s);
    } catch (e) {
      showError(e);
    }
  });

  return el(
    'div',
    { className: stream ? 'row live' : 'row' },
    el('div', { className: 'avatar' }, avatar),
    el(
      'div',
      { className: 'info' },
      el(
        'div',
        { className: 'name' },
        el('span', { textContent: f.name }),
        open && el('em', { className: 'badge open', textContent: 'Open' })
      ),
      el('div', { className: 'sub', textContent: stream ? stream.game || stream.title || 'Live' : 'Offline', title: stream?.title || '' })
    ),
    stream && el('div', { className: 'viewers' }, el('i'), compact.format(stream.viewers)),
    el('label', { className: 'switch' }, box, el('span'))
  );
}

function renderStats(s) {
  $('sLive').textContent = Object.keys(s.live).length;
  $('sAuto').textContent = Object.keys(s.selected).length;
  $('sOpen').textContent = s.managed.length;
}

function renderList(s) {
  const q = $('filter').value.trim().toLowerCase();
  const rows = s.follows
    .filter((f) => f.name.toLowerCase().includes(q) || f.login.includes(q))
    .filter((f) => tab === 'all' || (tab === 'live' ? s.live[f.id] : s.selected[f.id]))
    .sort(
      (a, b) =>
        !!s.live[b.id] - !!s.live[a.id] ||
        (s.live[b.id]?.viewers || 0) - (s.live[a.id]?.viewers || 0) ||
        a.name.localeCompare(b.name)
    );

  if (rows.length) return $('list').replaceChildren(...rows.map((f) => row(f, s)));

  const empty = q
    ? ['No results', 'No followed channel matches your search.']
    : tab === 'live'
      ? ['Nobody is live', 'None of your followed channels is streaming right now.']
      : tab === 'auto'
        ? ['No channel enabled', 'Turn on a channel’s switch to open its streams automatically.']
        : ['No follows', 'Your Twitch account does not follow any channel yet.'];
  $('list').replaceChildren(el('div', { className: 'empty' }, el('b', { textContent: empty[0] }), empty[1]));
}

function render(s) {
  current = s;
  $('setup').hidden = s.connected;
  $('main').hidden = !s.connected;
  $('refresh').hidden = $('disconnect').hidden = !s.connected;
  $('who').textContent = s.connected ? `Connected · ${s.login}` : 'Setup';
  $('redirect').textContent = $('redirect').title = s.redirect || '';
  if (!s.connected || !s.follows) return;
  renderStats(s);
  renderList(s);
}

async function refresh() {
  $('refresh').classList.add('spinning');
  try {
    const s = await send('state');
    // The service worker is still running an older version of the code: reload the extension.
    if (s.api !== STATE_API) return chrome.runtime.reload();
    showError(s.error);
    if (s.follows) chrome.storage.local.set({ cache: s });
    // On a network error, keep the last known list on screen.
    render(s.follows || !current ? s : { ...current, connected: s.connected });
  } catch (e) {
    showError(e);
  } finally {
    $('refresh').classList.remove('spinning');
  }
}

$('filter').addEventListener('input', () => current?.follows && renderList(current));
$('refresh').addEventListener('click', refresh);

for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => {
    tab = btn.dataset.tab;
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', b === btn);
    if (current?.follows) renderList(current);
  });
}

$('openConsole').addEventListener('click', () => chrome.tabs.create({ url: 'https://dev.twitch.tv/console/apps/create' }));

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('redirect').textContent);
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy'), 1500);
});

$('connect').addEventListener('click', async () => {
  const clientId = $('clientId').value.trim();
  if (!clientId) return $('clientId').focus();
  $('connect').disabled = true;
  $('connect').textContent = 'Connecting…';
  try {
    showError();
    await send('connect', { clientId });
    await refresh();
  } catch (e) {
    showError(e);
  } finally {
    $('connect').disabled = false;
    $('connect').textContent = 'Connect to Twitch';
  }
});

$('disconnect').addEventListener('click', async () => {
  await send('disconnect').catch(showError);
  current = null;
  await refresh();
});

// Show the last known state right away, then refresh it.
chrome.storage.local.get(['cache', 'clientId', 'token']).then(({ cache, clientId, token }) => {
  if (clientId) $('clientId').value = clientId;
  if (cache?.api === STATE_API && token) render(cache);
  else if (token) {
    $('main').hidden = false;
    $('list').replaceChildren(...Array.from({ length: 6 }, () => el('div', { className: 'skeleton' })));
  }
  refresh();
});
