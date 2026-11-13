// MV3 service worker: context menu + keyboard command → send page selection to Posty.
importScripts('shared.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'posty-send-selection',
    title: 'Send to Posty Ideas',
    contexts: ['selection'],
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function selectionFromTab(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => String(window.getSelection()?.toString() || '').trim(),
    });
    return result?.result || '';
  } catch {
    return '';
  }
}

async function captureFromTab(tab) {
  if (!tab?.id) throw new Error('No active tab.');
  const text = await selectionFromTab(tab.id);
  if (!text) throw new Error('Select some text on the page first.');
  const title = tab.title && tab.title !== text ? tab.title : 'Browser highlight';
  await postyCapture({ title, text, url: tab.url || '' });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'posty-send-selection') return;
  try {
    if (info.selectionText) {
      await postyCapture({ title: tab?.title || 'Browser highlight', text: info.selectionText, url: tab?.url || '' });
    } else {
      await captureFromTab(tab);
    }
  } catch (err) {
    console.warn('[posty]', err.message);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-selection') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await captureFromTab(tab);
  } catch (err) {
    console.warn('[posty]', err.message);
  }
});
