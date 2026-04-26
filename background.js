chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

const tabEvents = ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onActivated'];
tabEvents.forEach(event => {
  chrome.tabs[event].addListener(() => {
    chrome.runtime.sendMessage({ type: 'TABS_CHANGED' }).catch(() => {});
  });
});
