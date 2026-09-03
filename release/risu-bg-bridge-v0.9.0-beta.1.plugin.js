//@name risu_bg_bridge
//@api 3.0
//@version 0.9.0-beta.1
//@display-name Risu Background Bridge
//@description Durable server-model provider and background-job monitor for compatible RisuAI hosts
//@arg credential_ref string Server credential reference, for example provider-account://openai/default
//@arg model string Server model identifier
//@arg fallback_model string Stock RisuAI foreground fallback model identifier

(async () => {
  'use strict';

  const PLUGIN_VERSION = '0.9.0-beta.1';
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
    const caps = await capabilities();
    const jobs = caps ? [
      ...(await Risuai.backgroundModels.listJobs({ active: true })),
      ...(await Risuai.backgroundModels.listJobs({ unclaimed: true })),
    ] : [];
    const unique = [...new Map(jobs.map((job) => [job.jobId, job])).values()];
    document.body.innerHTML = `
      <style>
        body{margin:0;padding:18px;background:#15151b;color:#eee;font:14px system-ui,sans-serif}
        h2{margin:0 0 12px}.card{padding:12px;margin:8px 0;border:1px solid #3a3a48;border-radius:10px;background:#20202a}
        .muted{color:#aaa}.ok{color:#7ee787}.bad{color:#ff7b72}button{padding:8px 12px;margin:6px;border:0;border-radius:8px;cursor:pointer}
        code{overflow-wrap:anywhere}
      </style>
      <h2>Risu Background Bridge ${PLUGIN_VERSION}</h2>
      <div class="card ${caps?.features?.tabCloseDurable ? 'ok' : 'bad'}">
        ${caps ? `${escapeHtml(caps.adapter?.target)} ${escapeHtml(caps.adapter?.version)} · durable ${caps.features.tabCloseDurable ? 'ON' : 'OFF'}` : 'Compatible host bridge not found · foreground only'}
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
