chrome.runtime.onInstalled.addListener(() => {
  //Set default storage values on first install
  chrome.storage.local.get(['tasks', 'minutesSaved', 'webeActive'], (data) => {
    const defaults = {};
    if (!data.tasks)         defaults.tasks = [];
    if (!data.minutesSaved)  defaults.minutesSaved = 0;
    if (data.webeActive === undefined) defaults.webeActive = true;

    if (Object.keys(defaults).length > 0) {
      chrome.storage.local.set(defaults);
    }
  });
});
