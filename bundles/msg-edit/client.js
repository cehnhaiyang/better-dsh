/**
 * Browser half of msg-edit: edit the model's own output where it is displayed.
 *
 * Clicking the pencil replaces the reply's rendered body with an editable area
 * **in the document flow**. The editor is inserted in the same column, in the
 * same place, at the same width as the row it replaces 鈥?nothing floats, nothing
 * is positioned against the viewport, and it cannot leave the screen. The
 * replaced row is hidden with `display: none` so the editor takes its space, and
 * is restored on cancel, on save, and on unload.
 *
 * The editor is plain DOM rather than a React subtree on purpose: mounting it
 * inside a React-managed list would fight reconciliation, and a portal into the
 * row would put a second editable surface inside the node the Chat view owns.
 * Inserting an ordinary sibling element in the same parent is the one placement
 * that inherits the transcript's own width without any measurement.
 *
 * The transcript is corrected after saving by wrapping the registered Chat view
 * builder: an edited reply is rewritten in its `data.blocks` before the builder
 * sees it, so every renderer shows the replacement without knowing about this
 * plugin.
 *
 * @module dsh-msg-edit/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-msg-edit',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		const NS = 'msg-edit'
		/** Host route: GET reads decisions, POST records one. */
		const ROUTE = 'api/session.message'
		/** Assistant action row, declared by ui-chat. */
		const ACTIONS_SLOT = 'conversation.chat.assistant-actions'
		/** Chat view target the transcript overlay wraps. */
		const CHAT_TARGET = 'chat'
		/** The attribute the Chat view puts on every rendered row. */
		const ROW_ATTRIBUTE = 'data-chat-node-key'

		//#region styles
		/**
		 * Styles for the in-flow editor. Everything is expressed against the
		 * `--dsw-*` tokens plus `inherit`, so the editor looks like the text it
		 * replaces rather than like a form.
		 */
		const styles = {
			action: {
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				width: 22,
				height: 22,
				padding: 0,
				border: 'none',
				borderRadius: 6,
				background: 'transparent',
				color: 'var(--dsw-text-tertiary, #8a8a8a)',
				cursor: 'pointer',
				fontSize: 13,
				lineHeight: 1
			},
			/** The in-flow container: same width as the row it replaces, no positioning. */
			host: {
				display: 'flex',
				flexDirection: 'column',
				gap: 6,
				width: '100%',
				maxWidth: '100%',
				boxSizing: 'border-box'
			},
			/**
			 * The editable body: borderless, matched to the reply, and sized by its own
			 * content. No fixed height and no `overflow` clipping 鈥?the element grows
			 * with the text, so every line stays visible.
			 */
			area: {
				display: 'block',
				width: '100%',
				maxWidth: '100%',
				boxSizing: 'border-box',
				margin: 0,
				padding: 4,
				border: 'none',
				borderRadius: 6,
				outline: '2px solid var(--dsw-accent-default, #4d6bfe)',
				outlineOffset: -1,
				overflow: 'visible',
				whiteSpace: 'pre-wrap',
				overflowWrap: 'anywhere',
				wordBreak: 'break-word',
				background: 'var(--dsw-surface-raised, #fff)',
				color: 'inherit',
				font: 'inherit',
				lineHeight: 'inherit',
				letterSpacing: 'inherit'
			},
			bar: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'flex-end',
				gap: 6
			},
			hint: {
				marginRight: 'auto',
				fontSize: 11,
				color: 'var(--dsw-text-tertiary, #8a8a8a)'
			},
			error: {
				marginRight: 'auto',
				fontSize: 11,
				color: 'var(--dsw-danger-default, #d93f3f)'
			},
			button: {
				padding: '4px 12px',
				borderRadius: 6,
				border: '1px solid var(--dsw-border-default, rgba(0,0,0,0.14))',
				background: 'transparent',
				color: 'inherit',
				cursor: 'pointer',
				font: 'inherit',
				fontSize: 12
			},
			primary: { background: 'var(--dsw-accent-default, #4d6bfe)', borderColor: 'transparent', color: '#fff' },
			disabled: { opacity: 0.5, cursor: 'not-allowed' },
			toast: {
				position: 'fixed',
				left: '50%',
				bottom: 24,
				transform: 'translateX(-50%)',
				zIndex: 62,
				padding: '8px 16px',
				borderRadius: 999,
				background: 'var(--dsw-surface-raised, #fff)',
				boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
				color: 'var(--dsw-text-primary, #1a1a1a)',
				fontSize: 12
			}
		}

		/**
		 * Apply a style object to an element.
		 * @param {HTMLElement} element - the target.
		 * @param {object} style - camelCase declarations.
		 */
		function applyStyle(element, style) {
			for (const [property, value] of Object.entries(style)) Object.assign(element.style, { [property]: value })
		}
		//#endregion

		//#region dictionaries
		//#region dictionaries
		/** Locale dictionaries; `zh` is also the fallback for a key a locale omits. */
		const zh = {
			'action.edit': '编辑这条回复',
			'inline.save': '保存',
			'inline.cancel': '取消',
			'inline.saving': '保存中…',
			'inline.hint': '只改文字，工具调用保持原样',
			'notice.edited': '已更新模型上下文',
			'error.unreachable': '无法联系 DSH 服务',
			'error.notFound': '这条回复已不在对话中',
			'error.notEditable': '这条回复不能编辑',
			'error.tooLarge': '内容过长',
			'error.badRequest': '请求无效',
			'error.unavailable': '当前环境不支持该操作',
			'error.writeFailed': '保存失败',
			'error.unknown': '发生未知错误'
		}
		const en = {
			'action.edit': 'Edit this reply',
			'inline.save': 'Save',
			'inline.cancel': 'Cancel',
			'inline.saving': 'Saving…',
			'inline.hint': 'Text only; tool calls are kept',
			'notice.edited': 'Model context updated',
			'error.unreachable': 'Could not reach the DSH server',
			'error.notFound': 'This reply is no longer in the conversation',
			'error.notEditable': 'This reply cannot be edited',
			'error.tooLarge': 'The content is too large',
			'error.badRequest': 'The request was not valid',
			'error.unavailable': 'This environment does not support the operation',
			'error.writeFailed': 'The change could not be saved',
			'error.unknown': 'An unexpected error occurred'
		}
		const ja = {
			'action.edit': 'この返信を編集',
			'inline.save': '保存',
			'inline.cancel': 'キャンセル',
			'inline.saving': '保存中…',
			'inline.hint': 'テキストのみ。ツール呼び出しはそのまま',
			'notice.edited': 'モデル文脈を更新しました',
			'error.unreachable': 'DSH サーバーに接続できません',
			'error.notFound': 'この返信は会話にありません',
			'error.notEditable': 'この返信は編集できません',
			'error.tooLarge': '内容が大きすぎます',
			'error.badRequest': 'リクエストが不正です',
			'error.unavailable': 'この環境では利用できません',
			'error.writeFailed': '保存できませんでした',
			'error.unknown': '不明なエラーが発生しました'
		}
		const es = {
			'action.edit': 'Editar esta respuesta',
			'inline.save': 'Guardar',
			'inline.cancel': 'Cancelar',
			'inline.saving': 'Guardando…',
			'inline.hint': 'Solo el texto; las llamadas a herramientas se mantienen',
			'notice.edited': 'Contexto del modelo actualizado',
			'error.unreachable': 'No se pudo contactar con el servidor DSH',
			'error.notFound': 'Esta respuesta ya no está en la conversación',
			'error.notEditable': 'Esta respuesta no se puede editar',
			'error.tooLarge': 'El contenido es demasiado grande',
			'error.badRequest': 'La solicitud no es válida',
			'error.unavailable': 'Este entorno no admite la operación',
			'error.writeFailed': 'No se pudo guardar el cambio',
			'error.unknown': 'Se produjo un error inesperado'
		}
		const fr = {
			'action.edit': 'Modifier cette réponse',
			'inline.save': 'Enregistrer',
			'inline.cancel': 'Annuler',
			'inline.saving': 'Enregistrement…',
			'inline.hint': 'Texte uniquement ; les appels d’outils sont conservés',
			'notice.edited': 'Contexte du modèle mis à jour',
			'error.unreachable': 'Impossible de joindre le serveur DSH',
			'error.notFound': 'Cette réponse n’est plus dans la conversation',
			'error.notEditable': 'Cette réponse ne peut pas être modifiée',
			'error.tooLarge': 'Le contenu est trop volumineux',
			'error.badRequest': 'La requête n’est pas valide',
			'error.unavailable': 'Cet environnement ne prend pas en charge l’opération',
			'error.writeFailed': 'La modification n’a pas pu être enregistrée',
			'error.unknown': 'Une erreur inattendue est survenue'
		}
		const de = {
			'action.edit': 'Diese Antwort bearbeiten',
			'inline.save': 'Speichern',
			'inline.cancel': 'Abbrechen',
			'inline.saving': 'Wird gespeichert…',
			'inline.hint': 'Nur Text; Tool-Aufrufe bleiben erhalten',
			'notice.edited': 'Modellkontext aktualisiert',
			'error.unreachable': 'Der DSH-Server ist nicht erreichbar',
			'error.notFound': 'Diese Antwort ist nicht mehr im Gespräch',
			'error.notEditable': 'Diese Antwort kann nicht bearbeitet werden',
			'error.tooLarge': 'Der Inhalt ist zu groß',
			'error.badRequest': 'Die Anfrage ist ungültig',
			'error.unavailable': 'Diese Umgebung unterstützt den Vorgang nicht',
			'error.writeFailed': 'Die Änderung konnte nicht gespeichert werden',
			'error.unknown': 'Ein unerwarteter Fehler ist aufgetreten'
		}
		const ru = {
			'action.edit': 'Изменить этот ответ',
			'inline.save': 'Сохранить',
			'inline.cancel': 'Отмена',
			'inline.saving': 'Сохранение…',
			'inline.hint': 'Только текст; вызовы инструментов сохраняются',
			'notice.edited': 'Контекст модели обновлён',
			'error.unreachable': 'Не удалось связаться с сервером DSH',
			'error.notFound': 'Этого ответа больше нет в разговоре',
			'error.notEditable': 'Этот ответ нельзя изменить',
			'error.tooLarge': 'Содержимое слишком велико',
			'error.badRequest': 'Запрос недействителен',
			'error.unavailable': 'Эта среда не поддерживает операцию',
			'error.writeFailed': 'Не удалось сохранить изменение',
			'error.unknown': 'Произошла неизвестная ошибка'
		}
		const pt = {
			'action.edit': 'Editar esta resposta',
			'inline.save': 'Salvar',
			'inline.cancel': 'Cancelar',
			'inline.saving': 'Salvando…',
			'inline.hint': 'Apenas o texto; as chamadas de ferramenta permanecem',
			'notice.edited': 'Contexto do modelo atualizado',
			'error.unreachable': 'Não foi possível contatar o servidor DSH',
			'error.notFound': 'Esta resposta não está mais na conversa',
			'error.notEditable': 'Esta resposta não pode ser editada',
			'error.tooLarge': 'O conteúdo é grande demais',
			'error.badRequest': 'A requisição não é válida',
			'error.unavailable': 'Este ambiente não suporta a operação',
			'error.writeFailed': 'Não foi possível salvar a alteração',
			'error.unknown': 'Ocorreu um erro inesperado'
		}
		//#endregion

		//#region decisions
		/** The empty decision set. */
		const EMPTY_DECISIONS = Object.freeze({ revision: 0, edited: {} })

		/**
		 * Read Session decisions from the Host and notify the transcript overlay.
		 *
		 * Message identities are unique across Sessions, so decisions are indexed by
		 * identity; that also lets a message inherited by a fork resolve without a
		 * second lookup.
		 */
		var DecisionReader = class {
			constructor(fetcher = (input, init) => fetch(input, init)) {
				this.fetcher = fetcher
				this.bySession = new Map()
				/** Merged view: message identity to its replacement text. */
				this.byMessage = new Map()
				this.listeners = new Set()
				this.inflight = new Map()
			}

			/**
			 * The replacement text for one message, if any.
			 * @param messageId - durable message identity.
			 * @returns the replacement, or undefined when the message is untouched.
			 */
			decide(messageId) {
				return typeof messageId === 'string' ? this.byMessage.get(messageId) : undefined
			}

			/** Whether any decision is in force, so the overlay can skip untouched rows. */
			get active() {
				return this.byMessage.size > 0
			}

			/** Subscribe to any Session's decision change. */
			subscribe(listener) {
				this.listeners.add(listener)
				return () => {
					this.listeners.delete(listener)
				}
			}

			/**
			 * Fetch one Session's decisions; a failure keeps the previous value.
			 * @param sessionId - the Session to read.
			 */
			async reload(sessionId) {
				if (typeof sessionId !== 'string' || sessionId === '') return
				const running = this.inflight.get(sessionId)
				if (running !== undefined) return running
				const task = this.read(sessionId).finally(() => {
					this.inflight.delete(sessionId)
				})
				this.inflight.set(sessionId, task)
				return task
			}

			async read(sessionId) {
				let response
				try {
					response = await this.fetcher(`${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { method: 'GET' })
				} catch {
					return
				}
				if (!response.ok) return
				let value
				try {
					value = await response.json()
				} catch {
					return
				}
				if (value === null || typeof value !== 'object') return
				const next = {
					revision: typeof value.revision === 'number' ? value.revision : 0,
					edited: value.edited !== null && typeof value.edited === 'object' ? value.edited : {}
				}
				const previous = this.bySession.get(sessionId)
				if (previous !== undefined && previous.revision === next.revision) return
				this.bySession.set(sessionId, next)
				this.reindex()
				for (const listener of [...this.listeners]) listener(sessionId)
			}

			/** Rebuild the merged identity index from every Session's decisions. */
			reindex() {
				const merged = new Map()
				for (const decisions of this.bySession.values()) {
					for (const [messageId, text] of Object.entries(decisions.edited)) merged.set(messageId, text)
				}
				this.byMessage = merged
			}
		}
		//#endregion

		//#region transcript overlay
		/**
		 * Wrap the registered Chat builder so an edited reply reaches it as content.
		 *
		 * Only `data.blocks` is rewritten, and only for the rows that carry the
		 * edited identity, so every renderer keeps working exactly as before.
		 */
		var DecisionBuilder = class {
			constructor(inner, reader) {
				this.inner = inner
				this.reader = reader
			}

			get empty() {
				return this.inner.empty
			}

			/** Rewrite one node under the current decisions. */
			derive(node) {
				if (!this.reader.active) return node
				const messageId = node?.data?.finalNode?.messageId
				if (typeof messageId !== 'string') return node
				const text = this.reader.decide(messageId)
				if (typeof text !== 'string') return node
				const blocks = node.data.blocks
				if (!Array.isArray(blocks)) return node
				const others = blocks.filter((block) => block?.kind !== 'text')
				if (others.length === blocks.length) return node
				const next = text === '' ? others : [{ kind: 'text', text }, ...others]
				return {
					...node,
					data: {
						...node.data,
						blocks: next,
						finalNode: { ...node.data.finalNode, blocks: next }
					}
				}
			}

			replace(input) {
				return this.inner.replace({ ...input, nodes: input.nodes.map((node) => this.derive(node)) })
			}

			apply(input) {
				return this.inner.apply({ ...input, upserts: input.upserts.map((node) => this.derive(node)) })
			}

			groupInput() {
				return this.inner.groupInput?.()
			}

			publish() {
				this.inner.publish?.()
			}
		}

		/**
		 * Install the builder wrapper on the live Chat view definition.
		 *
		 * The registry is first-party and `create` is not an extension point, so the
		 * shape is checked before it is touched and the original is restored on
		 * unload. A missing or reshaped registry degrades to no overlay rather than
		 * breaking the transcript.
		 */
		function installOverlay(ctx, reader) {
			let stopped = false
			let cleanup
			const start = () => {
				const scope = ctx.inject?.(['uiConversation'], (child) => {
					if (!stopped) cleanup = installOn(child.get('uiConversation'), reader)
				})
				if (ctx.inject === undefined) cleanup = installOn(ctx.get('uiConversation'), reader)
				return () => {
					stopped = true
					cleanup?.()
					cleanup = undefined
					if (typeof scope === 'function') scope()
				}
			}
			if (ctx.effect === undefined) {
				start()
				return
			}
			ctx.effect(start, 'msg-edit: chat overlay')
		}

		function installOn(ui, reader) {
			if (ui?.views === undefined || typeof ui.views.entries !== 'function') return undefined
			const views = ui.views
			const patches = new Map()
			let unsubscribe
			const ensure = () => {
				let definition
				try {
					definition = views.entries().find((candidate) => candidate.target === CHAT_TARGET)
				} catch {
					return
				}
				if (definition === undefined || typeof definition.create !== 'function') return
				const current = patches.get(definition)
				if (current !== undefined && definition.create === current.wrapper) return
				const create = definition.create
				const wrapper = function wrappedChatBuilder() {
					return new DecisionBuilder(create.call(definition), reader)
				}
				definition.create = wrapper
				patches.set(definition, { original: create, wrapper })
			}
			try {
				unsubscribe = views.subscribe?.(ensure)
			} catch {
				unsubscribe = undefined
			}
			ensure()
			const offReader = reader.subscribe(() => rebuildOpen(ui))
			return () => {
				offReader()
				unsubscribe?.()
				for (const [definition, record] of patches) {
					if (definition.create === record.wrapper) definition.create = record.original
				}
				patches.clear()
				rebuildOpen(ui)
			}
		}

		function rebuildOpen(ui) {
			let ids = []
			try {
				const snapshot = ui?.sessions?.list?.getSnapshot?.()
				ids = [...(snapshot?.ids ?? []), ...Object.keys(snapshot?.byId ?? {})]
			} catch {
				return
			}
			for (const id of new Set(ids)) {
				try {
					ui.binding?.(id)?.rebuild?.()
				} catch {
					/* one Session failing to rebuild must not stop the others */
				}
			}
		}
		//#endregion

		//#region locating a reply
		/**
		 * Find the Chat node that renders one reply.
		 *
		 * The reply's action row is NOT inside the reply's own row: the Chat view
		 * renders the actions in the Turn's footer (`turn-tail`) while the text
		 * lives in an `assistant-step` row. Walking up from the clicked button
		 * therefore reaches the footer, never the text 鈥?which is why every click
		 * once reported "not editable". The node is looked up by identity instead.
		 *
		 * @param ui - the `uiConversation` service.
		 * @param sessionId - the Session owning the reply.
		 * @param messageId - the reply's identity.
		 * @returns the node key and its source text, or undefined when unknown.
		 */
		function replyNodeOf(ui, sessionId, messageId) {
			try {
				const snapshot = ui?.binding?.(sessionId)?.target?.(CHAT_TARGET)?.getSnapshot?.()
				if (snapshot === undefined) return undefined
				for (const key of snapshot.order) {
					const node = snapshot.nodes.get(key)
					if (node?.data?.finalNode?.messageId !== messageId) continue
					const blocks = node.data.blocks
					if (!Array.isArray(blocks)) return undefined
					const texts = blocks.filter((block) => block?.kind === 'text').map((block) => block.text)
					if (texts.length === 0) return undefined
					return { key, text: texts.join('\n\n') }
				}
			} catch {
				return undefined
			}
			return undefined
		}

		/**
		 * Resolve one node key to the element that renders it.
		 *
		 * The text is matched by identity, not by content: the DOM holds rendered
		 * Markdown (syntax removed, links rewritten), so comparing it against the
		 * source text would fail for any reply with formatting.
		 *
		 * A grouped row can appear more than once, so the first one that is actually
		 * laid out wins.
		 * @param key - the Chat node key.
		 * @returns the rendered element, or undefined when it is not on screen.
		 */
		function rowElementOf(key) {
			if (typeof key !== 'string' || key === '') return undefined
			const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
				? CSS.escape(key)
				: key.replace(/["\\]/g, '\\$&')
			let matches
			try {
				matches = document.querySelectorAll(`[${ROW_ATTRIBUTE}="${escaped}"]`)
			} catch {
				return undefined
			}
			let fallback
			for (const element of matches) {
				const box = element.getBoundingClientRect()
				if (box.width > 0 && box.height > 0) return element
				fallback ??= element
			}
			return fallback
		}
		//#endregion

		//#region in-flow editor
		/**
		 * Insert an element into the transcript flow where a row currently sits.
		 *
		 * The editor is placed as a sibling **after** the row and the row is removed
		 * from layout with `display: none`, so the editor occupies the row's own
		 * space and inherits the column's width. Nothing is positioned against the
		 * viewport, which is what keeps it on screen.
		 *
		 * @param row - the rendered reply row.
		 * @param build - receives the measured typography, returns the host element.
		 * @returns a handle that restores the row.
		 */
		function mountInFlow(row, build) {
			const parent = row.parentElement
			if (parent === null) return undefined
			const computed = window.getComputedStyle(row)
			const host = build({
				fontFamily: computed.fontFamily,
				fontSize: computed.fontSize,
				lineHeight: computed.lineHeight,
				letterSpacing: computed.letterSpacing,
				color: computed.color,
				textAlign: computed.textAlign
			})
			const previousDisplay = row.style.display
			parent.insertBefore(host, row.nextSibling)
			row.style.display = 'none'
			return {
				host,
				restore() {
					row.style.display = previousDisplay
					host.remove()
				}
			}
		}
		//#endregion

		//#region controller
		/**
		 * Owns the one edit session: an in-flow editor, its draft, and the Host call.
		 *
		 * The Session id is not a constructor argument: the Session is known only at
		 * the moment a row is clicked, so it arrives with {@link open}.
		 */
		var MessageEditController = class {
			constructor(reader, label) {
				this.reader = reader
				this.label = label
				/** The mounted editor, when one is open. */
				this.mounted = undefined
				this.busy = false
			}

			/** Remove the editor and restore the row it replaced. */
			close() {
				this.mounted?.restore()
				this.mounted = undefined
				this.busy = false
			}

			/** Release the editor on unload. */
			dispose() {
				this.close()
			}

			/** Report that a reply cannot be edited. */
			fail(key) {
				this.toast(key)
			}

			/**
			 * Open the editor in place of one reply's body.
			 * @param payload - the reply, its Session, the source text, and the row.
			 */
			open(payload) {
				this.close()
				void this.reader.reload(payload.sessionId)
				// A previous edit of this message is the true starting point: the row
				// already shows the replacement, and starting from the original would
				// silently revert it.
				const existing = this.reader.decide(payload.messageId)
				const text = typeof existing === 'string' ? existing : payload.text
				const mounted = mountInFlow(payload.row, (font) => this.buildEditor(payload, text, font))
				if (mounted === undefined) {
					this.toast('error.notEditable')
					return
				}
				this.mounted = mounted
				const area = mounted.host.querySelector('[data-msg-edit-area]')
				if (area !== null) {
					area.focus()
					// Put the caret at the end without scrolling: the element shows its
					// whole content, so there is nothing to scroll to.
					const range = document.createRange()
					range.selectNodeContents(area)
					range.collapse(false)
					const selection = window.getSelection()
					selection?.removeAllRanges()
					selection?.addRange(range)
				}
			}

			/**
			 * Build the editor's DOM: a borderless editable body at the reply's own
			 * typography, with save and cancel beneath it.
			 *
			 * A `contenteditable` element is used rather than a `textarea` on purpose.
			 * A textarea has no intrinsic height: it must be measured and pinned with
			 * `scrollHeight`, and any mistake there 鈥?reading it before layout, or
			 * clipping the overflow 鈥?leaves only the last few lines visible. A
			 * contenteditable block grows with its content by itself, so the whole
			 * reply is always on screen and no sizing code can get it wrong.
			 *
			 * @param payload - the reply being edited.
			 * @param text - the draft.
			 * @param font - typography copied from the row.
			 * @returns the host element.
			 */
			buildEditor(payload, text, font) {
				const host = document.createElement('div')
				applyStyle(host, {
					...styles.host,
					fontFamily: font.fontFamily,
					fontSize: font.fontSize,
					lineHeight: font.lineHeight,
					letterSpacing: font.letterSpacing,
					color: font.color,
					textAlign: font.textAlign
				})

				const area = document.createElement('div')
				area.setAttribute('contenteditable', 'true')
				area.setAttribute('data-msg-edit-area', '')
				area.setAttribute('role', 'textbox')
				area.setAttribute('aria-multiline', 'true')
				area.spellcheck = false
				applyStyle(area, styles.area)
				// `textContent` keeps the draft as literal text: the reply's own
				// Markdown must not be re-interpreted while it is being edited.
				area.textContent = text
				area.addEventListener('keydown', (event) => {
					if (event.key === 'Escape') {
						event.preventDefault()
						this.close()
						return
					}
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
						event.preventDefault()
						void this.commit(payload, area)
					}
				})
				// A paste carrying HTML would replace the draft with markup the Host
				// would then store as literal text; insert the plain form instead.
				area.addEventListener('paste', (event) => {
					event.preventDefault()
					const plain = event.clipboardData?.getData('text/plain') ?? ''
					document.execCommand('insertText', false, plain)
				})

				const bar = document.createElement('div')
				applyStyle(bar, styles.bar)

				const status = document.createElement('span')
				applyStyle(status, styles.hint)
				status.textContent = this.label('inline.hint')

				const cancel = document.createElement('button')
				cancel.type = 'button'
				applyStyle(cancel, styles.button)
				cancel.textContent = this.label('inline.cancel')
				cancel.addEventListener('click', () => this.close())

				const save = document.createElement('button')
				save.type = 'button'
				applyStyle(save, { ...styles.button, ...styles.primary })
				save.textContent = this.label('inline.save')
				save.addEventListener('click', () => {
					void this.commit(payload, area, { status, save, cancel })
				})

				bar.append(status, cancel, save)
				host.append(area, bar)
				return host
			}

			/**
			 * Record the edit on the Host.
			 *
			 * The editor stays open on failure so the draft survives; a successful
			 * save restores the row and raises the notice instead.
			 * @param payload - the reply being edited.
			 * @param area - the contenteditable element holding the draft.
			 * @param controls - the buttons and status line to update while busy.
			 */
			async commit(payload, area, controls) {
				if (this.busy) return
				if (payload.sessionId === '') {
					// A row rendered without a Session binding cannot be committed; saying
					// so beats posting a request the Host would reject as a bad session.
					if (controls !== undefined) this.showError(controls.status, 'error.unavailable')
					return
				}
				this.busy = true
				if (controls !== undefined) {
					controls.save.disabled = true
					controls.cancel.disabled = true
					controls.save.textContent = this.label('inline.saving')
				}
				// `innerText` reflects what the human sees, including line breaks the
				// browser inserted while typing; `textContent` would lose them.
				const draft = typeof area.innerText === 'string' ? area.innerText : (area.textContent ?? '')
				let response
				try {
					response = await fetch(ROUTE, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ sessionId: payload.sessionId, messageId: payload.messageId, text: draft })
					})
				} catch {
					this.busy = false
					if (controls !== undefined) this.showError(controls.status, 'error.unreachable', controls)
					return
				}
				if (!response.ok) {
					this.busy = false
					if (controls !== undefined) this.showError(controls.status, await failureKey(response), controls)
					return
				}
				this.busy = false
				this.close()
				this.toast('notice.edited')
				// The transcript is rebuilt from the Host's own decision rather than
				// patched locally: a local guess could disagree with what the model
				// will actually receive.
				await this.reader.reload(payload.sessionId)
			}

			/**
			 * Show a failure in the editor without discarding the draft.
			 * @param status - the status element.
			 * @param key - the dictionary key.
			 * @param controls - the buttons to re-enable.
			 */
			showError(status, key, controls) {
				applyStyle(status, styles.error)
				status.textContent = this.label(key)
				if (controls !== undefined) {
					controls.save.disabled = false
					controls.cancel.disabled = false
					controls.save.textContent = this.label('inline.save')
				}
			}

			/**
			 * Raise a transient message at the bottom of the frame.
			 * @param key - the dictionary key.
			 */
			toast(key) {
				const element = document.createElement('div')
				applyStyle(element, styles.toast)
				element.setAttribute('role', 'status')
				element.textContent = this.label(key)
				document.body.append(element)
				setTimeout(() => element.remove(), 3200)
			}
		}

		/** Map a Host failure body to a dictionary key. */
		async function failureKey(response) {
			let code
			try {
				code = (await response.json())?.error
			} catch {
				code = undefined
			}
			switch (code) {
				case 'not-found': return 'error.notFound'
				case 'not-editable': return 'error.notEditable'
				case 'too-large': return 'error.tooLarge'
				case 'bad-request': return 'error.badRequest'
				case 'unavailable': return 'error.unavailable'
				case 'write-failed': return 'error.writeFailed'
				default: return 'error.unknown'
			}
		}
		//#endregion

		//#region components
		/**
		 * The pencil in the reply's action row.
		 *
		 * The action row lives in the Turn footer, not inside the reply's own row, so
		 * this cannot walk up from the button to find the text. It resolves the
		 * reply's node by identity, then that node's rendered row by key.
		 */
		function EditAction(props) {
			const { messageId, t, edit, sessionId, ui } = props
			const label = typeof t === 'function' ? t : (key) => zh[key] ?? key
			return h('button', {
				type: 'button',
				style: styles.action,
				title: label('action.edit'),
				'aria-label': label('action.edit'),
				onClick: () => {
					const reply = replyNodeOf(ui(), sessionId, messageId)
					if (reply === undefined) {
						edit.fail('error.notEditable')
						return
					}
					const row = rowElementOf(reply.key)
					if (row === undefined) {
						edit.fail('error.notEditable')
						return
					}
					edit.open({ messageId, sessionId, text: reply.text, row })
				}
			}, '\u270E')
		}
		//#endregion

		//#region plugin
		/** Client services this plugin needs before it can register anything. */
		const inject = ['slots', 'locale']

		function apply(ctx) {
			const reader = new DecisionReader()
			const ui = () => ctx.get('uiConversation')

			ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'msg-edit: dictionaries')
			const bound = ctx.locale.bind(NS)
			const fallback = (key) => {
				const text = bound(key)
				return typeof text === 'string' && text !== '' ? text : zh[key] ?? key
			}
			const editor = new MessageEditController(reader, fallback)
			ctx.effect(() => () => editor.dispose(), 'msg-edit: editor')

			installOverlay(ctx, reader)

			ctx.slots.inject(ACTIONS_SLOT, () => ctx.slots.register({
				name: ACTIONS_SLOT,
				id: 'msg-edit.actions',
				order: 20,
				locale: NS,
				inject: (sessionId) => ({
					sessionId,
					ui,
					edit: {
						open: (payload) => editor.open(payload),
						fail: (key) => editor.fail(key)
					}
				})
			}, EditAction))
		}
		//#endregion

		return { inject, apply }
	}
})
