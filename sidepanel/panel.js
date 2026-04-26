// ---- Storage ----
let state = { groups: [] };

async function loadData() {
  const result = await chrome.storage.local.get('groups');
  state.groups = result.groups || [];
}

let saveTimer = null;
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ groups: state.groups });
  }, 300);
}

// ---- Tabs ----
async function getActiveTabs() {
  return chrome.tabs.query({ currentWindow: true });
}

// ---- Helpers ----
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FALLBACK_FAVICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ddd"/></svg>';

function getFaviconUrl(tab) {
  if (tab.favIconUrl) return tab.favIconUrl;
  try { return `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}`; }
  catch { return FALLBACK_FAVICON; }
}

function newGroupId() { return 'g_' + Date.now(); }
function newTabId() { return 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

const COLORS = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6', '#E74C3C', '#1ABC9C'];

// ---- Search ----
function getKeyword() {
  return document.getElementById('search-input').value.trim().toLowerCase();
}

function filterTabs() {
  const keyword = getKeyword();
  document.querySelectorAll('#active-list .tab-item').forEach(el => {
    const title = (el.querySelector('.tab-title')?.title || '').toLowerCase();
    el.classList.toggle('filtered', !!keyword && !title.includes(keyword));
  });
  document.querySelectorAll('.hibernated-tab').forEach(el => {
    const title = (el.querySelector('.tab-title')?.title || '').toLowerCase();
    const url = (el.dataset.url || '').toLowerCase();
    el.classList.toggle('filtered', !!keyword && !title.includes(keyword) && !url.includes(keyword));
  });
}

// ---- Render ----
function renderActiveTabs(tabs) {
  const list = document.getElementById('active-list');
  list.innerHTML = '';
  if (!tabs.length) {
    list.innerHTML = '<li class="empty-hint">无标签页</li>';
    return;
  }
  const keyword = getKeyword();
  tabs.forEach(tab => {
    const li = document.createElement('li');
    li.className = 'tab-item' + (tab.active ? ' active-tab' : '');
    li.dataset.tabId = tab.id;
    if (keyword && !tab.title.toLowerCase().includes(keyword) && !tab.url.toLowerCase().includes(keyword)) {
      li.classList.add('filtered');
    }
    li.innerHTML = `
      <img class="tab-favicon" src="${getFaviconUrl(tab)}" onerror="this.src='${FALLBACK_FAVICON}'">
      <span class="tab-title" title="${escHtml(tab.title)}">${escHtml(tab.title)}</span>
      <span class="tab-actions">
        <button class="btn-hibernate" title="休眠到分组">💤</button>
        <button class="btn-close" title="关闭标签">✕</button>
      </span>`;
    li.querySelector('.tab-title').addEventListener('click', () => chrome.tabs.update(tab.id, { active: true }));
    li.querySelector('.btn-hibernate').addEventListener('click', (e) => { e.stopPropagation(); showGroupPicker(e, 'single', tab); });
    li.querySelector('.btn-close').addEventListener('click', (e) => { e.stopPropagation(); chrome.tabs.remove(tab.id); });
    list.appendChild(li);
  });
}

function renderGroups() {
  const container = document.getElementById('groups-list');
  container.innerHTML = '';
  if (!state.groups.length) {
    container.innerHTML = '<div class="empty-hint">点击 + 新建分组</div>';
    return;
  }
  const keyword = getKeyword();
  state.groups.forEach(group => {
    const div = document.createElement('div');
    div.className = 'group-item';
    div.dataset.groupId = group.id;

    const tabsHtml = group.hibernatedTabs.map(t => {
      const hidden = keyword && !t.title.toLowerCase().includes(keyword) && !t.url.toLowerCase().includes(keyword);
      return `
        <div class="hibernated-tab${hidden ? ' filtered' : ''}" data-tab-id="${t.id}" data-url="${escHtml(t.url)}">
          <img class="tab-favicon" src="${escHtml(t.favicon || FALLBACK_FAVICON)}" onerror="this.src='${FALLBACK_FAVICON}'">
          <span class="tab-title" title="${escHtml(t.title)}">${escHtml(t.title)}</span>
          <button class="remove-btn" title="移除">✕</button>
        </div>`;
    }).join('');

    div.innerHTML = `
      <div class="group-header">
        <div class="group-color-bar" style="background:${group.color}"></div>
        <span class="group-name">${escHtml(group.name)}</span>
        <span class="group-count">${group.hibernatedTabs.length}</span>
        <span class="group-actions">
          <button class="btn-restore-all" title="全部恢复">▶▶</button>
          <button class="btn-rename" title="重命名">✏️</button>
          <button class="btn-delete-group" title="删除分组">🗑</button>
        </span>
        <span class="group-toggle">${group.collapsed ? '▶' : '▼'}</span>
      </div>
      <div class="group-tabs${group.collapsed ? ' collapsed' : ''}">
        ${tabsHtml || '<div class="empty-hint">暂无休眠标签</div>'}
      </div>`;

    div.querySelector('.group-header').addEventListener('click', (e) => {
      if (e.target.closest('.group-actions')) return;
      group.collapsed = !group.collapsed;
      saveData();
      renderGroups();
    });
    div.querySelector('.btn-restore-all').addEventListener('click', (e) => { e.stopPropagation(); restoreAllTabs(group.id); });
    div.querySelector('.btn-rename').addEventListener('click', (e) => { e.stopPropagation(); startRename(div, group); });
    div.querySelector('.btn-delete-group').addEventListener('click', (e) => { e.stopPropagation(); deleteGroup(group.id); });
    div.querySelectorAll('.hibernated-tab').forEach(el => {
      el.querySelector('.tab-title').addEventListener('click', () => restoreTab(group.id, el.dataset.tabId));
      el.querySelector('.remove-btn').addEventListener('click', (e) => { e.stopPropagation(); removeHibernated(group.id, el.dataset.tabId); });
    });
    container.appendChild(div);
  });
}

async function renderAll() {
  const tabs = await getActiveTabs();
  renderActiveTabs(tabs);
  renderGroups();
}

// ---- Group Operations ----
function createGroup(name) {
  const group = {
    id: newGroupId(),
    name,
    color: COLORS[state.groups.length % COLORS.length],
    collapsed: false,
    hibernatedTabs: []
  };
  state.groups.push(group);
  saveData();
  renderGroups();
  return group;
}

function deleteGroup(groupId) {
  if (!confirm('删除此分组及其所有休眠标签？')) return;
  state.groups = state.groups.filter(g => g.id !== groupId);
  saveData();
  renderGroups();
}

function startRename(div, group) {
  const nameEl = div.querySelector('.group-name');
  const input = document.createElement('input');
  input.className = 'group-name-input';
  input.value = group.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const finish = () => {
    const val = input.value.trim();
    if (val) group.name = val;
    saveData();
    renderGroups();
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.stopPropagation(); input.blur(); }
    if (e.key === 'Escape') { input.value = group.name; input.blur(); }
  });
}

// ---- Tab Operations ----
async function hibernateTab(tab, groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  group.hibernatedTabs.push({
    id: newTabId(),
    title: tab.title || tab.url,
    url: tab.url,
    favicon: tab.favIconUrl || '',
    savedAt: Date.now()
  });
  saveData();
  await chrome.tabs.remove(tab.id);
  renderGroups();
}

async function hibernateAllTabs(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  const tabs = await chrome.tabs.query({ pinned: false, currentWindow: true });
  if (!tabs.length) return;
  tabs.forEach(tab => {
    group.hibernatedTabs.push({
      id: newTabId(),
      title: tab.title || tab.url,
      url: tab.url,
      favicon: tab.favIconUrl || '',
      savedAt: Date.now()
    });
  });
  saveData();
  await chrome.tabs.remove(tabs.map(t => t.id));
  await renderAll();
}

async function restoreTab(groupId, tabId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  const tab = group.hibernatedTabs.find(t => t.id === tabId);
  if (!tab) return;
  await chrome.tabs.create({ url: tab.url });
  group.hibernatedTabs = group.hibernatedTabs.filter(t => t.id !== tabId);
  saveData();
  renderGroups();
}

async function restoreAllTabs(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group || !group.hibernatedTabs.length) return;
  for (const tab of group.hibernatedTabs) {
    await chrome.tabs.create({ url: tab.url });
  }
  group.hibernatedTabs = [];
  saveData();
  renderGroups();
}

function removeHibernated(groupId, tabId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  group.hibernatedTabs = group.hibernatedTabs.filter(t => t.id !== tabId);
  saveData();
  renderGroups();
}

// ---- Group Picker ----
// mode: 'single' (休眠单个标签) | 'all' (批量休眠)
let pickerMode = 'single';
let pickerTab = null;

function showGroupPicker(e, mode, tab = null) {
  pickerMode = mode;
  pickerTab = tab;

  const picker = document.getElementById('group-picker');
  const list = document.getElementById('group-picker-list');
  list.innerHTML = state.groups.length
    ? state.groups.map(g => `
        <div class="picker-item" data-group-id="${g.id}">
          <span class="picker-dot" style="background:${g.color}"></span>
          ${escHtml(g.name)}
        </div>`).join('')
    : '<div class="empty-hint">暂无分组</div>';

  list.querySelectorAll('.picker-item').forEach(el => {
    el.addEventListener('click', () => {
      const gid = el.dataset.groupId;
      const mode = pickerMode;
      const tab = pickerTab;
      hidePicker();
      if (mode === 'all') hibernateAllTabs(gid);
      else if (tab) hibernateTab(tab, gid);
    });
  });

  picker.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  picker.style.top = (e.clientY + 4) + 'px';
  picker.classList.remove('hidden');
}

function hidePicker() {
  document.getElementById('group-picker').classList.add('hidden');
}

// ---- New Group Form ----
// pendingHibernate: 新建分组后需要触发的休眠操作
let pendingHibernate = null;

function showNewGroupForm(onCreated = null) {
  pendingHibernate = onCreated;
  const form = document.getElementById('new-group-form');
  form.classList.remove('hidden');
  const input = document.getElementById('new-group-input');
  input.value = '';
  input.focus();
}

function hideNewGroupForm() {
  document.getElementById('new-group-form').classList.add('hidden');
  pendingHibernate = null;
}

function confirmNewGroup() {
  const name = document.getElementById('new-group-input').value.trim();
  if (!name) { hideNewGroupForm(); return; }
  const group = createGroup(name);
  const cb = pendingHibernate;
  hideNewGroupForm();
  if (cb) cb(group.id);
}

// ---- Event Listeners ----
document.getElementById('btn-new-group').addEventListener('click', () => showNewGroupForm());

document.getElementById('btn-group-confirm').addEventListener('click', confirmNewGroup);
document.getElementById('btn-group-cancel').addEventListener('click', hideNewGroupForm);
document.getElementById('new-group-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmNewGroup();
  if (e.key === 'Escape') hideNewGroupForm();
});

document.getElementById('btn-search-toggle').addEventListener('click', () => {
  const bar = document.getElementById('search-bar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) {
    document.getElementById('search-input').focus();
  } else {
    document.getElementById('search-input').value = '';
    filterTabs();
  }
});
document.getElementById('search-input').addEventListener('input', filterTabs);

document.getElementById('btn-hibernate-all').addEventListener('click', (e) => {
  if (!state.groups.length) {
    showNewGroupForm((gid) => hibernateAllTabs(gid));
    return;
  }
  showGroupPicker(e, 'all');
});

document.getElementById('btn-picker-new').addEventListener('click', () => {
  const savedMode = pickerMode;
  const savedTab = pickerTab;
  hidePicker();
  showNewGroupForm((gid) => {
    if (savedMode === 'all') hibernateAllTabs(gid);
    else if (savedTab) hibernateTab(savedTab, gid);
  });
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#group-picker')) hidePicker();
  if (!e.target.closest('#new-group-form') && !e.target.closest('#btn-new-group')) hideNewGroupForm();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TABS_CHANGED') getActiveTabs().then(renderActiveTabs);
});

loadData().then(renderAll);
