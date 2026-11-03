import { createController } from './controller.js';

const controller = createController(chrome);
chrome.runtime.onStartup.addListener(() => { void chrome.action.setBadgeText({ text: '' }); });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  controller.handle(message, sender).then(
    result => sendResponse({ ok: true, ...result }),
    error => sendResponse({ ok: false, error: error.message || '操作失败，请重试' })
  );
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { controller.tabRemoved(tabId).catch(console.error); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) controller.navigated(tabId, change.url).catch(console.error);
});
