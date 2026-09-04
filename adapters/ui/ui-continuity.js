// SPDX-License-Identifier: AGPL-3.0-only
// Risu BG Bridge browser companion. No network, storage, model, or trigger writes.
// Loaded by one opt-in host bootstrap; enabled only by a mainDom-authorized plugin.
(() => {
  'use strict';
  const HOST = 'x-risu-bg-ui-host';
  const ENABLE = 'x-risu-bg-ui-enabled';
  const ROOT = '.risu-chat[data-chat-index]';
  const SURFACE = '.x-risu-th-side-wrap,.x-risu-th-spell-wrap';
  if (document.documentElement.hasAttribute(HOST)) return;
  document.documentElement.setAttribute(HOST, '1');
  let active = null;
  let serial = 0;

  function enabled() {
    return document.documentElement.getAttribute(ENABLE) === 'thgy-v1';
  }
  function fingerprint(root) {
    // A message ID is mandatory if the whole message root is replaced.
    return root.getAttribute('data-chat-id') || '';
  }
  function currentRoot(job) {
    if (job.root.isConnected) return job.root;
    if (!job.messageId) return null;
    return [...document.querySelectorAll(ROOT)].find(root =>
      root.getAttribute('data-chat-id') === job.messageId &&
      root.getAttribute('data-chat-index') === job.index) || null;
  }
  function pathFrom(root, node) {
    const path = [];
    while (node !== root) {
      if (!node.parentElement) return null;
      path.unshift([...node.parentElement.children].indexOf(node));
      node = node.parentElement;
    }
    return path;
  }
  function atPath(root, path) {
    for (const index of path) root = root?.children[index];
    return root || null;
  }
  function scrollable(node) {
    const style = getComputedStyle(node);
    return /(auto|scroll|overlay)/.test(style.overflow + style.overflowX + style.overflowY) &&
      (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1);
  }
  function resolve(job, saved) {
    if (saved.node.isConnected) return saved.node;
    const root = currentRoot(job);
    if (!root || saved.path === null) return null;
    const node = atPath(root, saved.path);
    // Never apply stale child offsets to a structurally different element.
    return node?.tagName === saved.tag && node.className === saved.className ? node : null;
  }
  function stop(reason) {
    const job = active;
    if (!job) return;
    active = null;
    cancelAnimationFrame(job.frame);
    clearTimeout(job.timer);
    job.observer.disconnect();
    document.documentElement.setAttribute('x-risu-bg-ui-last-result', reason);
  }
  function attempt(job) {
    if (active !== job) return;
    if (!enabled()) return stop('disabled');
    if (performance.now() > job.deadline) return stop('timeout');
    const root = currentRoot(job);
    if (!root) return;
    if (!job.root.isConnected || job.positions.some(saved => !saved.node.isConnected)) job.mutated = true;
    // A new nonempty message ID means navigation, not a render of this message.
    if (fingerprint(root) !== job.messageId) return stop('identity-changed');
    let ready = true;
    let changed = false;
    for (const saved of job.positions) {
      const node = resolve(job, saved);
      if (!node) { ready = false; continue; }
      const maxY = node.scrollHeight - node.clientHeight;
      const maxX = node.scrollWidth - node.clientWidth;
      // Do not clamp the desired position to a temporary empty/loading layout.
      if (maxY + 1 < Math.abs(saved.top) || maxX + 1 < Math.abs(saved.left)) {
        ready = false; continue;
      }
      if (Math.abs(node.scrollTop - saved.top) > 1 || Math.abs(node.scrollLeft - saved.left) > 1) {
        // Direct assignments are instantaneous unless the theme requests smooth scrolling.
        const value = node.style.getPropertyValue('scroll-behavior');
        const priority = node.style.getPropertyPriority('scroll-behavior');
        node.style.setProperty('scroll-behavior', 'auto', 'important');
        node.scrollTop = saved.top;
        node.scrollLeft = saved.left;
        if (value) node.style.setProperty('scroll-behavior', value, priority);
        else node.style.removeProperty('scroll-behavior');
        changed = true;
      }
      if (Math.abs(node.scrollTop - saved.top) > 1 || Math.abs(node.scrollLeft - saved.left) > 1) ready = false;
    }
    if (changed) job.restored = true;
    if (ready && job.mutated) {
      if (!job.stableSince) job.stableSince = performance.now();
      if (performance.now() - job.stableSince > 600) stop(job.restored ? 'restored' : 'unchanged');
    } else job.stableSince = 0;
  }
  function schedule(job) {
    if (active !== job || job.frame) return;
    job.frame = requestAnimationFrame(() => {
      job.frame = 0;
      attempt(job);
      if (active === job) schedule(job);
    });
  }
  function begin(event) {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('[risu-trigger],[risu-btn]');
    if (!enabled() || !button?.closest(SURFACE)) return stop('other-interaction');
    const action = button.getAttribute('risu-trigger') || button.getAttribute('risu-btn') || '';
    // AUX reroll/model generation is outside this UI-only guard.
    if (/reroll|generate|sendChat/i.test(action)) return stop('non-ui-action');
    const root = button.closest(ROOT);
    if (!root) return;
    const positions = [];
    for (let node = button.parentElement; node; node = node.parentElement) {
      if (node.closest(SURFACE)) continue; // Tab content may intentionally start at its own top.
      if (!scrollable(node)) continue;
      positions.push({ node, path: root.contains(node) ? pathFrom(root, node) : null,
        tag: node.tagName, className: node.className, top: node.scrollTop, left: node.scrollLeft });
    }
    const page = document.scrollingElement;
    if (page && !positions.some(p => p.node === page)) positions.push({
      node: page, path: null, tag: page.tagName, className: page.className,
      top: page.scrollTop, left: page.scrollLeft,
    });
    stop('superseded');
    const job = { id: ++serial, root, positions, index: root.getAttribute('data-chat-index'),
      messageId: fingerprint(root), deadline: performance.now() + 10000, frame: 0,
      restored: false, mutated: false, stableSince: 0, observer: null, timer: null };
    active = job;
    job.observer = new MutationObserver(records => {
      if (records.some(record => record.type === 'childList')) {
        job.mutated = true; job.stableSince = 0; schedule(job);
      }
    });
    // Observe only during a UI transaction. No idle document-wide scan/poll.
    job.observer.observe(root.parentElement || root, { childList: true, subtree: true });
    job.timer = setTimeout(() => { if (active === job) stop('timeout'); }, 10100);
    schedule(job);
  }
  // Capture before the app's asynchronous Lua handler can replace any DOM.
  document.addEventListener('click', begin, true);
  for (const type of ['wheel', 'touchmove', 'pointerdown']) {
    document.addEventListener(type, () => stop('user-input'), { capture: true, passive: true });
  }
  document.addEventListener('keydown', event => {
    if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) stop('user-input');
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop('hidden'); });
  window.addEventListener('pagehide', () => stop('pagehide'));
})();
