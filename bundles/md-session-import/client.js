window.__ModuleLoader__.load({
	id: 'dsh-md-session-import',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		/** Locale namespace owned by the import action and its outcome toast. */
		const NS = 'md-session-import';
		/**
		 * Document-relative form of the Host import route. The browser resolves
		 * it against the document's own base, exactly as the export plugin does.
		 */
		const IMPORT_ROUTE = 'api/session.import';
		/** Extensions and media types the picker offers. */
		const ACCEPT = '.md,.markdown,.txt,.text,text/markdown,text/plain';
		/** How long one outcome toast stays on screen before it dismisses itself. */
		const TOAST_MS = 6000;
		/** Machine codes the Host reports, mapped to copy this plugin owns. */
		const ERROR_KEYS = {
			empty: 'error.empty',
			'no-turns': 'error.noTurns',
			'too-large': 'error.tooLarge',
			'bad-request': 'error.badRequest',
			unavailable: 'error.unavailable',
			'workspace-unavailable': 'error.unavailable',
			'workspace-not-found': 'error.workspaceNotFound',
			'preset-unavailable': 'error.presetUnavailable',
			'preset-not-found': 'error.presetNotFound',
			'preset-broken': 'error.presetBroken',
			'write-failed': 'error.writeFailed'
		};

		//#region styles
		/*
		 * The elevated surface follows `dsh-rewind-plugin`'s popover: the same
		 * elevation, menu fill, radius and scrollbar tokens the host menus use, so
		 * the plugin reads as part of one application. Only `--dsw-*` tokens carry
		 * colour; artwork alone may use literals.
		 */
		const css = ".mdsi_hidden{display:none}.mdsi_button{width:calc(100% + 4px);height:42px;margin:0 -2px;padding:0 10px 0 8px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}@media (hover:hover){.mdsi_button:hover{background:var(--dsw-alias-interactive-bg-hover)}}.mdsi_button:disabled{cursor:default;opacity:.6}.mdsi_label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.mdsi_rail{corner-shape:round;width:36px;height:36px;margin:0;padding:0;border-radius:50%;justify-content:center}.mdsi_layer{z-index:1099;position:fixed;inset:0}.mdsi_picker{z-index:1100;box-sizing:border-box;width:min(340px,calc(100vw - 24px));max-height:min(60vh,420px);padding:12px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3));backdrop-filter:var(--dsw-menu-backdrop-filter);isolation:isolate;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;display:flex;flex-direction:column;position:fixed;overflow:hidden}.mdsi_pickerTitle{font-weight:500;flex:none}.mdsi_pickerHint{color:var(--dsw-alias-label-tertiary);margin:2px 0 10px;font-size:12px;flex:none}.mdsi_list{min-height:0;flex:1;overflow-y:auto}.mdsi_option{flex-direction:column;gap:2px;width:100%;margin:0 0 2px;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;display:flex}.mdsi_option:hover{background:var(--dsw-alias-interactive-bg-hover)}.mdsi_option:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:-2px}.mdsi_optionTitle{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.mdsi_optionPath{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;overflow:hidden}.mdsi_footer{border-top:1px solid var(--dsw-alias-border-l1);margin-top:8px;padding-top:8px;flex:none}.mdsi_footerRow{display:flex;gap:6px}.mdsi_cancel{width:100%;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}.mdsi_cancel:hover{background:var(--dsw-alias-interactive-bg-hover)}.mdsi_toast{color:var(--dsw-alias-label-primary);z-index:1100;box-shadow:var(--dsw-elevation-prominent);box-sizing:border-box;background:var(--dsw-specific-menu);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;align-items:center;gap:8px;width:max-content;max-width:min(560px,calc(100vw - 32px));padding:10px 14px;font-size:13px;line-height:18px;display:flex;position:fixed;bottom:28px;left:50%;transform:translateX(-50%);cursor:pointer}.mdsi_toastIcon{color:var(--dsw-alias-label-secondary);flex:none}.mdsi_toastText{min-width:0}";
		const tagId = 'dsh-md-session-import/styles.css';
		if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-md-session-import';
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const styles = {
			hidden: 'mdsi_hidden',
			button: 'mdsi_button',
			label: 'mdsi_label',
			rail: 'mdsi_rail',
			layer: 'mdsi_layer',
			picker: 'mdsi_picker',
			pickerTitle: 'mdsi_pickerTitle',
			pickerHint: 'mdsi_pickerHint',
			list: 'mdsi_list',
			option: 'mdsi_option',
			optionTitle: 'mdsi_optionTitle',
			optionPath: 'mdsi_optionPath',
			footer: 'mdsi_footer',
			footerRow: 'mdsi_footerRow',
			cancel: 'mdsi_cancel',
			toast: 'mdsi_toast',
			toastIcon: 'mdsi_toastIcon',
			toastText: 'mdsi_toastText'
		};
		//#endregion
		//#region store
		/**
		* Minimal external store for the components below. The Host's own snapshot
		* store is a Harness Client package, and a plugin must not import one: its
		* API can change without notice and a plain-JS plugin has no type check to
		* catch it. `useSyncExternalStore` is plain React.
		* @param initial - the initial snapshot.
		* @returns a store with a stable subscribe used by React.
		*/
		function createStore(initial) {
			let snapshot = initial;
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				patch(change) {
					snapshot = {
						...snapshot,
						...change
					};
					for (const listener of [...listeners]) listener();
				}
			};
		}
		const INITIAL = {
			busy: false,
			notice: null,
			picker: null
		};
		//#endregion
		//#region controller
		/** Owns one import: the chosen document, the workspace question, and the outcome. */
		var ImportController = class {
			ctx;
			fetcher;
			store = createStore(INITIAL);
			noticeSeq = 0;
			/**
			* @param ctx - client root context, used to reach the Workspace list and the Session list.
			* @param fetcher - HTTP carrier used to reach the Host import route.
			*/
			constructor(ctx, fetcher = (input, init) => fetch(input, init)) {
				this.ctx = ctx;
				this.fetcher = fetcher;
			}
			/**
			* Read one chosen file and open the workspace question.
			*
			* The document is read before the question rather than after it: a file
			* that cannot be read should fail before the user answers anything, and
			* the text is held in memory only until the answer arrives.
			*
			* @param file - the file the picker returned.
			* @param anchor - the triggering control's viewport rectangle, for placement.
			* @returns after the workspace question opens, or after the read failure is published.
			*/
			async choose(file, anchor) {
				if (this.store.getSnapshot().busy) return;
				if (file === null || typeof file !== 'object' || typeof file.text !== 'function') {
					this.publish("failure", "error.unknown");
					return;
				}
				let markdown;
				try {
					markdown = await file.text();
				} catch {
					this.publish("failure", "error.readFailed");
					return;
				}
				if (markdown.trim() === "") {
					this.publish("failure", "error.empty");
					return;
				}
				this.store.patch({
					busy: false,
					notice: null,
					picker: {
						step: "workspace",
						name: typeof file.name === "string" ? file.name : "",
						markdown,
						workspaces: this.workspaces(),
						presets: [],
						presetsLoading: true,
						workspaceId: null,
						workspaceTitle: null,
						anchor
					}
				});
				// The preset roster is read in the background: it arrives while the
				// user is still answering the workspace question, and a deployment
				// without the registry simply offers no preset.
				await this.loadPresets();
			}
			/**
			* The workspaces a session can be filed under, in the sidebar's own order.
			*
			* Read once when the question opens instead of subscribed: the list is a
			* short-lived choice, and a snapshot taken at open keeps the answer and the
			* rows the user saw consistent even if a workspace is added meanwhile.
			*
			* @returns the selectable workspaces.
			*/
			workspaces() {
				let items;
				try {
					items = this.ctx.get("workspaces")?.list?.getSnapshot()?.items;
				} catch {
					items = void 0;
				}
				if (!Array.isArray(items)) return [];
				return items.flatMap((item) => typeof item?.workspaceId !== "string" || typeof item?.path !== "string" ? [] : [{
					id: item.workspaceId,
					title: typeof item.title === "string" && item.title.trim() !== "" ? item.title : item.path,
					path: item.path
				}]);
			}
			/**
			* Read the preset roster the deployment supplies.
			*
			* Broken presets are dropped: the Host refuses them at import, and
			* offering a row that cannot produce a session would move the discovery of
			* that fact to the moment the user commits. An unavailable roster is not a
			* failure — a deployment may compose no presets at all, and the import
			* still works without one.
			*
			* @returns after the roster is written to the pending question.
			*/
			async loadPresets() {
				let options = [];
				try {
					const namespace = this.ctx.get("remote.agentPresets");
					const result = namespace === void 0 ? void 0 : await namespace.list();
					const rows = result !== void 0 && result.ok === true ? result.value?.presets : void 0;
					if (Array.isArray(rows)) {
						options = rows.flatMap((row) => typeof row?.id !== "string" || row.id === "" || row.broken !== void 0 ? [] : [{
							id: row.id,
							name: typeof row.name === "string" && row.name.trim() !== "" ? row.name : row.id,
							description: typeof row.description === "string" ? row.description : "",
							isDefault: row.isDefault === true
						}]);
					}
				} catch {
					options = [];
				}
				const picker = this.store.getSnapshot().picker;
				// The user may have answered or dismissed while the roster was in
				// flight; only a question still on the preset step takes the result.
				if (picker === null) return;
				this.store.patch({
					picker: {
						...picker,
						presets: options,
						presetsLoading: false
					}
				});
			}
			/** Abandon the pending document without importing it. */
			cancel() {
				if (this.store.getSnapshot().picker === null) return;
				this.store.patch({ picker: null });
			}
			/**
			* Answer the workspace question and move to the preset question.
			*
			* The two steps are separate on purpose: the workspace decides where the
			* Session lives, the preset decides what it can do, and asking both at once
			* would make one list of two unrelated dimensions.
			*
			* @param workspaceId - the chosen workspace, or null to import unfiled.
			* @returns after the preset question opens.
			*/
			chooseWorkspace(workspaceId) {
				const picker = this.store.getSnapshot().picker;
				if (picker === null || this.store.getSnapshot().busy) return;
				const chosen = workspaceId === null ? void 0 : picker.workspaces.find((workspace) => workspace.id === workspaceId);
				this.store.patch({
					picker: {
						...picker,
						step: "preset",
						workspaceId,
						workspaceTitle: chosen === void 0 ? null : chosen.title
					}
				});
			}
			/** Step back from the preset question to the workspace question. */
			back() {
				const picker = this.store.getSnapshot().picker;
				if (picker === null || this.store.getSnapshot().busy) return;
				this.store.patch({
					picker: {
						...picker,
						step: "workspace"
					}
				});
			}
			/**
			* Import the pending document with the answered workspace and one preset.
			* @param agentPreset - the chosen preset, or null to let the Host apply its default.
			* @returns after the upload settles and the outcome is published.
			*/
			async confirm(agentPreset) {
				const picker = this.store.getSnapshot().picker;
				if (picker === null || this.store.getSnapshot().busy) return;
				this.store.patch({
					busy: true,
					notice: null,
					picker: null
				});
				try {
					const result = await this.upload(picker.markdown, picker.workspaceId, agentPreset);
					if (result === void 0) return;
					if (result.attachFailed === true) this.publish("warning", "error.attachFailed");
					else this.publish("success");
					await this.reveal(result.sessionId);
				} finally {
					this.store.patch({ busy: false });
				}
			}
			/**
			* Post one document and read the Host answer.
			* @param markdown - the document text.
			* @param workspaceId - the chosen workspace, or null.
			* @param agentPreset - the chosen preset, or null for the Host default.
			* @returns the Host result, or undefined after publishing the failure.
			*/
			async upload(markdown, workspaceId, agentPreset) {
				let response;
				try {
					response = await this.fetcher(IMPORT_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							markdown,
							...workspaceId === null ? {} : { workspaceId },
							...agentPreset === null ? {} : { agentPreset }
						})
					});
				} catch {
					this.publish("failure", "error.unreachable");
					return void 0;
				}
				const payload = await response.json().catch(() => null);
				if (!response.ok || payload === null || typeof payload.sessionId !== "string") {
					const code = payload !== null && typeof payload.error === "string" ? payload.error : void 0;
					this.publish("failure", ERROR_KEYS[code] ?? "error.unknown");
					return void 0;
				}
				return payload;
			}
			/**
			* Show the imported Session: refresh the Host list so the new row exists,
			* then open it. Both services are optional — a profile without them still
			* completes the import, and the Session is listed on the next refresh.
			* @param sessionId - the Session just created.
			*/
			async reveal(sessionId) {
				try {
					await this.ctx.get("sessions")?.refresh?.();
				} catch {}
				try {
					this.ctx.get("uiWorkspace")?.openSession?.(sessionId);
				} catch {}
			}
			/** Clear the shown toast without affecting a pending upload. */
			dismiss() {
				if (this.store.getSnapshot().notice === null) return;
				this.store.patch({ notice: null });
			}
			/**
			* Publish one outcome. The sequence number keys the toast so a repeated
			* identical outcome still restarts its dismissal timer.
			* @param kind - `success`, `warning`, or `failure`.
			* @param errorKey - locale key describing a warning or failure.
			*/
			publish(kind, errorKey) {
				this.store.patch({
					notice: {
						kind,
						errorKey,
						seq: ++this.noticeSeq
					}
				});
			}
		};
		//#endregion
		//#region icons
		/**
		* Document with an arrow entering it. Drawn here rather than imported: the
		* Host icon set is a Client package this plugin must not require.
		* @returns the inline icon element.
		*/
		function IconImport() {
			return h('svg', {
				viewBox: '0 0 24 24',
				width: 15,
				height: 15,
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.6,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': 'true',
				focusable: 'false',
				style: { flex: 'none', display: 'block' }
			}, h('path', { d: 'M13.5 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7.5L13.5 3Z' }), h('path', { d: 'M13.5 3v4.5H18' }), h('path', { d: 'M12 11.5v6' }), h('path', { d: 'M9.5 15l2.5 2.5 2.5-2.5' }));
		}
		/**
		* Outcome glyph for the toast.
		* @param props - carries the published kind.
		* @returns the inline icon element.
		*/
		function IconOutcome({ kind }) {
			const shared = {
				viewBox: '0 0 24 24',
				width: 16,
				height: 16,
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.7,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				className: styles.toastIcon,
				'aria-hidden': 'true',
				focusable: 'false'
			};
			return kind === 'success' ? h('svg', shared, h('path', { d: 'M20 6 9 17l-5-5' })) : h('svg', shared, h('path', { d: 'M12 4.5 2.8 20h18.4L12 4.5Z' }), h('path', { d: 'M12 10v4' }), h('path', { d: 'M12 17h.01' }));
		}
		//#endregion
		//#region components
		/**
		* Sidebar footer action: choose one Markdown file, then one workspace.
		* @param props - slot props plus this plugin's injected store, action and translator.
		* @returns the footer control.
		*/
		function ImportAction(props) {
			const { wide, t, choose } = props;
			const busy = React.useSyncExternalStore(props.store.subscribe, () => props.store.getSnapshot().busy);
			const inputRef = React.useRef(null);
			const buttonRef = React.useRef(null);
			const label = busy ? t('action.busy') : t('action.label');
			return h(React.Fragment, null, h('input', {
				ref: inputRef,
				type: 'file',
				accept: ACCEPT,
				className: styles.hidden,
				tabIndex: -1,
				onChange: (event) => {
					const file = event.target.files?.[0];
					// Clear the control so choosing the same file twice still fires.
					event.target.value = '';
					if (file === undefined) return;
					const rect = buttonRef.current?.getBoundingClientRect();
					choose(file, rect === undefined ? null : {
						top: rect.top,
						left: rect.left,
						bottom: rect.bottom
					});
				}
			}), h('button', {
				ref: buttonRef,
				type: 'button',
				className: wide ? styles.button : `${styles.button} ${styles.rail}`,
				disabled: busy,
				title: label,
				'aria-label': label,
				'aria-busy': busy,
				onClick: () => inputRef.current?.click()
			}, h(IconImport, null), wide ? h('span', { className: styles.label }, label) : null));
		}
		/**
		* The two-question flow: where the Session is filed, then what it composes.
		*
		* A fixed-position panel rather than a dialog: each answer is one click out
		* of a short list, and a panel needs no focus trap while still escaping the
		* sidebar's clipping. It closes on Escape, on a click outside, and after the
		* last answer, and a click outside discards the pending document.
		*
		* The steps are sequential because the two lists answer unrelated questions:
		* the workspace decides the directory and the sidebar group, the preset
		* decides the composition the Session runs. Showing them together would put
		* two independent dimensions in one list.
		*
		* @param props - the pending document, both selectable lists, and the actions.
		* @returns the panel, or null while no document is pending.
		*/
		function ImportPicker(props) {
			const { t, cancel, confirm, chooseWorkspace, back } = props;
			const picker = React.useSyncExternalStore(props.store.subscribe, () => props.store.getSnapshot().picker);
			React.useEffect(() => {
				if (picker === null) return void 0;
				const onKeyDown = (event) => {
					if (event.key === 'Escape') cancel();
				};
				document.addEventListener('keydown', onKeyDown);
				return () => document.removeEventListener('keydown', onKeyDown);
			}, [picker, cancel]);
			if (picker === null) return null;
			const anchor = picker.anchor;
			const place = anchor === null ? {
				left: 12,
				bottom: 12
			} : {
				left: Math.max(12, Math.min(anchor.left, window.innerWidth - 352)),
				bottom: Math.max(12, window.innerHeight - anchor.top + 6)
			};
			const onPresetStep = picker.step === 'preset';
			const title = onPresetStep ? t('preset.title') : t('picker.title');
			const context = onPresetStep ? picker.workspaceTitle === null ? t('preset.unfiled') : picker.workspaceTitle : picker.name;
			const hint = onPresetStep ? t('preset.hint') : t('picker.hint');
			return h(React.Fragment, null, h('div', {
				className: styles.layer,
				onMouseDown: cancel
			}), h('div', {
				className: styles.picker,
				style: place,
				role: 'dialog',
				'aria-label': title
			}, h('div', { className: styles.pickerTitle }, title), h('div', { className: styles.pickerHint }, context === '' ? hint : `${context} · ${hint}`), h('div', { className: styles.list }, ...(onPresetStep ? presetRows(picker, t, confirm) : workspaceRows(picker, t, chooseWorkspace))), h('div', { className: styles.footer }, h('div', { className: styles.footerRow }, onPresetStep ? h('button', {
				type: 'button',
				className: styles.cancel,
				onClick: back
			}, t('preset.back')) : null, h('button', {
				type: 'button',
				className: styles.cancel,
				onClick: cancel
			}, t('picker.cancel'))))));
		}
		/**
		* Rows of the workspace step.
		* @param picker - the pending question.
		* @param t - translator.
		* @param chooseWorkspace - action advancing to the preset step.
		* @returns the row elements.
		*/
		function workspaceRows(picker, t, chooseWorkspace) {
			if (picker.workspaces.length === 0) {
				return [h('button', {
					key: 'ungrouped',
					type: 'button',
					className: styles.option,
					onClick: () => chooseWorkspace(null)
				}, h('span', { className: styles.optionTitle }, t('picker.ungrouped')), h('span', { className: styles.optionPath }, t('picker.empty')))];
			}
			return picker.workspaces.map((workspace) => h('button', {
				key: workspace.id,
				type: 'button',
				className: styles.option,
				onClick: () => chooseWorkspace(workspace.id)
			}, h('span', { className: styles.optionTitle }, workspace.title), h('span', { className: styles.optionPath }, workspace.path)));
		}
		/**
		* Rows of the preset step.
		*
		* Clicking a preset imports immediately, matching the workspace step. A
		* deployment that supplies no roster still gets one row — the Host's own
		* default — because importing without naming a preset is a valid answer
		* rather than a missing one.
		*
		* @param picker - the pending question.
		* @param t - translator.
		* @param confirm - action performing the import.
		* @returns the row elements.
		*/
		function presetRows(picker, t, confirm) {
			if (picker.presetsLoading) {
				return [h('div', { key: 'loading', className: styles.pickerHint }, t('preset.loading'))];
			}
			if (picker.presets.length === 0) {
				return [h('button', {
					key: 'default',
					type: 'button',
					className: styles.option,
					onClick: () => confirm(null)
				}, h('span', { className: styles.optionTitle }, t('preset.default')), h('span', { className: styles.optionPath }, t('preset.empty')))];
			}
			return picker.presets.map((preset) => h('button', {
				key: preset.id,
				type: 'button',
				className: styles.option,
				onClick: () => confirm(preset.id)
			}, h('span', { className: styles.optionTitle }, preset.isDefault ? `${preset.name} · ${t('preset.isDefault')}` : preset.name), preset.description === '' ? null : h('span', { className: styles.optionPath }, preset.description)));
		}
		/**
		* Outcome toast, mounted outside the footer so it survives the control that
		* started the import.
		* @param props - notice source, dismissal action, and translator.
		* @returns the toast, or null while no notice shows.
		*/
		function ImportToast(props) {
			const { t, dismiss, store } = props;
			const notice = React.useSyncExternalStore(store.subscribe, () => store.getSnapshot().notice);
			const seq = notice?.seq;
			React.useEffect(() => {
				if (seq === undefined) return void 0;
				const timer = setTimeout(dismiss, TOAST_MS);
				return () => clearTimeout(timer);
			}, [seq, dismiss]);
			if (notice === null) return null;
			const text = notice.kind === 'success' ? t('toast.success') : `${t(notice.kind === 'warning' ? 'toast.warning' : 'toast.failed')}${t(notice.errorKey)}`;
			return h('div', {
				className: styles.toast,
				role: notice.kind === 'success' ? 'status' : 'alert',
				onClick: dismiss
			}, h(IconOutcome, { kind: notice.kind }), h('span', { className: styles.toastText }, text));
		}
		//#endregion
		//#region locales
		/** Simplified-Chinese dictionaries; the key set is the source of truth. */
		const zh = {
			'action.label': '导入会话',
			'action.busy': '正在导入…',
			'picker.title': '选择工作区',
			'picker.hint': '导入的会话将归入所选工作区',
			'picker.empty': '还没有工作区，无法归入',
			'picker.ungrouped': '不归入工作区，直接导入',
			'picker.cancel': '取消',
			'preset.title': '选择预设',
			'preset.hint': '会话将使用所选预设的能力',
			'preset.loading': '正在读取预设…',
			'preset.empty': '当前部署未提供预设',
			'preset.default': '使用默认预设',
			'preset.isDefault': '默认',
			'preset.unfiled': '不归入工作区',
			'preset.back': '上一步',
			'toast.success': '会话已导入，正在打开',
			'toast.warning': '会话已导入，但未归入工作区：',
			'toast.failed': '导入失败：',
			'error.empty': '文件内容为空',
			'error.noTurns': '文档里没有以 > 引出的用户输入',
			'error.tooLarge': '文件超过导入大小上限',
			'error.badRequest': '文件不是可识别的会话 Markdown',
			'error.readFailed': '无法读取该文件',
			'error.unreachable': '无法连接 DSH 服务',
			'error.unavailable': '当前环境未启用会话存储',
			'error.workspaceNotFound': '所选工作区已不存在',
			'error.attachFailed': '工作区归属失败，会话仍在未分组下',
			'error.writeFailed': '无法写入会话存储',
			'error.unknown': '发生未知错误',
			'error.presetUnavailable': '当前环境未启用预设',
			'error.presetNotFound': '所选预设已不存在',
			'error.presetBroken': '所选预设当前无法使用'
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			'action.label': 'Import session',
			'action.busy': 'Importing…',
			'picker.title': 'Choose a workspace',
			'picker.hint': 'the imported session is filed under the workspace you pick',
			'picker.empty': 'no workspace exists to file it under',
			'picker.ungrouped': 'Import without a workspace',
			'picker.cancel': 'Cancel',
			'preset.title': 'Choose a preset',
			'preset.hint': 'the session runs the composition you pick',
			'preset.loading': 'Reading presets…',
			'preset.empty': 'this deployment supplies no presets',
			'preset.default': 'Use the default preset',
			'preset.isDefault': 'default',
			'preset.unfiled': 'no workspace',
			'preset.back': 'Back',
			'toast.success': 'Session imported. Opening it now.',
			'toast.warning': 'Session imported, but not filed under a workspace: ',
			'toast.failed': 'Import failed: ',
			'error.empty': 'the file is empty',
			'error.noTurns': 'the document has no user input quoted with >',
			'error.tooLarge': 'the file exceeds the import size limit',
			'error.badRequest': 'the file is not a readable Session Markdown transcript',
			'error.readFailed': 'the file could not be read',
			'error.unreachable': 'the DSH server could not be reached',
			'error.unavailable': 'session storage is not available in this deployment',
			'error.workspaceNotFound': 'the chosen workspace no longer exists',
			'error.attachFailed': 'the session could not be filed, so it stayed ungrouped',
			'error.writeFailed': 'the Session could not be written to storage',
			'error.unknown': 'an unexpected error occurred',
			'error.presetUnavailable': 'agent presets are not available in this deployment',
			'error.presetNotFound': 'the chosen preset no longer exists',
			'error.presetBroken': 'the chosen preset cannot be used right now'
		};
		/** Japanese dictionary, checked complete against the zh key set. */
		const ja = {
			'action.label': 'セッションをインポート',
			'action.busy': 'インポート中…',
			'picker.title': 'ワークスペースを選択',
			'picker.hint': 'インポートしたセッションは選択したワークスペースに属します',
			'picker.empty': '所属先となるワークスペースがありません',
			'picker.ungrouped': 'ワークスペースに属さずインポート',
			'picker.cancel': 'キャンセル',
			'preset.title': 'プリセットを選択',
			'preset.hint': 'セッションは選択したプリセットで動作します',
			'preset.loading': 'プリセットを読み込み中…',
			'preset.empty': 'この展開ではプリセットが提供されていません',
			'preset.default': '既定のプリセットを使用',
			'preset.isDefault': '既定',
			'preset.unfiled': 'ワークスペースなし',
			'preset.back': '戻る',
			'toast.success': 'セッションをインポートしました。開いています。',
			'toast.warning': 'インポートしましたがワークスペースに属せませんでした：',
			'toast.failed': 'インポートに失敗しました：',
			'error.empty': 'ファイルが空です',
			'error.noTurns': '「>」で引用されたユーザー入力が文書にありません',
			'error.tooLarge': 'ファイルがインポートのサイズ上限を超えています',
			'error.badRequest': 'セッション Markdown として読み取れないファイルです',
			'error.readFailed': 'ファイルを読み取れませんでした',
			'error.unreachable': 'DSH サーバーに接続できませんでした',
			'error.unavailable': 'この環境ではセッションストレージが利用できません',
			'error.workspaceNotFound': '選択したワークスペースは存在しません',
			'error.attachFailed': 'ワークスペースへの所属に失敗し、未分類のままです',
			'error.writeFailed': 'セッションをストレージに書き込めませんでした',
			'error.unknown': '不明なエラーが発生しました',
			'error.presetUnavailable': 'この環境ではプリセットが利用できません',
			'error.presetNotFound': '選択したプリセットは存在しません',
			'error.presetBroken': '選択したプリセットは現在使用できません'
		};
		/** Spanish dictionary, checked complete against the zh key set. */
		const es = {
			'action.label': 'Importar sesión',
			'action.busy': 'Importando…',
			'picker.title': 'Elegir un espacio de trabajo',
			'picker.hint': 'la sesión importada se archiva en el espacio que elijas',
			'picker.empty': 'no existe ningún espacio de trabajo donde archivarla',
			'picker.ungrouped': 'Importar sin espacio de trabajo',
			'picker.cancel': 'Cancelar',
			'preset.title': 'Elegir un preset',
			'preset.hint': 'la sesión usa la composición que elijas',
			'preset.loading': 'Leyendo presets…',
			'preset.empty': 'este despliegue no ofrece presets',
			'preset.default': 'Usar el preset predeterminado',
			'preset.isDefault': 'predeterminado',
			'preset.unfiled': 'sin espacio de trabajo',
			'preset.back': 'Atrás',
			'toast.success': 'Sesión importada. Abriéndola ahora.',
			'toast.warning': 'Sesión importada, pero sin archivar en un espacio de trabajo: ',
			'toast.failed': 'La importación falló: ',
			'error.empty': 'el archivo está vacío',
			'error.noTurns': 'el documento no tiene entradas de usuario citadas con >',
			'error.tooLarge': 'el archivo supera el límite de tamaño de importación',
			'error.badRequest': 'el archivo no es un Markdown de sesión legible',
			'error.readFailed': 'no se pudo leer el archivo',
			'error.unreachable': 'no se pudo contactar con el servidor DSH',
			'error.unavailable': 'el almacenamiento de sesiones no está disponible en este entorno',
			'error.workspaceNotFound': 'el espacio de trabajo elegido ya no existe',
			'error.attachFailed': 'no se pudo archivar, así que la sesión quedó sin agrupar',
			'error.writeFailed': 'no se pudo escribir la sesión en el almacenamiento',
			'error.unknown': 'se produjo un error inesperado',
			'error.presetUnavailable': 'los presets no están disponibles en este entorno',
			'error.presetNotFound': 'el preset elegido ya no existe',
			'error.presetBroken': 'el preset elegido no se puede usar ahora mismo'
		};
		/** French dictionary, checked complete against the zh key set. */
		const fr = {
			'action.label': 'Importer une session',
			'action.busy': 'Importation…',
			'picker.title': 'Choisir un espace de travail',
			'picker.hint': 'la session importée est classée dans l’espace choisi',
			'picker.empty': 'aucun espace de travail où la classer',
			'picker.ungrouped': 'Importer sans espace de travail',
			'picker.cancel': 'Annuler',
			'preset.title': 'Choisir un preset',
			'preset.hint': 'la session utilise la composition choisie',
			'preset.loading': 'Lecture des presets…',
			'preset.empty': 'ce déploiement ne fournit aucun preset',
			'preset.default': 'Utiliser le preset par défaut',
			'preset.isDefault': 'par défaut',
			'preset.unfiled': 'sans espace de travail',
			'preset.back': 'Retour',
			'toast.success': 'Session importée. Ouverture en cours.',
			'toast.warning': 'Session importée, mais non classée dans un espace de travail : ',
			'toast.failed': "L'importation a échoué : ",
			'error.empty': 'le fichier est vide',
			'error.noTurns': 'le document ne contient aucune saisie utilisateur citée avec >',
			'error.tooLarge': "le fichier dépasse la limite de taille d'importation",
			'error.badRequest': "le fichier n'est pas un Markdown de session lisible",
			'error.readFailed': 'le fichier n’a pas pu être lu',
			'error.unreachable': 'le serveur DSH est injoignable',
			'error.unavailable': "le stockage des sessions n'est pas disponible dans cet environnement",
			'error.workspaceNotFound': "l'espace de travail choisi n'existe plus",
			'error.attachFailed': 'le classement a échoué, la session reste non groupée',
			'error.writeFailed': "la session n'a pas pu être écrite dans le stockage",
			'error.unknown': "une erreur inattendue s'est produite",
			'error.presetUnavailable': 'les presets ne sont pas disponibles dans cet environnement',
			'error.presetNotFound': 'le preset choisi n\'existe plus',
			'error.presetBroken': 'le preset choisi n\'est pas utilisable pour l\'instant'
		};
		/** German dictionary, checked complete against the zh key set. */
		const de = {
			'action.label': 'Sitzung importieren',
			'action.busy': 'Wird importiert…',
			'picker.title': 'Arbeitsbereich wählen',
			'picker.hint': 'die importierte Sitzung wird dem gewählten Arbeitsbereich zugeordnet',
			'picker.empty': 'es gibt keinen Arbeitsbereich zum Zuordnen',
			'picker.ungrouped': 'Ohne Arbeitsbereich importieren',
			'picker.cancel': 'Abbrechen',
			'preset.title': 'Preset wählen',
			'preset.hint': 'die Sitzung nutzt die gewählte Zusammensetzung',
			'preset.loading': 'Presets werden gelesen…',
			'preset.empty': 'diese Umgebung stellt keine Presets bereit',
			'preset.default': 'Standard-Preset verwenden',
			'preset.isDefault': 'Standard',
			'preset.unfiled': 'ohne Arbeitsbereich',
			'preset.back': 'Zurück',
			'toast.success': 'Sitzung importiert. Sie wird jetzt geöffnet.',
			'toast.warning': 'Sitzung importiert, aber keinem Arbeitsbereich zugeordnet: ',
			'toast.failed': 'Import fehlgeschlagen: ',
			'error.empty': 'die Datei ist leer',
			'error.noTurns': 'das Dokument enthält keine mit > zitierte Benutzereingabe',
			'error.tooLarge': 'die Datei überschreitet die Größenbegrenzung für den Import',
			'error.badRequest': 'die Datei ist kein lesbares Sitzungs-Markdown',
			'error.readFailed': 'die Datei konnte nicht gelesen werden',
			'error.unreachable': 'der DSH-Server war nicht erreichbar',
			'error.unavailable': 'der Sitzungsspeicher ist in dieser Umgebung nicht verfügbar',
			'error.workspaceNotFound': 'der gewählte Arbeitsbereich existiert nicht mehr',
			'error.attachFailed': 'die Zuordnung schlug fehl, die Sitzung bleibt ungruppiert',
			'error.writeFailed': 'die Sitzung konnte nicht in den Speicher geschrieben werden',
			'error.unknown': 'ein unerwarteter Fehler ist aufgetreten',
			'error.presetUnavailable': 'Presets sind in dieser Umgebung nicht verfügbar',
			'error.presetNotFound': 'das gewählte Preset existiert nicht mehr',
			'error.presetBroken': 'das gewählte Preset ist derzeit nicht nutzbar'
		};
		/** Russian dictionary, checked complete against the zh key set. */
		const ru = {
			'action.label': 'Импортировать сеанс',
			'action.busy': 'Импорт…',
			'picker.title': 'Выберите рабочее пространство',
			'picker.hint': 'импортированный сеанс будет отнесён к выбранному пространству',
			'picker.empty': 'нет рабочего пространства, к которому его отнести',
			'picker.ungrouped': 'Импортировать без рабочего пространства',
			'picker.cancel': 'Отмена',
			'preset.title': 'Выберите пресет',
			'preset.hint': 'сеанс будет работать с выбранной композицией',
			'preset.loading': 'Чтение пресетов…',
			'preset.empty': 'в этом развёртывании пресеты не предоставлены',
			'preset.default': 'Использовать пресет по умолчанию',
			'preset.isDefault': 'по умолчанию',
			'preset.unfiled': 'без рабочего пространства',
			'preset.back': 'Назад',
			'toast.success': 'Сеанс импортирован. Открываем его.',
			'toast.warning': 'Сеанс импортирован, но не отнесён к рабочему пространству: ',
			'toast.failed': 'Не удалось импортировать: ',
			'error.empty': 'файл пуст',
			'error.noTurns': 'в документе нет ввода пользователя, выделенного знаком >',
			'error.tooLarge': 'файл превышает предельный размер для импорта',
			'error.badRequest': 'файл не читается как Markdown сеанса',
			'error.readFailed': 'не удалось прочитать файл',
			'error.unreachable': 'не удалось связаться с сервером DSH',
			'error.unavailable': 'хранилище сеансов недоступно в этой среде',
			'error.workspaceNotFound': 'выбранное рабочее пространство больше не существует',
			'error.attachFailed': 'отнести не удалось, сеанс остался вне группы',
			'error.writeFailed': 'не удалось записать сеанс в хранилище',
			'error.unknown': 'произошла неизвестная ошибка',
			'error.presetUnavailable': 'пресеты недоступны в этой среде',
			'error.presetNotFound': 'выбранный пресет больше не существует',
			'error.presetBroken': 'выбранный пресет сейчас непригоден'
		};
		/** Portuguese dictionary, checked complete against the zh key set. */
		const pt = {
			'action.label': 'Importar sessão',
			'action.busy': 'Importando…',
			'picker.title': 'Escolher um espaço de trabalho',
			'picker.hint': 'a sessão importada fica no espaço que você escolher',
			'picker.empty': 'não há espaço de trabalho para arquivá-la',
			'picker.ungrouped': 'Importar sem espaço de trabalho',
			'picker.cancel': 'Cancelar',
			'preset.title': 'Escolher um preset',
			'preset.hint': 'a sessão usa a composição que você escolher',
			'preset.loading': 'Lendo presets…',
			'preset.empty': 'este ambiente não oferece presets',
			'preset.default': 'Usar o preset padrão',
			'preset.isDefault': 'padrão',
			'preset.unfiled': 'sem espaço de trabalho',
			'preset.back': 'Voltar',
			'toast.success': 'Sessão importada. Abrindo agora.',
			'toast.warning': 'Sessão importada, mas não arquivada num espaço de trabalho: ',
			'toast.failed': 'A importação falhou: ',
			'error.empty': 'o arquivo está vazio',
			'error.noTurns': 'o documento não tem entrada do usuário citada com >',
			'error.tooLarge': 'o arquivo excede o limite de tamanho de importação',
			'error.badRequest': 'o arquivo não é um Markdown de sessão legível',
			'error.readFailed': 'não foi possível ler o arquivo',
			'error.unreachable': 'não foi possível contatar o servidor DSH',
			'error.unavailable': 'o armazenamento de sessões não está disponível neste ambiente',
			'error.workspaceNotFound': 'o espaço de trabalho escolhido não existe mais',
			'error.attachFailed': 'não foi possível arquivar, a sessão ficou sem grupo',
			'error.writeFailed': 'não foi possível gravar a sessão no armazenamento',
			'error.unknown': 'ocorreu um erro inesperado',
			'error.presetUnavailable': 'os presets não estão disponíveis neste ambiente',
			'error.presetNotFound': 'o preset escolhido não existe mais',
			'error.presetBroken': 'o preset escolhido não pode ser usado agora'
		};
		//#endregion
		//#region plugin
		/** Client services this plugin needs before it can register anything. */
		const inject = ['slots', 'locale'];
		/**
		* Provide the import controller and mount its footer action, workspace
		* question, and outcome toast.
		* @param ctx - client context carrying slots and locale services.
		*/
		function apply(ctx) {
			const controller = new ImportController(ctx);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en,
				ja,
				es,
				fr,
				de,
				ru,
				pt
			}), 'md-session-import: dictionaries');
			// The slot's own `t` is reactive; the bound translator covers a host that
			// renders the entry without one.
			const bound = ctx.locale.bind(NS);
			const t = (key) => {
				const text = bound(key);
				return typeof text === 'string' && text !== '' ? text : zh[key] ?? key;
			};
			const withTranslator = (render) => (props) => render({
				...props,
				t: typeof props.t === 'function' ? props.t : t
			});
			ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
				name: 'sidebar.footer.action',
				id: 'md-session-import',
				locale: NS,
				inject: () => ({
					store: controller.store,
					choose: (file, anchor) => controller.choose(file, anchor)
				})
			}, withTranslator(ImportAction)));
			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'md-session-import.picker',
				locale: NS,
				inject: () => ({
					store: controller.store,
					cancel: () => {
						controller.cancel();
					},
					chooseWorkspace: (workspaceId) => controller.chooseWorkspace(workspaceId),
					back: () => {
						controller.back();
					},
					confirm: (agentPreset) => controller.confirm(agentPreset)
				})
			}, withTranslator(ImportPicker)));
			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'md-session-import.toast',
				locale: NS,
				inject: () => ({
					store: controller.store,
					dismiss: () => {
						controller.dismiss();
					}
				})
			}, withTranslator(ImportToast)));
		}
		//#endregion
		return {
			inject,
			apply
		};
	}
});
