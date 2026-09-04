//@name risu_bg_ui_continuity
//@api 3.0
//@version 1.0.0
//@display-name Risu BG Bridge · UI Continuity
//@description Optional Touhou UI scroll restoration; requires the UI host bootstrap
//@update-url https://raw.githubusercontent.com/canister2668/risu-bg-bridge/refs/heads/main/plugin/risu-bg-ui-continuity.plugin.js
//@link https://github.com/canister2668/risu-bg-bridge Corresponding source (AGPL-3.0)
// SPDX-License-Identifier: AGPL-3.0-only
(async () => {
  'use strict';
  const KEY = 'ui_continuity_enabled';
  let root = null;
  let enabled = (await Risuai.pluginStorage.getItem(KEY)) === '1';
  async function apply() {
    if (!root) {
      const doc = await Risuai.getRootDocument(); // Explicit host mainDom permission.
      if (!doc) throw new Error('Main DOM permission was not granted.');
      root = await doc.querySelector('html');
    }
    const version = await root.getAttribute('x-risu-bg-ui-host');
    if (version !== '1') throw new Error('UI host bootstrap v1 is not installed. No core or bot was changed.');
    await root.setAttribute('x-risu-bg-ui-enabled', enabled ? 'thgy-v1' : 'off');
  }
  await Risuai.onUnload(async () => {
    if (root) await root.setAttribute('x-risu-bg-ui-enabled', 'off');
  });
  await Risuai.registerSetting('BG Bridge · UI Continuity', async () => {
    document.body.innerHTML = '<h2>BG Bridge · UI Continuity</h2><p>동방 사이드바·스펠 UI의 스크롤 위치 복원. 생성/Aux 리롤/이펙트는 수정하지 않습니다. 카드 재생성에 따른 깜빡임 제거는 별도 작업입니다.</p><button id="toggle"></button><p id="status"></p><a href="https://github.com/canister2668/risu-bg-bridge" target="_blank" rel="noopener noreferrer">Corresponding source · AGPL-3.0</a><button id="close">Close</button>';
    const button = document.getElementById('toggle');
    const label = () => { button.textContent = enabled ? 'Disable / 끄기' : 'Enable / 켜기'; };
    label();
    button.onclick = async () => {
      const previous = enabled;
      try {
        enabled = !enabled;
        await apply();
        await Risuai.pluginStorage.setItem(KEY, enabled ? '1' : '0');
        document.getElementById('status').textContent = enabled ? 'Enabled for Touhou UI only.' : 'Disabled.';
      } catch (error) {
        enabled = previous;
        if (root) await root.setAttribute('x-risu-bg-ui-enabled', enabled ? 'thgy-v1' : 'off');
        document.getElementById('status').textContent = String(error.message || error);
      }
      label();
    };
    document.getElementById('close').onclick = () => Risuai.hideContainer();
    await Risuai.showContainer('fullscreen');
  }, '↕', 'none');
  if (enabled) {
    try { await apply(); } catch (error) { console.warn('[BG UI Continuity]', error.message); }
  }
})();
