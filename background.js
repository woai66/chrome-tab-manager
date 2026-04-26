const MENU_ROOT = 'tm-root';

async function rebuildContextMenu() {
  await chrome.contextMenus.removeAll();
  const { groups = [], ctxPrefs = { closeAfter: false } } = await chrome.storage.local.get(['groups', 'ctxPrefs']);

  chrome.contextMenus.create({
    id: MENU_ROOT,
    title: '保存到 Tab Manager',
    contexts: ['page', 'link']
  });

  chrome.contextMenus.create({
    id: 'tm-toggle-close',
    parentId: MENU_ROOT,
    title: '保存后关闭标签',
    type: 'checkbox',
    checked: !!ctxPrefs.closeAfter,
    contexts: ['page', 'link']
  });

  chrome.contextMenus.create({
    id: 'tm-sep',
    parentId: MENU_ROOT,
    type: 'separator',
    contexts: ['page', 'link']
  });

  groups.forEach(group => {
    chrome.contextMenus.create({
      id: `tm-save-to-${group.id}`,
      parentId: MENU_ROOT,
      title: `● ${group.name}`,
      contexts: ['page', 'link']
    });
  });

  chrome.contextMenus.create({
    id: 'tm-save-new',
    parentId: MENU_ROOT,
    title: '+ 新建分组并保存',
    contexts: ['page', 'link']
  });
}

function newSavedTabId() {
  return 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

async function saveTabToGroupFromContext(info, tab, groupId) {
  const { groups = [], ctxPrefs = {} } = await chrome.storage.local.get(['groups', 'ctxPrefs']);
  const group = groups.find(g => g.id === groupId);
  if (!group) return;

  group.savedTabs = group.savedTabs || [];
  const url = info.linkUrl || tab.url;
  if (!url || group.savedTabs.some(t => t.url === url)) return;

  const now = Date.now();
  group.updatedAt = now;
  group.savedTabs.push({
    id: newSavedTabId(),
    title: tab.title || url,
    url,
    favicon: tab.favIconUrl || '',
    savedAt: now,
    source: 'context-menu',
    updatedAt: now
  });

  await chrome.storage.local.set({ groups });
  if (ctxPrefs.closeAfter && !info.linkUrl && tab.id) {
    await chrome.tabs.remove(tab.id);
  }
}

chrome.runtime.onInstalled.addListener(rebuildContextMenu);
chrome.runtime.onStartup.addListener(rebuildContextMenu);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.groups || changes.ctxPrefs)) {
    rebuildContextMenu();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'tm-toggle-close') {
    await chrome.storage.local.set({ ctxPrefs: { closeAfter: info.checked } });
    return;
  }

  if (info.menuItemId === 'tm-save-new') {
    const pending = {
      title: tab.title,
      url: info.linkUrl || tab.url,
      favIconUrl: tab.favIconUrl || '',
      createdAt: Date.now()
    };
    await chrome.storage.local.set({ pendingContextSave: pending });
    await chrome.sidePanel.open({ windowId: tab.windowId });
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'PENDING_SAVE_NEW_GROUP',
        tab: pending
      }).catch(() => {});
    }, 300);
    return;
  }

  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('tm-save-to-')) {
    await saveTabToGroupFromContext(info, tab, info.menuItemId.slice('tm-save-to-'.length));
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

const tabEvents = ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onActivated'];
tabEvents.forEach(event => {
  chrome.tabs[event].addListener(() => {
    chrome.runtime.sendMessage({ type: 'TABS_CHANGED' }).catch(() => {});
  });
});
