'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Only these channels are reachable from the UI.
const INVOKE = new Set([
  'sys:info', 'sys:systemFiles', 'sys:processes', 'sys:setTheme',
  'scan:start', 'scan:cancel',
  'clean:list', 'clean:estimate', 'clean:preview', 'clean:run', 'clean:cancel',
  'move:plan', 'move:run', 'move:list', 'move:finalize', 'move:undo',
  'dupes:defaults', 'dupes:start', 'dupes:cancel',
  'programs:list', 'programs:uninstall', 'programs:openSettings',
  'dupes:trash',
  'shell:reveal', 'shell:open', 'dialog:pickFolder',
  'ledger:list', 'ledger:export', 'ledger:undo',
  'admin:relaunch',
]);
const EVENTS = new Set(['scan:progress', 'scan:row', 'clean:log', 'move:step', 'move:log', 'move:progress', 'dupes:progress']);

contextBridge.exposeInMainWorld('reclaim', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error(`Blocked event ${channel}`);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
