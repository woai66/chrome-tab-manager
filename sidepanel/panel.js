// ---- Storage ----
let state = { groups: [] };

async function loadData() {
  const result = await chrome.storage.local.get('groups');
  const groups = result.groups || [];
  // 迁移旧数据：hibernatedTabs -> savedTabs
  groups.forEach(g => {
    if (g.hibernatedTabs && !g.savedTabs) {
      g.savedTabs = g.hibernatedTabs.map(t => ({ ...t, source: 'hibernate' }));
      delete g.hibernatedTabs;
    }
    g.savedTabs = g.savedTabs || [];
  });
  state.groups = groups;
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

function cleanTitle(t) {
  if (!t) return '';
  // 调试日志：发现非字母/数字开头时打印码点（F12 查看、修完后删）
  if (/^[^\p{L}\p{N}]/u.test(t)) {
    console.log('[cleanTitle] junk prefix codepoints:',
      [...t].slice(0, 8).map(c => 'U+' + c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()),
      'raw:', JSON.stringify(t.slice(0, 12))
    );
  }
  // 自适应：剩离开头所有「非有意义字符」直到遇到首个语义字符
  // 有意义 = 字母 / 数字 / 中文 / 常见合法首字符 +@#*&%([{$!?.
  const meaningful = /[\p{L}\p{N}+@#*&%(\[{$!?.]/u;
  const arr = [...t];
  let i = 0;
  while (i < arr.length && !meaningful.test(arr[i])) i++;
  return arr.slice(i).join('').trim();
}

const FALLBACK_FAVICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="%23ddd"/></svg>';

function getFaviconUrl(urlOrTab) {
  if (typeof urlOrTab === 'object' && urlOrTab.favIconUrl) return urlOrTab.favIconUrl;
  const url = typeof urlOrTab === 'string' ? urlOrTab : urlOrTab.url;
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=16`; }
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
  document.querySelectorAll('.saved-tab').forEach(el => {
    const title = (el.querySelector('.tab-title')?.title || '').toLowerCase();
    const url = (el.dataset.url || '').toLowerCase();
    el.classList.toggle('filtered', !!keyword && !title.includes(keyword) && !url.includes(keyword));
  });
}

// ---- Render ----
let currentTabUrls = new Set(); // 当前已打开的 tab URL 集合

function renderActiveTabs(tabs) {
  // 更新当前已打开的 URL 集合（用于分组高亮）
  currentTabUrls = new Set(tabs.map(t => t.url));

  const list = document.getElementById('active-list');
  list.innerHTML = '';
  if (!tabs.length) {
    list.innerHTML = '<li class="empty-hint">无标签页</li>';
    return;
  }
  const keyword = getKeyword();
  tabs.forEach(tab => {
    const title = cleanTitle(tab.title) || tab.url;
    const li = document.createElement('li');
    li.className = 'tab-item' + (tab.active ? ' active-tab' : '');
    li.dataset.tabId = tab.id;
    li.draggable = true;
    li.dataset.url = tab.url;
    li.dataset.title = title;
    li.dataset.favicon = getFaviconUrl(tab);

    if (keyword && !title.toLowerCase().includes(keyword) && !tab.url.toLowerCase().includes(keyword)) {
      li.classList.add('filtered');
    }
    li.innerHTML = `
      <img class="tab-favicon" src="${getFaviconUrl(tab)}" onerror="this.src='${FALLBACK_FAVICON}'">
      <span class="tab-title" title="${escHtml(tab.url)}">${escHtml(title)}</span>
      <span class="tab-actions">
        <button class="btn-bookmark" title="保存到分组">保存</button>
        <button class="btn-close" title="关闭标签">✕</button>
      </span>`;

    li.querySelector('.tab-title').addEventListener('click', () => chrome.tabs.update(tab.id, { active: true }));
    li.querySelector('.btn-bookmark').addEventListener('click', (e) => { e.stopPropagation(); showGroupPicker(e, 'bookmark', tab); });
    li.querySelector('.btn-close').addEventListener('click', (e) => { e.stopPropagation(); chrome.tabs.remove(tab.id); });

    // 拖拽
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/tab', JSON.stringify({
        url: tab.url,
        title,
        favicon: getFaviconUrl(tab)
      }));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));

    list.appendChild(li);
  });

  // 同步刷新分组高亮
  document.querySelectorAll('.saved-tab').forEach(el => {
    el.classList.toggle('tab-open', currentTabUrls.has(el.dataset.url));
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

    const tabsHtml = group.savedTabs.map(t => {
      const isOpen = currentTabUrls.has(t.url);
      const hidden = keyword && !t.title.toLowerCase().includes(keyword) && !t.url.toLowerCase().includes(keyword);
      return `
        <div class="saved-tab${isOpen ? ' tab-open' : ''}${hidden ? ' filtered' : ''}" data-tab-id="${t.id}" data-url="${escHtml(t.url)}">
          <img class="tab-favicon" src="${escHtml(t.favicon || getFaviconUrl(t.url))}" onerror="this.src='${FALLBACK_FAVICON}'">
          <span class="tab-title" title="${escHtml(t.url)}">${escHtml(t.title)}</span>
          ${isOpen ? '<span class="open-badge" title="当前已打开">●</span>' : ''}
          <button class="remove-btn" title="从分组移除">✕</button>
        </div>`;
    }).join('');

    div.innerHTML = `
      <div class="group-header" style="border-left: 3px solid ${group.color}">
        <span class="group-name">${escHtml(group.name)}</span>
        <span class="group-count">${group.savedTabs.length}</span>
        <span class="group-actions">
          <button class="btn-open-all" title="全部打开">▶▶</button>
          <button class="btn-rename" title="重命名">✏️</button>
          <button class="btn-delete-group" title="删除分组">🗑</button>
        </span>
        <span class="group-toggle">${group.collapsed ? '▶' : '▼'}</span>
      </div>
      <div class="group-tabs${group.collapsed ? ' collapsed' : ''}">
        ${tabsHtml || '<div class="empty-hint">拖拽标签到此处，或用 🔖 保存</div>'}
      </div>`;

    // 拖拽放入
    const groupTabs = div.querySelector('.group-tabs');
    const groupHeader = div.querySelector('.group-header');
    [groupHeader, groupTabs].forEach(target => {
      target.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        div.classList.add('drag-over');
      });
      target.addEventListener('dragleave', (e) => {
        if (!div.contains(e.relatedTarget)) div.classList.remove('drag-over');
      });
      target.addEventListener('drop', (e) => {
        e.preventDefault();
        div.classList.remove('drag-over');
        try {
          const data = JSON.parse(e.dataTransfer.getData('application/tab'));
          addTabToGroup(group.id, data.url, data.title, data.favicon);
        } catch {}
      });
    });

    div.querySelector('.group-header').addEventListener('click', (e) => {
      if (e.target.closest('.group-actions')) return;
      group.collapsed = !group.collapsed;
      saveData();
      renderGroups();
    });
    div.querySelector('.btn-open-all').addEventListener('click', (e) => { e.stopPropagation(); openAllTabs(group.id); });
    div.querySelector('.btn-rename').addEventListener('click', (e) => { e.stopPropagation(); startRename(div, group); });
    div.querySelector('.btn-delete-group').addEventListener('click', (e) => { e.stopPropagation(); deleteGroup(group.id); });

    div.querySelectorAll('.saved-tab').forEach(el => {
      el.querySelector('.tab-title').addEventListener('click', () => smartOpen(el.dataset.url));
      el.querySelector('.remove-btn').addEventListener('click', (e) => { e.stopPropagation(); removeSavedTab(group.id, el.dataset.tabId); });
    });

    container.appendChild(div);
  });
}

async function renderAll() {
  const tabs = await getActiveTabs();
  renderActiveTabs(tabs);
  renderGroups();
}

// ---- Smart Open ----
async function smartOpen(url) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const existing = tabs.find(t => t.url === url);
  if (existing) {
    chrome.tabs.update(existing.id, { active: true });
  } else {
    chrome.tabs.create({ url });
  }
}

// ---- Group Operations ----
function createGroup(name) {
  const group = {
    id: newGroupId(),
    name,
    color: COLORS[state.groups.length % COLORS.length],
    collapsed: false,
    savedTabs: []
  };
  state.groups.push(group);
  saveData();
  renderGroups();
  return group;
}

function deleteGroup(groupId) {
  if (!confirm('删除此分组及其所有保存的标签？')) return;
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
function addTabToGroup(groupId, url, title, favicon) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  // 去重
  if (group.savedTabs.some(t => t.url === url)) return;
  group.savedTabs.push({
    id: newTabId(),
    title: cleanTitle(title) || url,
    url,
    favicon: favicon || '',
    savedAt: Date.now(),
    source: 'bookmark'
  });
  saveData();
  renderGroups();
}

async function hibernateTabToGroup(tab, groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  if (!group.savedTabs.some(t => t.url === tab.url)) {
    group.savedTabs.push({
      id: newTabId(),
      title: cleanTitle(tab.title) || tab.url,
      url: tab.url,
      favicon: tab.favIconUrl || '',
      savedAt: Date.now(),
      source: 'hibernate'
    });
  }
  saveData();
  await chrome.tabs.remove(tab.id);
  renderGroups();
}

async function openAllTabs(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group || !group.savedTabs.length) return;
  for (const tab of group.savedTabs) {
    await smartOpen(tab.url);
  }
}

function removeSavedTab(groupId, tabId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  group.savedTabs = group.savedTabs.filter(t => t.id !== tabId);
  saveData();
  renderGroups();
}

async function bookmarkAllTabs(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  const tabs = await chrome.tabs.query({ pinned: false, currentWindow: true });
  tabs.forEach(tab => {
    if (!group.savedTabs.some(t => t.url === tab.url)) {
      group.savedTabs.push({
        id: newTabId(),
        title: cleanTitle(tab.title) || tab.url,
        url: tab.url,
        favicon: tab.favIconUrl || '',
        savedAt: Date.now(),
        source: 'bookmark'
      });
    }
  });
  saveData();
  renderGroups();
}

async function hibernateAllTabs(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  const tabs = await chrome.tabs.query({ pinned: false, currentWindow: true });
  if (!tabs.length) return;
  tabs.forEach(tab => {
    if (!group.savedTabs.some(t => t.url === tab.url)) {
      group.savedTabs.push({
        id: newTabId(),
        title: cleanTitle(tab.title) || tab.url,
        url: tab.url,
        favicon: tab.favIconUrl || '',
        savedAt: Date.now(),
        source: 'hibernate'
      });
    }
  });
  saveData();
  await chrome.tabs.remove(tabs.map(t => t.id));
  await renderAll();
}

// ---- Group Picker ----
// mode: 'bookmark' | 'hibernate' | 'hibernate-all' | 'bookmark-all'
let pickerMode = 'bookmark';
let pickerTab = null;

function showGroupPicker(e, mode, tab = null) {
  pickerMode = mode;
  pickerTab = tab;

  const picker = document.getElementById('group-picker');
  const list = document.getElementById('group-picker-list');
  const closeAfter = (mode === 'bookmark');
  list.innerHTML = `<div class="picker-mode-row">
    <label class="picker-mode-label">
      <input type="checkbox" id="picker-close-cb"${closeAfter ? '' : ' checked'}> 保存后关闭标签
    </label>
  </div>` + (state.groups.length
    ? state.groups.map(g => `
        <div class="picker-item" data-group-id="${g.id}">
          <span class="picker-dot" style="background:${g.color}"></span>
          ${escHtml(g.name)}
        </div>`).join('')
    : '<div class="empty-hint">暂无分组</div>');

  list.querySelectorAll('.picker-item').forEach(el => {
    el.addEventListener('click', () => {
      const gid = el.dataset.groupId;
      const mode = pickerMode;
      const tab = pickerTab;
      const closeTab = document.getElementById('picker-close-cb')?.checked;
      hidePicker();
      if (mode === 'hibernate-all') hibernateAllTabs(gid);
      else if (mode === 'bookmark-all') bookmarkAllTabs(gid);
      else if (tab) {
        if (closeTab) hibernateTabToGroup(tab, gid);
        else addTabToGroup(gid, tab.url, tab.title, tab.favIconUrl);
      }
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

// 全部保存 / 全部休眠（toolbar 按钮）
document.getElementById('btn-hibernate-all').addEventListener('click', (e) => {
  const mode = e.shiftKey ? 'hibernate-all' : 'bookmark-all';
  if (!state.groups.length) {
    showNewGroupForm((gid) => {
      if (mode === 'hibernate-all') hibernateAllTabs(gid);
      else bookmarkAllTabs(gid);
    });
    return;
  }
  showGroupPicker(e, mode);
});

document.getElementById('btn-picker-new').addEventListener('click', () => {
  const savedMode = pickerMode;
  const savedTab = pickerTab;
  hidePicker();
  showNewGroupForm((gid) => {
    if (savedMode === 'hibernate-all') hibernateAllTabs(gid);
    else if (savedMode === 'bookmark-all') bookmarkAllTabs(gid);
    else if (savedMode === 'hibernate' && savedTab) hibernateTabToGroup(savedTab, gid);
    else if (savedMode === 'bookmark' && savedTab) addTabToGroup(gid, savedTab.url, savedTab.title, savedTab.favIconUrl);
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
