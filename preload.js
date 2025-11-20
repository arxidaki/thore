const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  versions: process.versions
});
