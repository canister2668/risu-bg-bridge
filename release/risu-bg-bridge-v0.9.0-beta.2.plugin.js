//@name risu_bg_bridge
//@api 3.0
//@version 0.9.0.2
//@update-url https://raw.githubusercontent.com/canister2668/risu-bg-bridge/refs/heads/main/plugin/risu-bg-bridge.plugin.js
//@link https://github.com/canister2668/risu-bg-bridge Risu BG Bridge documentation and releases
//@display-name Risu Background Bridge
//@description Durable server-model provider and background-job monitor for compatible RisuAI hosts
//@arg credential_ref string Server credential reference, for example provider-account://openai/default
//@arg model string Server model identifier
//@arg fallback_model string Stock RisuAI foreground fallback model identifier

(async () => {
  'use strict';

  const PLUGIN_VERSION = '0.9.0-beta.2';
  const UPDATE_VERSION = '0.9.0.2';
  const UPDATE_URL = 'https://raw.githubusercontent.com/canister2668/risu-bg-bridge/refs/heads/main/plugin/risu-bg-bridge.plugin.js';
  const RELEASES_URL = 'https://github.com/canister2668/risu-bg-bridge/releases';
  const ADAPTERS_URL = 'https://github.com/canister2668/risu-bg-bridge/tree/main/adapters';
  const TERMINAL = new Set(['succeeded', 'completed', 'failed', 'cancelled', 'ambiguous']);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  function textFromProviderPayload(raw) {
    const source = String(raw ?? '');
    const fragments = [];
    for (const line of source.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const value = json?.choices?.[0]?.delta?.content
          ?? json?.choices?.[0]?.message?.content
          ?? json?.content?.[0]?.text;
        if (typeof value === 'string') fragments.push(value);
      } catch { /* retain JSON/non-SSE fallback below */ }
    }
    if (fragments.length) return fragments.join('');
    try {
      const json = JSON.parse(source);
      const value = json?.choices?.[0]?.message?.content
        ?? json?.choices?.[0]?.text
        ?? json?.content?.[0]?.text
        ?? json?.content
        ?? json?.text;
      if (typeof value === 'string') return value;
    } catch { /* plain text provider */ }
    return source;
  }

  function compareUpdateVersions(left, right) {
    const a = String(left).split('.').map(Number);
    const b = String(right).split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const av = a[index] || 0;
      const bv = b[index] || 0;
      if (av !== bv) return av > bv ? 1 : -1;
    }
    return 0;
  }

  async function checkUpdate() {
    try {
      const response = await Risuai.nativeFetch(UPDATE_URL, {
        method: 'GET',
        headers: { Range: 'bytes=0-511' },
        cache: 'no-store',
      });
      if (!response || response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
      }
      const source = await response.text();
      const remoteVersion = source.match(/\/\/@version\s+([^\s]+)/)?.[1]?.trim();
      if (!remoteVersion) throw new Error('remote version metadata missing');
      return {
        state: compareUpdateVersions(remoteVersion, UPDATE_VERSION) > 0 ? 'available' : 'current',
        remoteVersion,
      };
    } catch (error) {
      return { state: 'unknown', error: String(error?.message ?? error) };
    }
  }

  function assessHost(caps) {
    if (!caps?.features) {
      return {
        state: 'patch',
        title: 'Core bridge not detected',
        detail: 'Install the matching host adapter for tab-close durability. Stock RisuAI can use fallback_model in foreground mode.',
      };
    }
    if (!caps.features.tabCloseDurable) {
      return {
        state: 'patch',
        title: 'Core patch required',
        detail: `${caps.adapter?.target || 'This host'} does not advertise tab-close durable jobs. Apply only the adapter matching the exact host version.`,
      };
    }
    if (!caps.features.pluginJobCreation || !caps.features.serverProviders) {
      return {
        state: 'config',
        title: 'Core bridge detected · setup required',
        detail: 'Durable core support is present, but plugin job creation is disabled. Configure the server provider registry and its secret environment variable.',
      };
    }
    return {
      state: 'ready',
      title: 'Core bridge ready',
      detail: 'Plugin-created durable jobs and server-side provider references are available.',
    };
  }

  async function capabilities() {
    const api = Risuai.backgroundModels;
    if (!api || typeof api.getCapabilities !== 'function') return null;
    try {
      const value = await api.getCapabilities();
      return value?.contractVersion === 1 && value?.features ? value : null;
    } catch {
      return null;
    }
  }

  function normalizeForeground(raw) {
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object') {
      for (const key of ['result', 'content', 'text']) {
        if (typeof raw[key] === 'string') return raw[key];
      }
    }
    throw new Error('runLLMModel returned an unsupported result shape');
  }

  async function foregroundFallback(args) {
    const fallbackModel = String(await Risuai.getArgument('fallback_model') ?? '').trim();
    if (!fallbackModel) {
      throw new Error('This host has no configured server provider; set fallback_model for foreground-only use.');
    }
    return normalizeForeground(await Risuai.runLLMModel({
      messages: args.prompt_chat,
      staticModel: fallbackModel,
      mode: args.mode || 'otherAx',
      allowPlugins: false,
    }));
  }

  async function currentIdentity() {
    const characterIndex = await Risuai.getCurrentCharacterIndex();
    const chatIndex = await Risuai.getCurrentChatIndex();
    const character = await Risuai.getCharacter();
    const chat = characterIndex >= 0 && chatIndex >= 0
      ? await Risuai.getChatFromIndex(characterIndex, chatIndex)
      : null;
    return {
      chatId: String(chat?.id ?? chat?.chatId ?? `plugin-chat-${characterIndex}-${chatIndex}`),
      characterId: String(character?.chaId ?? character?.id ?? characterIndex),
    };
  }

  async function waitForResult(jobId, abortSignal) {
    while (true) {
      if (abortSignal?.aborted) {
        await Risuai.backgroundModels.cancelJob(jobId, 'Plugin provider aborted');
        throw new DOMException('Aborted', 'AbortError');
      }
      const snapshot = await Risuai.backgroundModels.getJob(jobId);
      if (snapshot?.error) throw new Error(snapshot.error);
      if (TERMINAL.has(snapshot?.state)) {
        if (snapshot.state !== 'succeeded' && snapshot.state !== 'completed') {
          throw new Error(snapshot.error || `Background job ended as ${snapshot.state}`);
        }
        const result = await Risuai.backgroundModels.readResult(jobId);
        if (result?.error) throw new Error(result.error);
        if (typeof result?.payload !== 'string') {
          throw new Error('Host returned a result receipt without its durable payload');
        }
        if (snapshot.kind === 'aux' && result.resultHash) {
          await Risuai.backgroundModels.ackResult(jobId, `risu-bg-bridge/${PLUGIN_VERSION}`, result.resultHash);
        }
        return textFromProviderPayload(result.payload);
      }
      await sleep(350);
    }
  }

  await Risuai.addProvider('Risu BG Server', async (args, abortSignal) => {
    const caps = await capabilities();
    if (!caps?.features?.pluginJobCreation || !caps?.features?.serverProviders) {
      try {
        return { success: true, content: await foregroundFallback(args) };
      } catch (error) {
        return { success: false, content: String(error?.message ?? error) };
      }
    }
    const credentialRef = String(await Risuai.getArgument('credential_ref') ?? '').trim();
    const model = String(await Risuai.getArgument('model') ?? '').trim();
    if (!credentialRef) {
      return { success: false, content: 'Set credential_ref in the Risu Background Bridge plugin settings.' };
    }
    const identity = await currentIdentity();
    const generationId = crypto.randomUUID();
    const auxModes = new Set(['otherAx', 'emotion', 'memory', 'translate']);
    const body = JSON.stringify({
      model: model || undefined,
      messages: args.prompt_chat,
      temperature: Number(args.temperature ?? 100) / 100,
      max_tokens: args.max_tokens,
      top_p: Number(args.top_p ?? 100) / 100,
      frequency_penalty: Number(args.frequency_penalty ?? 0) / 100,
      presence_penalty: Number(args.presence_penalty ?? 0) / 100,
      stream: false,
    });
    try {
      const created = await Risuai.backgroundModels.createJob({
        clientJobId: generationId,
        credentialRef,
        body,
        chatId: identity.chatId,
        characterId: identity.characterId,
        generationId,
        protocol: 'openai',
        model: model || undefined,
        kind: auxModes.has(args.mode) ? 'aux' : 'main',
        streaming: false,
        recoverable: true,
      });
      if (created?.error || !created?.jobId) throw new Error(created?.error || 'Host did not return a job id');
      return { success: true, content: await waitForResult(created.jobId, abortSignal) };
    } catch (error) {
      return { success: false, content: String(error?.message ?? error) };
    }
  });

  async function renderDashboard() {
    const [caps, update] = await Promise.all([capabilities(), checkUpdate()]);
    const host = assessHost(caps);
    const jobs = caps ? [
      ...(await Risuai.backgroundModels.listJobs({ active: true })),
      ...(await Risuai.backgroundModels.listJobs({ unclaimed: true })),
    ] : [];
    const unique = [...new Map(jobs.map((job) => [job.jobId, job])).values()];
    document.body.innerHTML = `
      <style>
        body{margin:0;padding:18px;background:#15151b;color:#eee;font:14px system-ui,sans-serif}
        h2{margin:0 0 12px}.card{padding:12px;margin:8px 0;border:1px solid #3a3a48;border-radius:10px;background:#20202a}
        .muted{color:#aaa}.ok{color:#7ee787}.warn{color:#e3b341}.bad{color:#ff7b72}.badge{float:right;font-weight:700}
        button,.action{display:inline-block;padding:8px 12px;margin:6px;border:0;border-radius:8px;cursor:pointer;background:#343445;color:#fff;text-decoration:none}
        code{overflow-wrap:anywhere}
      </style>
      <h2>Risu Background Bridge ${PLUGIN_VERSION}</h2>
      <div class="card ${update.state === 'available' ? 'warn' : update.state === 'current' ? 'ok' : 'muted'}">
        <span class="badge">${update.state === 'available' ? 'UPDATE' : update.state === 'current' ? 'CURRENT' : 'UNKNOWN'}</span>
        <b>Plugin update</b><br>
        ${update.state === 'available'
          ? `Version ${escapeHtml(update.remoteVersion)} is available. Use RisuAI Settings → Plugins to confirm the native update.`
          : update.state === 'current'
            ? `Updater ${UPDATE_VERSION} is current.`
            : `Update check unavailable: ${escapeHtml(update.error)}`}
        <br><a class="action" href="${RELEASES_URL}" target="_blank" rel="noopener noreferrer">Open releases</a>
      </div>
      <div class="card ${host.state === 'ready' ? 'ok' : host.state === 'config' ? 'warn' : 'bad'}">
        <span class="badge">${host.state === 'ready' ? 'READY' : host.state === 'config' ? 'SETUP' : 'PATCH'}</span>
        <b>${escapeHtml(host.title)}</b><br>${escapeHtml(host.detail)}<br>
        ${caps ? `<span class="muted">${escapeHtml(caps.adapter?.target)} ${escapeHtml(caps.adapter?.version)} · durable ${caps.features.tabCloseDurable ? 'ON' : 'OFF'}</span><br>` : ''}
        ${host.state !== 'ready' ? `<a class="action" href="${ADAPTERS_URL}" target="_blank" rel="noopener noreferrer">Open adapter guide</a>` : ''}
      </div>
      ${unique.length ? unique.map((job) => `<div class="card"><b>${escapeHtml(job.kind)} · ${escapeHtml(job.state)}</b><br><code>${escapeHtml(job.jobId)}</code><br><span class="muted">${escapeHtml(job.updatedAt)}</span></div>`).join('') : '<div class="card muted">No active or unclaimed jobs.</div>'}
      <button id="refresh">Refresh</button><button id="close">Close</button>`;
    document.getElementById('refresh').onclick = () => void renderDashboard();
    document.getElementById('close').onclick = () => void Risuai.hideContainer();
  }

  await Risuai.registerSetting('Risu Background Bridge', async () => {
    await renderDashboard();
    await Risuai.showContainer('fullscreen');
  }, '🔄', 'none');
})();
