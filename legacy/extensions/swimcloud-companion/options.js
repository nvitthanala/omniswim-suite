/**
 * Omniswim SwimCloud Companion — options page.
 *
 * One field for the pairing token (plus the app's port, in case it was
 * changed from the default 3000), stored in chrome.storage.local and read by
 * background.js on every relayed page. See options.html for the instruction
 * text pointing at the app's startup banner as the source of the token.
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'omniswimPairingToken';
  const PORT_KEY = 'omniswimAppPort';

  const tokenInput = document.getElementById('token');
  const portInput = document.getElementById('port');
  const saveButton = document.getElementById('save');
  const status = document.getElementById('status');

  function load() {
    chrome.storage.local.get([TOKEN_KEY, PORT_KEY], (stored) => {
      tokenInput.value = stored[TOKEN_KEY] || '';
      portInput.value = stored[PORT_KEY] || '3000';
    });
  }

  function save() {
    const token = tokenInput.value.trim();
    const port = Number(portInput.value) || 3000;
    chrome.storage.local.set({ [TOKEN_KEY]: token, [PORT_KEY]: port }, () => {
      status.textContent = 'Saved.';
      status.classList.add('saved');
      setTimeout(() => {
        status.textContent = '';
        status.classList.remove('saved');
      }, 2000);
    });
  }

  saveButton.addEventListener('click', save);
  load();
})();
