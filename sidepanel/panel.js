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

// ---- Render ----
function getFaviconUrl(tab) {
  return tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}`;
}

function renderActiveTabs(tabs) {
  const list = document.getElementById('active-list');
  list.innerHTML = '';
  if (!tabs.length) {
    list.innerHTML = '<li class="empty-hint">无标签页</li>';
    return;
  }
  tabs.forEach(tab => {
    const li = document.createElement('li');
    li.className = 'tab-item' + (tab.active ? ' active-tab' : '');
    li.dataset.tabId = tab.id;
    li.innerHTML = `
      <img class="tab-favicon" src="${getFaviconUrl(tab)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><rect width=%2216%22 height=%2216%22 rx=%222%22 fill=%22%23ddd%22/></svg>'">
      <span class="tab-title" title="${escHtml(tab.title)}">${escHtml(tab.title)}</span>
      <span class="tab-actions">
        <button class="btn-hibernate" title="休眠到分组">💤</button>
        <button class="btn-close" title="关闭">✕</button>
      </span>`;
    li.querySelector('.tab-title').addEventListener('click', () => chrome.tabs.update(tab.id, { active: true }));
    li.querySelector('.btn-hibernate').addEventListener('click', (e) => showGroupPicker(e, tab));
    li.querySelector('.btn-close').addEventListener('click', () => chrome.tabs.remove(tab.id));
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
  state.groups.forEach(group => {
    const div = document.createElement('div');
    div.className = 'group-item';
    div.dataset.groupId = group.id;

    const tabsHtml = group.hibernatedTabs.map(t => `
      <div class="hibernated-tab" data-tab-id="${t.id}" data-url="${escHtml(t.url)}">
        <img class="tab-favicon" src="${escHtml(t.favicon)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><rect width=%2216%22 height=%2216%22 rx=%222%22 fill=%22%23ddd%22/></svg>'">
        <span class="tab-title" title="${escHtml(t.title)}">${escHtml(t.title)}</span>
        <button class="remove-btn" title="移除">✕</button>
      </div>`).join('');

    div.innerHTML = `
      <div class="group-header">
        <span class="group-color" style="background:${group.color}"></span>
        <span class="group-name">${escHtml(group.name)}</span>
        <span class="group-count">${group.hibernatedTabs.length}</span>
        <span class="group-actions">
          <button class="btn-rename" title="重命名">✏️</button>
          <button class="btn-delete-group" title="删除分组">🗑</button>
        </span>
        <span class="group-toggle">${group.collapsed ? '▶' : '▼'}</span>
      </div>
      <div class="group-tabs${group.collapsed ? ' collapsed' : ''}">${tabsHtml || '<div class="empty-hint">暂无休眠标签</div>'}</div>`;

    div.querySelector('.group-header').addEventListener('click', (e) => {
      if (e.target.closest('.group-actions')) return;
      group.collapsed = !group.collapsed;
      saveData();
      renderGroups();
    });
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

// ---- Handlers ----
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function newGroupId() { return 'g_' + Date.now(); }
function newTabId() { return 't_' + Date.now() + '_' + Math.random().toString(36).slice(2,6); }

const COLORS = ['#4A90D9','#E67E22','#27AE60','#9B59B6','#E74C3C','#1ABC9C'];

function createGroup(name) {
  const group = { id: newGroupId(), name, color: COLORS[state.groups.length % COLORS.length], collapsed: false, hibernatedTabs: [] };
  state.groups.push(group);
  saveData();
  renderGroups();
  return group;
}

function deleteGroup(groupId) {
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
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = group.name; input.blur(); } });
}

async function hibernateTab(tab, groupId) {
  let group = state.groups.find(g => g.id === groupId);
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

function removeHibernated(groupId, tabId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  group.hibernatedTabs = group.hibernatedTabs.filter(t => t.id !== tabId);
  saveData();
  renderGroups();
}

// ---- Group Picker ----
let pickerTarget = null;

function showGroupPicker(e, tab) {
  e.stopPropagation();
  pickerTarget = tab;
  const picker = document.getElementById('group-picker');
  const list = document.getElementById('group-picker-list');
  list.innerHTML = state.groups.length
    ? state.groups.map(g => `<div class="picker-item" data-group-id="${g.id}"><span class="group-color" style="background:${g.color};width:10px;height:10px;border-radius:50%;display:inline-block"></span>${escHtml(g.name)}</div>`).join('')
    : '<div class="empty-hint">暂无分组</div>';
  list.querySelectorAll('.picker-item').forEach(el => {
    el.addEventListener('click', () => { hibernateTab(pickerTarget, el.dataset.groupId); hidePicker(); });
  });
  picker.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  picker.style.top = e.clientY + 'px';
  picker.classList.remove('hidden');
}

function hidePicker() {
  document.getElementById('group-picker').classList.add('hidden');
  pickerTarget = null;
}

// ---- Init ----
document.getElementById('btn-new-group').addEventListener('click', () => {
  const name = prompt('分组名称：');
  if (name && name.trim()) createGroup(name.trim());
});

document.getElementById('btn-picker-new').addEventListener('click', () => {
  hidePicker();
  const name = prompt('新建分组名称：');
  if (name && name.trim()) {
    const group = createGroup(name.trim());
    if (pickerTarget) hibernateTab(pickerTarget, group.id);
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#group-picker')) hidePicker();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TABS_CHANGED') getActiveTabs().then(renderActiveTabs);
});

loadData().then(renderAll);
