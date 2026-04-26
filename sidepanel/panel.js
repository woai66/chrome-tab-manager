// ---- Storage ----
let state = { groups: [], syncEnabled: false };

function normalizeGroups(groups) {
  groups.forEach(g => {
    if (g.hibernatedTabs && !g.savedTabs) {
      g.savedTabs = g.hibernatedTabs.map(t => ({ ...t, source: 'hibernate' }));
      delete g.hibernatedTabs;
    }
    g.savedTabs = g.savedTabs || [];
    g.updatedAt = g.updatedAt || Date.now();
    g.savedTabs.forEach(t => { t.updatedAt = t.updatedAt || t.savedAt || Date.now(); });
  });
  return groups;
}

async function loadData() {
  const result = await chrome.storage.local.get(['groups', 'syncEnabled']);
  state.groups = normalizeGroups(result.groups || []);
  state.syncEnabled = !!result.syncEnabled;
  if (state.syncEnabled) {
    await syncPull();
  }
}

let saveTimer = null;
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ groups: state.groups });
    scheduleSyncPush();
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
  // 自适应：剥离开头所有「非有意义字符」直到首个语义字符
  // 有意义 = 字母 / 数字 / 中文 / 常见合法首字符 +@#*&%([{$!?.【
  const meaningful = /[\p{L}\p{N}+@#*&%(\[{$!?.\u3010\u300a\u300c\u300e]/u;
  const arr = [...t];
  let i = 0;
  while (i < arr.length && !meaningful.test(arr[i])) i++;
  return arr.slice(i).join('').trim();
}

const FALLBACK_FAVICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#bbb"/><circle cx="8" cy="8" r="3" fill="#fff"/></svg>');

function getFaviconUrl(urlOrTab) {
  if (typeof urlOrTab === 'object' && urlOrTab.favIconUrl) return urlOrTab.favIconUrl;
  const url = typeof urlOrTab === 'string' ? urlOrTab : urlOrTab.url;
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=16`; }
  catch { return FALLBACK_FAVICON; }
}

function newGroupId() { return 'g_' + Date.now(); }
function newTabId() { return 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

const COLORS = ['#4A90D9', '#E67E22', '#27AE60', '#9B59B6', '#E74C3C', '#1ABC9C'];

function hexToRgba(hex, alpha) {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return hex;
  const [r, g, b] = m.map(h => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 当前正在拖拽的分组索引（拖整个分组重排时）
let draggingGroupIdx = null;


// ---- Cloud Sync ----
let syncPushTimer = null;
let lastSyncPushAt = 0;

function getCloudFavicon(url) {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=16`;
  } catch { return ''; }
}

function markGroupUpdated(group) {
  if (group) group.updatedAt = Date.now();
}

async function syncPush() {
  if (!state.syncEnabled) return;
  const now = Date.now();
  const items = {
    sync_meta: {
      v: 1,
      lastWriteAt: now,
      groupOrder: state.groups.map(g => g.id)
    }
  };

  state.groups.forEach(g => {
    items[`group_${g.id}`] = {
      name: g.name,
      color: g.color,
      collapsed: g.collapsed,
      tabIds: g.savedTabs.map(t => t.id),
      updatedAt: g.updatedAt || now
    };
    g.savedTabs.forEach(t => {
      items[`tab_${t.id}`] = {
        gid: g.id,
        title: t.title,
        url: t.url,
        source: t.source,
        savedAt: t.savedAt,
        updatedAt: t.updatedAt || t.savedAt || now
      };
    });
  });

  const all = await chrome.storage.sync.get(null);
  const valid = new Set(Object.keys(items));
  const stale = Object.keys(all).filter(k =>
    (k === 'sync_meta' || k.startsWith('group_') || k.startsWith('tab_')) && !valid.has(k)
  );
  if (stale.length) await chrome.storage.sync.remove(stale);
  await chrome.storage.sync.set(items);
  lastSyncPushAt = Date.now();
  updateQuotaDisplay();
}

async function syncPull() {
  const all = await chrome.storage.sync.get(null);
  if (!all.sync_meta) return;
  const localById = new Map(state.groups.map(g => [g.id, g]));
  const merged = [];

  (all.sync_meta.groupOrder || []).forEach(gid => {
    const meta = all[`group_${gid}`];
    if (!meta) return;
    const local = localById.get(gid);
    const useRemoteGroup = !local || (meta.updatedAt || 0) >= (local.updatedAt || 0);

    const tabs = (meta.tabIds || []).map(tid => {
      const remote = all[`tab_${tid}`];
      const localTab = local?.savedTabs?.find(t => t.id === tid);
      if (!remote && !localTab) return null;
      if (!remote) return localTab;
      if (!localTab) {
        return {
          id: tid,
          title: remote.title,
          url: remote.url,
          favicon: getCloudFavicon(remote.url),
          savedAt: remote.savedAt,
          source: remote.source,
          updatedAt: remote.updatedAt || remote.savedAt
        };
      }
      const useRemoteTab = (remote.updatedAt || remote.savedAt || 0) >= (localTab.updatedAt || localTab.savedAt || 0);
      return useRemoteTab
        ? { ...localTab, ...remote, id: tid, favicon: localTab.favicon || getCloudFavicon(remote.url) }
        : localTab;
    }).filter(Boolean);

    merged.push({
      id: gid,
      name: useRemoteGroup ? meta.name : local.name,
      color: useRemoteGroup ? meta.color : local.color,
      collapsed: useRemoteGroup ? meta.collapsed : local.collapsed,
      savedTabs: tabs,
      updatedAt: Math.max(meta.updatedAt || 0, local?.updatedAt || 0)
    });
  });

  // 保留远端没有的本地分组，避免刚开启同步时误删本地数据。
  state.groups.forEach(g => {
    if (!merged.some(m => m.id === g.id)) merged.push(g);
  });

  state.groups = normalizeGroups(merged);
  await chrome.storage.local.set({ groups: state.groups });
  renderGroups();
  updateQuotaDisplay();
}

function scheduleSyncPush() {
  if (!state.syncEnabled) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => syncPush().catch(err => console.warn('[sync] push failed:', err)), 5000);
}

async function updateQuotaDisplay() {
  const el = document.getElementById('sync-quota');
  if (!el) return;
  try {
    const used = await chrome.storage.sync.getBytesInUse(null);
    el.textContent = `已用 ${(used / 1024).toFixed(1)} / 100 KB`;
  } catch {
    el.textContent = '同步配额读取失败';
  }
}

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
      <img class="tab-favicon" src="${getFaviconUrl(tab)}">
      <span class="tab-title" title="${escHtml(tab.url)}">${escHtml(title)}</span>
      <span class="tab-actions">
        <button class="btn-bookmark" title="保存到分组">保存</button>
        <button class="btn-close" title="关闭标签">✕</button>
      </span>`;

    const favImg = li.querySelector('.tab-favicon');
    favImg.addEventListener('error', () => { favImg.src = FALLBACK_FAVICON; }, { once: true });
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

  state.groups.forEach((group, groupIdx) => {
    const div = document.createElement('div');
    div.className = 'group-item';
    div.dataset.groupId = group.id;
    div.dataset.groupIdx = groupIdx;

    const tabsHtml = group.savedTabs.map((t, tabIdx) => {
      const isOpen = currentTabUrls.has(t.url);
      const hidden = keyword && !t.title.toLowerCase().includes(keyword) && !t.url.toLowerCase().includes(keyword);
      return `
        <div class="saved-tab${isOpen ? ' tab-open' : ''}${hidden ? ' filtered' : ''}" draggable="true" data-tab-id="${t.id}" data-tab-idx="${tabIdx}" data-url="${escHtml(t.url)}">
          <img class="tab-favicon" src="${escHtml(t.favicon || getFaviconUrl(t.url))}">
          <span class="tab-title" title="${escHtml(t.url)}">${escHtml(t.title)}</span>
          ${isOpen ? '<span class="open-badge" title="当前已打开">●</span>' : ''}
          <button class="remove-btn" title="从分组移除">✕</button>
        </div>`;
    }).join('');

    div.innerHTML = `
      <div class="group-header" draggable="true" style="--group-color: ${group.color}; --group-bg: ${hexToRgba(group.color, 0.14)};">
        <span class="group-color-bar"></span>
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
        ${tabsHtml || '<div class="empty-hint">拖拽标签到此处，或用「保存」按钮</div>'}
      </div>`;

    const groupTabs = div.querySelector('.group-tabs');
    const groupHeader = div.querySelector('.group-header');

    // === 接收来自活跃标签或其他分组的标签拖拽（外部 drop） ===
    [groupHeader, groupTabs].forEach(target => {
      target.addEventListener('dragover', (e) => {
        // 如果当前正在拖分组本身，不允许 drop 到分组里（那是排序）
        if (draggingGroupIdx !== null) return;
        // 只接收两种 dataTransfer 类型
        const types = e.dataTransfer.types;
        const isTab = types.includes('application/tab');
        const isSaved = types.includes('application/saved-tab');
        if (!isTab && !isSaved) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = isSaved ? 'move' : 'copy';
        div.classList.add('drag-over');
      });
      target.addEventListener('dragleave', (e) => {
        if (!div.contains(e.relatedTarget)) div.classList.remove('drag-over');
      });
      target.addEventListener('drop', (e) => {
        if (draggingGroupIdx !== null) return;
        const tabData = e.dataTransfer.getData('application/tab');
        const savedData = e.dataTransfer.getData('application/saved-tab');
        if (!tabData && !savedData) return;
        e.preventDefault();
        div.classList.remove('drag-over');
        if (savedData) {
          try {
            const data = JSON.parse(savedData);
            // 同组放到 group-tabs 空白处不做事（避免自己拖到自己）
            if (data.fromGroupId === group.id) return;
            moveSavedTab(data.fromGroupId, data.tabId, group.id);
          } catch {}
        } else if (tabData) {
          try {
            const data = JSON.parse(tabData);
            addTabToGroup(group.id, data.url, data.title, data.favicon);
          } catch {}
        }
      });
    });

    // === 分组本身的拖拽（重排分组顺序） ===
    groupHeader.addEventListener('dragstart', (e) => {
      // 只有在 header 空白处拖才算重排，按钮/标签输入不算
      if (e.target.closest('.group-actions, .group-name-input')) {
        e.preventDefault();
        return;
      }
      draggingGroupIdx = groupIdx;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/group-idx', String(groupIdx));
      div.classList.add('group-dragging');
    });
    groupHeader.addEventListener('dragend', () => {
      draggingGroupIdx = null;
      div.classList.remove('group-dragging');
      document.querySelectorAll('.group-item').forEach(el => el.classList.remove('drop-before', 'drop-after'));
    });

    div.addEventListener('dragover', (e) => {
      if (draggingGroupIdx === null || draggingGroupIdx === groupIdx) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = div.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      div.classList.toggle('drop-before', before);
      div.classList.toggle('drop-after', !before);
    });
    div.addEventListener('dragleave', (e) => {
      if (!div.contains(e.relatedTarget)) {
        div.classList.remove('drop-before', 'drop-after');
      }
    });
    div.addEventListener('drop', (e) => {
      if (draggingGroupIdx === null || draggingGroupIdx === groupIdx) return;
      e.preventDefault();
      const rect = div.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      reorderGroup(draggingGroupIdx, groupIdx, before);
      div.classList.remove('drop-before', 'drop-after');
    });

    // === header 点击折叠 ===
    groupHeader.addEventListener('click', (e) => {
      if (e.target.closest('.group-actions')) return;
      group.collapsed = !group.collapsed;
      markGroupUpdated(group);
      saveData();
      renderGroups();
    });
    div.querySelector('.btn-open-all').addEventListener('click', (e) => { e.stopPropagation(); openAllTabs(group.id); });
    div.querySelector('.btn-rename').addEventListener('click', (e) => { e.stopPropagation(); startRename(div, group); });
    div.querySelector('.btn-delete-group').addEventListener('click', (e) => { e.stopPropagation(); deleteGroup(group.id); });

    // === 分组内 saved-tab 事件 ===
    div.querySelectorAll('.saved-tab').forEach(el => {
      const img = el.querySelector('.tab-favicon');
      if (img) img.addEventListener('error', () => { img.src = FALLBACK_FAVICON; }, { once: true });
      el.querySelector('.tab-title').addEventListener('click', () => smartOpen(el.dataset.url));
      el.querySelector('.remove-btn').addEventListener('click', (e) => { e.stopPropagation(); removeSavedTab(group.id, el.dataset.tabId); });

      // saved-tab 拖拽起手（用于跨分组移动 + 同分组排序）
      el.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/saved-tab', JSON.stringify({
          fromGroupId: group.id,
          tabId: el.dataset.tabId
        }));
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        div.querySelectorAll('.saved-tab').forEach(s => s.classList.remove('drop-before', 'drop-after'));
      });

      // saved-tab 内部排序（同分组内）
      el.addEventListener('dragover', (e) => {
        const savedData = e.dataTransfer.types.includes('application/saved-tab');
        if (!savedData) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = el.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        el.classList.toggle('drop-before', before);
        el.classList.toggle('drop-after', !before);
      });
      el.addEventListener('dragleave', () => {
        el.classList.remove('drop-before', 'drop-after');
      });
      el.addEventListener('drop', (e) => {
        const savedData = e.dataTransfer.getData('application/saved-tab');
        if (!savedData) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          const data = JSON.parse(savedData);
          const rect = el.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          if (data.fromGroupId === group.id) {
            // 同组内排序
            reorderSavedTab(group.id, data.tabId, el.dataset.tabId, before);
          } else {
            // 跨组移动到指定位置
            moveSavedTab(data.fromGroupId, data.tabId, group.id, el.dataset.tabId, before);
          }
        } catch {}
        el.classList.remove('drop-before', 'drop-after');
      });
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

// ---- Drag & Drop reorder ----
function reorderGroup(fromIdx, toIdx, before) {
  if (fromIdx === toIdx) return;
  const [moved] = state.groups.splice(fromIdx, 1);
  // 删除后 toIdx 可能需要调整
  let target = toIdx;
  if (fromIdx < toIdx) target -= 1;
  if (!before) target += 1;
  target = Math.max(0, Math.min(state.groups.length, target));
  state.groups.splice(target, 0, moved);
  markGroupUpdated(moved);
  saveData();
  renderGroups();
}

function reorderSavedTab(groupId, fromTabId, toTabId, before) {
  if (fromTabId === toTabId) return;
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  const fromIdx = group.savedTabs.findIndex(t => t.id === fromTabId);
  const toIdx = group.savedTabs.findIndex(t => t.id === toTabId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = group.savedTabs.splice(fromIdx, 1);
  let target = toIdx;
  if (fromIdx < toIdx) target -= 1;
  if (!before) target += 1;
  target = Math.max(0, Math.min(group.savedTabs.length, target));
  moved.updatedAt = Date.now();
  group.savedTabs.splice(target, 0, moved);
  markGroupUpdated(group);
  saveData();
  renderGroups();
}

function moveSavedTab(fromGroupId, tabId, toGroupId, beforeTabId = null, before = true) {
  if (fromGroupId === toGroupId && !beforeTabId) return;
  const fromGroup = state.groups.find(g => g.id === fromGroupId);
  const toGroup = state.groups.find(g => g.id === toGroupId);
  if (!fromGroup || !toGroup) return;
  const fromIdx = fromGroup.savedTabs.findIndex(t => t.id === tabId);
  if (fromIdx < 0) return;
  const [moved] = fromGroup.savedTabs.splice(fromIdx, 1);
  // URL 去重：目标分组里若已有相同 URL，先移除（避免重复）
  toGroup.savedTabs = toGroup.savedTabs.filter(t => t.url !== moved.url);
  moved.updatedAt = Date.now();
  if (beforeTabId) {
    const insertAt = toGroup.savedTabs.findIndex(t => t.id === beforeTabId);
    if (insertAt < 0) toGroup.savedTabs.push(moved);
    else toGroup.savedTabs.splice(before ? insertAt : insertAt + 1, 0, moved);
  } else {
    toGroup.savedTabs.push(moved);
  }
  markGroupUpdated(fromGroup);
  markGroupUpdated(toGroup);
  saveData();
  renderGroups();
}

// ---- Group Operations ----
function createGroup(name) {
  const group = {
    id: newGroupId(),
    name,
    color: COLORS[state.groups.length % COLORS.length],
    collapsed: false,
    savedTabs: [],
    updatedAt: Date.now()
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
    if (val) {
      group.name = val;
      markGroupUpdated(group);
    }
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
    source: 'bookmark',
    updatedAt: Date.now()
  });
  markGroupUpdated(group);
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
      source: 'hibernate',
      updatedAt: Date.now()
    });
  }
  markGroupUpdated(group);
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
  markGroupUpdated(group);
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
        source: 'bookmark',
        updatedAt: Date.now()
      });
    }
  });
  markGroupUpdated(group);
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
        source: 'hibernate',
        updatedAt: Date.now()
      });
    }
  });
  markGroupUpdated(group);
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

function exportData() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    groups: state.groups
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tab-manager-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  const groups = Array.isArray(payload) ? payload : payload.groups;
  if (!Array.isArray(groups)) throw new Error('无效的备份文件');
  state.groups = normalizeGroups(groups);
  await chrome.storage.local.set({ groups: state.groups });
  if (state.syncEnabled) await syncPush();
  await renderAll();
}

async function consumePendingContextSave() {
  const { pendingContextSave } = await chrome.storage.local.get('pendingContextSave');
  if (!pendingContextSave) return;
  await chrome.storage.local.remove('pendingContextSave');
  showNewGroupForm((gid) => addTabToGroup(gid, pendingContextSave.url, pendingContextSave.title, pendingContextSave.favIconUrl));
}

document.getElementById('btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = document.getElementById('settings-panel');
  panel.classList.toggle('hidden');
  updateQuotaDisplay();
});

document.getElementById('toggle-sync').addEventListener('change', async (e) => {
  state.syncEnabled = e.target.checked;
  await chrome.storage.local.set({ syncEnabled: state.syncEnabled });
  if (state.syncEnabled) {
    await syncPush();
    await syncPull();
    await updateQuotaDisplay();
  } else {
    await chrome.storage.sync.clear();
    await updateQuotaDisplay();
  }
});

document.getElementById('btn-export-data').addEventListener('click', exportData);
document.getElementById('btn-import-data').addEventListener('click', () => {
  document.getElementById('import-data-input').click();
});
document.getElementById('import-data-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await importData(file);
    alert('导入成功');
  } catch (err) {
    alert('导入失败：' + err.message);
  } finally {
    e.target.value = '';
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#group-picker')) hidePicker();
  if (!e.target.closest('#new-group-form') && !e.target.closest('#btn-new-group')) hideNewGroupForm();
  if (!e.target.closest('#settings-panel') && !e.target.closest('#btn-settings')) {
    document.getElementById('settings-panel').classList.add('hidden');
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TABS_CHANGED') getActiveTabs().then(renderActiveTabs);
  if (msg.type === 'PENDING_SAVE_NEW_GROUP') {
    chrome.storage.local.remove('pendingContextSave');
    const tab = msg.tab;
    showNewGroupForm((gid) => addTabToGroup(gid, tab.url, tab.title, tab.favIconUrl));
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.groups) {
    state.groups = normalizeGroups(changes.groups.newValue || []);
    renderGroups();
  }
  if (area === 'sync' && state.syncEnabled) {
    const recentlyPushed = Date.now() - lastSyncPushAt < 2000;
    if (!recentlyPushed) syncPull();
  }
});

loadData().then(async () => {
  document.getElementById('toggle-sync').checked = state.syncEnabled;
  updateQuotaDisplay();
  await renderAll();
  consumePendingContextSave();
});
