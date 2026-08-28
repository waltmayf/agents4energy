/**
 * Frontend — src/index.ts
 *
 * Spike #514, criterion 2: minimal UI proving typed RPC reaches the frontend
 * with no codegen — `api.listAgents()` etc. are typed straight from
 * aws-blocks/index.ts's return types.
 */
import { api, authApi } from 'aws-blocks';
import { AccountMenuBar, AuthenticatedContent } from '@aws-blocks/blocks/ui';
import { html, render } from 'lit-html';

const menuBarEl = document.getElementById('menu-bar')!;
menuBarEl.appendChild(AccountMenuBar(authApi));

const signInMessage = document.createElement('p');
signInMessage.textContent = 'Sign in to get started.';

document.getElementById('app')!.appendChild(
  AuthenticatedContent(authApi, (user) => {
    const container = document.createElement('div');

    async function load() {
      const [agentList, mcpServerList] = await Promise.all([
        api.listAgents(),
        api.listMcpServers(),
      ]);
      redraw(agentList, mcpServerList);
    }

    function redraw(
      agentList: Awaited<ReturnType<typeof api.listAgents>>,
      mcpServerList: Awaited<ReturnType<typeof api.listMcpServers>>,
    ) {
      render(html`
        <h2>Agents</h2>
        <div style="margin-bottom:12px;display:flex;gap:4px;align-items:center;flex-wrap:wrap">
          <input id="new-name" type="text" placeholder="Agent name" />
          <input id="new-slug" type="text" placeholder="agent-slug" />
          <button @click=${addAgent}>Create</button>
        </div>
        <ul>
          ${agentList.map(a => html`<li>${a.name} (${a.slug})</li>`)}
        </ul>
        <h2>MCP Servers</h2>
        <ul>
          ${mcpServerList.map(m => html`<li>${m.name} — ${m.url}</li>`)}
        </ul>
      `, container);
    }

    async function addAgent() {
      const nameEl = container.querySelector('#new-name') as HTMLInputElement;
      const slugEl = container.querySelector('#new-slug') as HTMLInputElement;
      const name = nameEl.value.trim();
      const slug = slugEl.value.trim();
      if (!name || !slug) return;
      await api.createAgent({ name, slug });
      nameEl.value = '';
      slugEl.value = '';
      await load();
    }

    load();
    return container;
  }, signInMessage)
);
