/**
 * Client half of dsh-ai-session-rename.
 *
 * Adds "Rename from conversation" to the sidebar Session context menu. The
 * Host generates the title; this half applies it through the built-in
 * Session rename path so the sidebar title updates like a manual rename.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-session-rename',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'ai-session-rename'

    /** Menu glyph: a large four-point sparkle with a small one, i.e. "generated", never the built-in pencil. */
    const ICON_KEY = 'ai-session-rename.menu'

    function MenuIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: '1em', height: '1em', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M8 1.4 L9.6 6.4 L14.6 8 L9.6 9.6 L8 14.6 L6.4 9.6 L1.4 8 L6.4 6.4 Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M12.6 11.6 l0.75 1.85 1.85 0.75 -1.85 0.75 -0.75 1.85 -0.75 -1.85 -1.85 -0.75 1.85 -0.75 Z',
          fill: 'currentColor',
        }))
    }

    const zh = {
      'menu.renameFromConversation': '根据对话重新命名',
      'notice.generating': '正在根据对话生成标题…',
      'notice.renamed': '已重命名为「{title}」',
      'failure.generate': '生成标题失败',
      'failure.rename': '重命名失败，会话可能已被关闭',
    }

    const en = {
      'menu.renameFromConversation': 'Rename from conversation',
      'notice.generating': 'Generating a title from the conversation…',
      'notice.renamed': 'Renamed to "{title}"',
      'failure.generate': 'Could not generate a title',
      'failure.rename': 'Rename failed; the session may have been closed',
    }

    const ROUTE = 'api/ai-session-rename'

    /** Ask the Host half for a title; it owns the model call, prompt, and limits. */
    async function requestTitle(sessionId) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        const message = payload?.error?.message
        throw new Error(typeof message === 'string' && message.length > 0 ? message : `HTTP ${response.status}`)
      }
      const title = payload?.title
      if (typeof title !== 'string' || title.length === 0) throw new Error('the host returned no title')
      return title
    }

    return {
      inject: ['locale', 'contextMenus', 'sessions', 'slots'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: locale`)

        ctx.effect(() => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, MenuIcon)), `${NS}: menu icon`)

        const t = ctx.locale.bind(NS)

        /**
         * Apply an already-generated title through the Session's own rename
         * face. `SessionFace.rename` routes through `remote.session.rename`,
         * which pins the accepted title and refreshes the title projection, so
         * the sidebar row updates without a second notification path.
         */
        async function applyTitle(sessionId, title) {
          await ctx.sessions.using(sessionId, { source: 'aiSessionRename' }, async reference => {
            const result = await reference.binding.session.rename(title)
            if (!result.ok) throw new Error(result.error.message)
          })
        }

        /** Report one failed step with its own cause, never a generic message. */
        function reportFailure(summary, error) {
          const detail = error instanceof Error ? error.message : String(error)
          ctx.contextMenus.notify(`${summary} — ${detail}`)
        }

        ctx.effect(() => ctx.contextMenus.register({
          id: 'session.ai-rename',
          target: 'session',
          order: 210,
          resolve(target) {
            const sessionId = target.sessionId
            return [{
              id: 'rename-from-conversation',
              label: t('menu.renameFromConversation'),
              icon: { key: ICON_KEY },
              failureLabel: t('failure.rename'),
              async run() {
                ctx.contextMenus.notify(t('notice.generating'))
                let title
                try {
                  title = await requestTitle(sessionId)
                } catch (error) {
                  reportFailure(t('failure.generate'), error)
                  return
                }
                try {
                  await applyTitle(sessionId, title)
                } catch (error) {
                  reportFailure(t('failure.rename'), error)
                  return
                }
                ctx.contextMenus.notify(t('notice.renamed', { title }), true)
              },
            }]
          },
        }), `${NS}: session menu`)
      },
    }
  },
})
