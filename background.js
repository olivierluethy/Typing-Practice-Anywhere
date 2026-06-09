// Toggle the typing-practice mode on the active tab when the toolbar icon is clicked.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TP_TOGGLE" });
  } catch (e) {
    // Content script may not be injected on this page (e.g. chrome:// URLs)
    // Try injecting it on-demand for pages where it didn't auto-inject.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "TP_TOGGLE" });
    } catch (err) {
      console.warn("Typing Practice: cannot run on this page.", err);
    }
  }
});
