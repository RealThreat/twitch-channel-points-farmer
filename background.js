const API = 'https://api.twitch.tv/helix';
const local = chrome.storage.local;
const session = chrome.storage.session;

// Serializes access to the state (poll + tab closing) to avoid concurrent writes.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(() => fn(), () => fn()));

async function request(path, qs) {
  const { clientId, token } = await local.get(['clientId', 'token']);
  if (!token) throw new Error('not_connected');
  const res = await fetch(`${API}/${path}?${qs}`, {
    headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    await local.remove('token');
    throw new Error('not_connected');
  }
  if (!res.ok) throw new Error(`twitch_${res.status}`);
  return res.json();
}

async function api(path, params) {
  const out = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ ...params, first: '100' });
    if (cursor) qs.set('after', cursor);
    const json = await request(path, qs);
    out.push(...json.data);
    cursor = json.pagination?.cursor;
  } while (cursor);
  return out;
}

// Avatars almost never change: only the ones we don't have yet are requested.
async function loadAvatars(ids) {
  const { avatars = {} } = await local.get('avatars');
  const missing = ids.filter((id) => !avatars[id]);
  for (let i = 0; i < missing.length; i += 100) {
    const qs = new URLSearchParams(missing.slice(i, i + 100).map((id) => ['id', id]));
    const json = await request('users', qs);
    for (const u of json.data) avatars[u.id] = u.profile_image_url.replace('300x300', '70x70');
  }
  if (missing.length) await local.set({ avatars });
  return avatars;
}

async function connect(clientId) {
  const url =
    'https://id.twitch.tv/oauth2/authorize' +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(chrome.identity.getRedirectURL())}` +
    '&response_type=token&scope=user%3Aread%3Afollows';
  const result = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const token = new URLSearchParams(new URL(result).hash.slice(1)).get('access_token');
  if (!token) throw new Error('auth_failed');
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!res.ok) throw new Error('auth_failed');
  const { user_id, login } = await res.json();
  await local.set({ clientId, token, userId: user_id, login });
}

// Streams open in a dedicated window as the active tab: Chrome defers playback in tabs
// that have never been shown, which would prevent earning points.
async function openStream(login, focus) {
  const url = `https://www.twitch.tv/${login}?taw=1`;
  const { windowId } = await session.get('windowId');
  const win = windowId ? await chrome.windows.get(windowId).catch(() => null) : null;
  let tab;
  if (win) {
    tab = await chrome.tabs.create({ windowId, url, active: true });
    if (focus) await chrome.windows.update(windowId, { focused: true });
  } else {
    const created = await chrome.windows.create({ url, focused: focus, width: 1100, height: 700 });
    await session.set({ windowId: created.id });
    tab = created.tabs[0];
  }
  await chrome.tabs.update(tab.id, { muted: true, autoDiscardable: false });
  return tab.id;
}

// Opens every enabled stream that is live, whether it just started or was already running.
// focus: the streams window comes to the front (opening requested from the popup);
// during automatic scans it opens in the background so the user is not interrupted.
async function poll(focus = false) {
  const { userId, selected = {} } = await local.get(['userId', 'selected']);
  if (!userId) return;
  let live;
  try {
    live = await api('streams/followed', { user_id: userId });
  } catch (e) {
    chrome.action.setBadgeText({ text: '!' });
    return;
  }
  const liveIds = new Set(live.map((s) => s.user_id));
  const { managed = {}, dismissed = {} } = await session.get(['managed', 'dismissed']);

  // A tracked tab that no longer exists (closed while the extension was asleep) is forgotten.
  for (const [id, tabId] of Object.entries(managed)) {
    if (!(await chrome.tabs.get(tabId).catch(() => null))) delete managed[id];
  }

  // A tab closed by hand is not reopened until that stream has ended.
  for (const id of Object.keys(dismissed)) if (!liveIds.has(id)) delete dismissed[id];

  const toClose = [];
  for (const [id, tabId] of Object.entries(managed)) {
    if (!liveIds.has(id) || !selected[id]) {
      delete managed[id];
      toClose.push(tabId);
    }
  }
  await session.set({ managed, dismissed });
  for (const tabId of toClose) await chrome.tabs.remove(tabId).catch(() => {});

  for (const s of live) {
    if (selected[s.user_id] && !managed[s.user_id] && !dismissed[s.user_id]) {
      try {
        managed[s.user_id] = await openStream(s.user_login, focus);
        await session.set({ managed });
      } catch (e) {
        console.warn('Could not open stream', s.user_login, e);
      }
    }
  }
  const count = Object.keys(managed).length;
  chrome.action.setBadgeBackgroundColor({ color: '#9147ff' });
  chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

async function select(id, checked) {
  const { selected = {} } = await local.get('selected');
  if (checked) selected[id] = true;
  else delete selected[id];
  await local.set({ selected });
  // Re-enabling a channel cancels a previous manual close: the stream reopens.
  if (checked) {
    const { dismissed = {} } = await session.get('dismissed');
    delete dismissed[id];
    await session.set({ dismissed });
  }
  await poll(checked);
  const { managed = {} } = await session.get('managed');
  return Object.keys(managed);
}

async function state() {
  const { token, login, userId, selected = {} } = await local.get(['token', 'login', 'userId', 'selected']);
  const base = { api: 2, connected: !!token, login, selected, redirect: chrome.identity.getRedirectURL() };
  if (!token) return base;
  try {
    const [follows, streams] = await Promise.all([
      api('channels/followed', { user_id: userId }),
      api('streams/followed', { user_id: userId }),
    ]);
    const avatars = await loadAvatars(follows.map((f) => f.broadcaster_id)).catch(() => ({}));
    const { managed = {} } = await session.get('managed');
    const live = {};
    for (const s of streams) live[s.user_id] = { game: s.game_name, title: s.title, viewers: s.viewer_count };
    return {
      ...base,
      live,
      managed: Object.keys(managed),
      follows: follows.map((f) => ({
        id: f.broadcaster_id,
        login: f.broadcaster_login,
        name: f.broadcaster_name,
        avatar: avatars[f.broadcaster_id] || '',
      })),
    };
  } catch (e) {
    return { ...base, connected: e.message !== 'not_connected', error: e.message };
  }
}

// Runs every time the service worker wakes up: makes sure the periodic scan exists.
chrome.alarms.get('poll').then((a) => a || chrome.alarms.create('poll', { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => serial(poll));
chrome.runtime.onInstalled.addListener(() => serial(poll));
chrome.alarms.onAlarm.addListener((a) => a.name === 'poll' && serial(poll));

chrome.tabs.onRemoved.addListener((tabId) =>
  serial(async () => {
    const { managed = {}, dismissed = {} } = await session.get(['managed', 'dismissed']);
    const id = Object.keys(managed).find((k) => managed[k] === tabId);
    if (!id) return;
    delete managed[id];
    dismissed[id] = true;
    await session.set({ managed, dismissed });
  })
);

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handlers = {
    state: () => serial(poll).then(state),
    select: () => serial(() => select(msg.id, msg.checked)),
    connect: () => connect(msg.clientId).then(() => serial(poll)),
    disconnect: () => local.remove(['token', 'userId', 'login', 'cache']),
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve(handler()).then(
    (data) => reply({ ok: true, data }),
    (e) => reply({ ok: false, error: e.message })
  );
  return true;
});
