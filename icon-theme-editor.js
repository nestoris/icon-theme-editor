#!/usr/bin/gjs

imports.gi.versions.Gtk = '3.0';
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const GdkPixbuf = imports.gi.GdkPixbuf;
const System = imports.system;
const Gettext = imports.gettext;

Gtk.init(null);

// ==================== НАСТРОЙКА ЛОКАЛИЗАЦИИ ====================
const APP_DOMAIN = 'icon-theme-editor';
const LOCALE_DIR = 'locale';

Gettext.bindtextdomain(APP_DOMAIN, LOCALE_DIR);
Gettext.textdomain(APP_DOMAIN);

function _(str) {
	return Gettext.dgettext(APP_DOMAIN, str);
}

function formatString(str, ...args) {
	let result = str;
	for (let i = 0; i < args.length; i++) {
		result = result.replace('%s', args[i]);
		result = result.replace('%d', args[i]);
	}
	return result;
}

// ==================== КЛАСС ICONPROPERTIESWINDOW ====================
class IconPropertiesWindow {
	constructor(app, iconName) {
		this.app = app;
		this.iconName = iconName;
		this.themeDir = app.themeDir;
		this.icon = app.icons.find(i => i.name === iconName);
		this.tabWidgets = new Map();
		this.reverseIndex = null;

		this.window = new Gtk.Window({
			title: formatString(_('Properties: %s'), iconName),
			default_width: 900,
			default_height: 680,
			transient_for: app.window,
			modal: true,
			window_position: Gtk.WindowPosition.CENTER_ON_PARENT
		});

		this.buildUI();
		this.buildReverseIndex();
		this.refresh();
		this.window.show_all();
	}

	// ==================== ИЗВЛЕЧЕНИЕ РАЗМЕРА ИЗ ПУТИ ====================

	getDirSize(dirName) {
			if (!dirName) return '';
			let info = this.app.directoryInfo.get(dirName);
			if (!info || info.size === null || info.size === undefined) return '';
			return String(info.size);
	}

	getSizeOfFile(filePath) {
			let dirName = GLib.path_get_dirname(filePath);
			return this.getDirSize(dirName);
	}
	// ==================== ЗАГРУЗКА ПРЕВЬЮ В СВОЙСТВАХ ====================
	loadPreviewPixbuf(absPath, size) {
		  try {
		      // 1. Читаем файл в натуральную величину — без интерполяции
		      let raw = GdkPixbuf.Pixbuf.new_from_file(absPath);

		      let w = raw.get_width();
		      let h = raw.get_height();

		      // 2. Если размер уже совпадает — возвращаем как есть
		      if (w === size && h === size) return raw;

		      // 3. Масштабируем без сглаживания (NEAREST) с сохранением пропорций
		      let scale = Math.min(size / w, size / h);
		      let newW = Math.max(1, Math.round(w * scale));
		      let newH = Math.max(1, Math.round(h * scale));

		      let scaled = raw.scale_simple(newW, newH, GdkPixbuf.InterpType.NEAREST);

		      // 4. Если получилось меньше size×size — центрируем на прозрачном полотне
		      if (newW === size && newH === size) return scaled;

		      let canvas = GdkPixbuf.Pixbuf.new(
		          GdkPixbuf.Colorspace.RGB, true, 8, size, size);
		      canvas.fill(0x00000000);
		      scaled.copy_area(
		          0, 0, newW, newH, canvas,
		          Math.floor((size - newW) / 2),
		          Math.floor((size - newH) / 2)
		      );
		      return canvas;
		  } catch (e) {
		      return null;
		  }
	}

	// ==================== ПОСТРОЕНИЕ ИНТЕРФЕЙСА ====================
	buildUI() {
		let mainBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 5,
			margin: 5
		});

		// Шапка
		let headerBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 10
		});

		this.headerImage = new Gtk.Image();
		this.headerImage.set_size_request(64, 64);
		headerBox.pack_start(this.headerImage, false, false, 0);

		let infoBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 3
		});

		this.titleLabel = new Gtk.Label({
			label: '',
			use_markup: true,
			halign: Gtk.Align.START
		});
		infoBox.pack_start(this.titleLabel, false, false, 0);

		this.summaryLabel = new Gtk.Label({
			label: '',
			halign: Gtk.Align.START
		});
		infoBox.pack_start(this.summaryLabel, false, false, 0);

		headerBox.pack_start(infoBox, true, true, 0);

		let refreshButton = new Gtk.Button({ label: _('Refresh') });
		refreshButton.set_tooltip_text(_('Re-read files and symlinks of this icon from disk, then rebuild the referenced-by index.'));
		refreshButton.connect('clicked', () => {
			this.app.refreshIcon(this.iconName);
			this.buildReverseIndex();
			this.refresh();
		});
		headerBox.pack_start(refreshButton, false, false, 0);

		mainBox.pack_start(headerBox, false, false, 0);

		// Notebook
		this.notebook = new Gtk.Notebook();
		this.notebook.set_tooltip_text(_('One tab per icon context found in index.theme. Operations apply only to the current tab.'));
		mainBox.pack_start(this.notebook, true, true, 0);

		// Статусбар
		this.statusbar = new Gtk.Statusbar();
		this.statusContextId = this.statusbar.get_context_id('props');
		mainBox.pack_start(this.statusbar, false, false, 0);

		// Кнопка закрытия
		let bottomBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 5
		});
		bottomBox.pack_start(new Gtk.Label({ label: '' }), true, true, 0);

		let closeButton = new Gtk.Button({ label: _('Close') });
		closeButton.set_tooltip_text(_('Close this window. Any changes already applied stay on disk.'));
		closeButton.connect('clicked', () => this.window.destroy());
		bottomBox.pack_start(closeButton, false, false, 0);

		mainBox.pack_start(bottomBox, false, false, 0);

		this.window.add(mainBox);
	}

	// ==================== ОБНОВЛЕНИЕ ОКНА ====================
	refresh() {
		this.icon = this.app.icons.find(i => i.name === this.iconName);
		if (!this.icon) {
			this.window.destroy();
			return;
		}

		this.updateHeader();

		// Очистить notebook
		let n = this.notebook.get_n_pages();
		for (let i = n - 1; i >= 0; i--) {
			let child = this.notebook.get_nth_page(i);
			this.notebook.remove_page(i);
			if (child) child.destroy();
		}
		this.tabWidgets.clear();

		let contexts = this.getIconContexts(this.icon);

		for (let [context, dirs] of contexts) {
			let tabWidgets = this.buildTab(context, dirs);
			this.tabWidgets.set(context, tabWidgets);

			let tabLabel = new Gtk.Label({ label: context });
			this.notebook.append_page(tabWidgets.mainBox, tabLabel);
		}

		this.notebook.show_all();
	}

		updateHeader() {
				let files = this.icon.realFiles.size;
				let symlinks = this.icon.symlinks.size;
				let contexts = new Set(this.icon.directories.values()).size;

				let escapedName = this.iconName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
				this.titleLabel.set_markup('<b>' + escapedName + '</b>');

				this.summaryLabel.set_text(formatString(
				    _('%d files, %d symlinks, %d contexts'),
				    files, symlinks, contexts
				));

				this.headerImage.set_from_pixbuf(null);
		}

	// ==================== ГРУППИРОВКА ПО КОНТЕКСТАМ ====================
	getIconContexts(icon) {
		let contexts = new Map();
		for (let [dir, context] of icon.directories) {
			if (!contexts.has(context)) contexts.set(context, []);
			contexts.get(context).push(dir);
		}
		let sorted = new Map([...contexts.entries()].sort());
		for (let [_k, dirs] of sorted) dirs.sort();
		return sorted;
	}

getFilesInContext(dirs) {
    let files = [];

    for (let [path, target] of this.icon.symlinks) {
        let dir = GLib.path_get_dirname(path);   // ← было path.split('/')[0]
        if (dirs.includes(dir)) {
            files.push({ path: path, isSymlink: true, target: target });
        }
    }

    for (let [path, _v] of this.icon.realFiles) {
        let dir = GLib.path_get_dirname(path);   // ← было path.split('/')[0]
        if (dirs.includes(dir)) {
            files.push({ path: path, isSymlink: false, target: null });
        }
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
}

	// ==================== ПОСТРОЕНИЕ ВКЛАДКИ ====================
buildTab(context, dirs) {
    let mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin: 5
    });

    // ==================== ЛЕВАЯ ЧАСТЬ: файлы ====================
    let filesLabel = new Gtk.Label({
        label: '<b>' + _('Files in this context') + '</b>',
        use_markup: true,
        halign: Gtk.Align.START
    });
    filesLabel.set_tooltip_text(_('Physical files and symlinks of this icon in directories belonging to the selected context. Ctrl+click for multi-select.'));

    // Оборачиваем label+таблицу в вертикальный box
    let filesBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 3,
        hexpand: true,
        vexpand: true
    });
    filesBox.pack_start(filesLabel, false, false, 0);

    let filesStore = new Gtk.ListStore();
    filesStore.set_column_types([
        GdkPixbuf.Pixbuf,      // 0: thumbnail
        GObject.TYPE_STRING,   // 1: path
        GObject.TYPE_STRING,   // 2: type
        GObject.TYPE_STRING,   // 3: target
        GObject.TYPE_STRING,   // 4: status
        GObject.TYPE_STRING    // 5: size
    ]);

    let filesView = new Gtk.TreeView({ model: filesStore, headers_clickable: true });

    // МНОЖЕСТВЕННОЕ ВЫДЕЛЕНИЕ
    filesView.get_selection().set_mode(Gtk.SelectionMode.MULTIPLE);

    let pixRenderer = new Gtk.CellRendererPixbuf();
    let pixColumn = new Gtk.TreeViewColumn({ title: '' });
    pixColumn.pack_start(pixRenderer, false);
    pixColumn.add_attribute(pixRenderer, 'pixbuf', 0);
    filesView.append_column(pixColumn);

    let pathRenderer = new Gtk.CellRendererText();
    let pathColumn = new Gtk.TreeViewColumn({ title: _('Path') });
    pathColumn.pack_start(pathRenderer, true);
    pathColumn.add_attribute(pathRenderer, 'text', 1);
    pathColumn.set_resizable(true);
    pathColumn.set_expand(true);
    pathColumn.set_min_width(160);
    pathColumn.set_sort_column_id(1);
    pathColumn.set_clickable(true);
    pathRenderer.set_property('ellipsize', 3);
    filesView.append_column(pathColumn);

    let sizeRenderer = new Gtk.CellRendererText();
    let sizeColumn = new Gtk.TreeViewColumn({ title: _('Size') });
    sizeColumn.pack_start(sizeRenderer, false);
    sizeColumn.add_attribute(sizeRenderer, 'text', 5);
    sizeColumn.set_min_width(50);
    sizeColumn.set_resizable(true);
    sizeColumn.set_sort_column_id(5);
    sizeColumn.set_clickable(true);
    filesView.append_column(sizeColumn);

    let typeRenderer = new Gtk.CellRendererText();
    let typeColumn = new Gtk.TreeViewColumn({ title: _('Type') });
    typeColumn.pack_start(typeRenderer, false);
    typeColumn.add_attribute(typeRenderer, 'text', 2);
    typeColumn.set_min_width(70);
    typeColumn.set_resizable(true);
    typeColumn.set_sort_column_id(2);
    typeColumn.set_clickable(true);
    filesView.append_column(typeColumn);

    let targetRenderer = new Gtk.CellRendererText();
    let targetColumn = new Gtk.TreeViewColumn({ title: _('Target') });
    targetColumn.pack_start(targetRenderer, true);
    targetColumn.add_attribute(targetRenderer, 'text', 3);
    targetColumn.set_min_width(130);
    targetColumn.set_resizable(true);
    targetColumn.set_expand(true);
    targetColumn.set_sort_column_id(3);
    targetColumn.set_clickable(true);
    targetRenderer.set_property('ellipsize', 3);
    filesView.append_column(targetColumn);

    let statusRenderer = new Gtk.CellRendererText();
    let statusColumn = new Gtk.TreeViewColumn({ title: _('Status') });
    statusColumn.pack_start(statusRenderer, false);
    statusColumn.add_attribute(statusRenderer, 'text', 4);
    statusColumn.set_min_width(80);
    statusColumn.set_resizable(true);
    statusColumn.set_sort_column_id(4);
    statusColumn.set_clickable(true);
    filesView.append_column(statusColumn);

    let filesScroll = new Gtk.ScrolledWindow();
    filesScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
    filesScroll.set_size_request(430, -1);
    filesScroll.add(filesView);
    filesBox.pack_start(filesScroll, true, true, 0);

    mainBox.pack_start(filesBox, true, true, 0);

    // ==================== ПРАВАЯ ЧАСТЬ: ссылающиеся симлинки ====================
    let refsBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 3,
        hexpand: true,
        vexpand: true
    });

    let refsLabel = new Gtk.Label({
        label: '<b>' + _('Referenced by') + '</b>',
        use_markup: true,
        halign: Gtk.Align.START
    });
    refsLabel.set_tooltip_text(_('All symlinks across the whole theme that point to physical files listed on the left. If any rows are selected on the left, only symlinks pointing to those rows are shown.'));
    refsBox.pack_start(refsLabel, false, false, 0);

    let refsStore = new Gtk.ListStore();
    refsStore.set_column_types([
        GObject.TYPE_STRING,   // 0: physical file
        GObject.TYPE_STRING,   // 1: referrer
        GObject.TYPE_STRING,   // 2: icon
        GObject.TYPE_STRING,   // 3: size
        GObject.TYPE_STRING    // 4: context
    ]);

    let refsView = new Gtk.TreeView({ model: refsStore, headers_clickable: true });

    let physRenderer = new Gtk.CellRendererText();
    let physColumn = new Gtk.TreeViewColumn({ title: _('Physical file') });
    physColumn.pack_start(physRenderer, true);
    physColumn.add_attribute(physRenderer, 'text', 0);
    physColumn.set_resizable(true);
    physColumn.set_expand(true);
    physColumn.set_min_width(160);
    physColumn.set_sort_column_id(0);
    physColumn.set_clickable(true);
    physRenderer.set_property('ellipsize', 3);
    refsView.append_column(physColumn);

    let refSizeRenderer = new Gtk.CellRendererText();
    let refSizeColumn = new Gtk.TreeViewColumn({ title: _('Size') });
    refSizeColumn.pack_start(refSizeRenderer, false);
    refSizeColumn.add_attribute(refSizeRenderer, 'text', 3);
    refSizeColumn.set_min_width(50);
    refSizeColumn.set_resizable(true);
    refSizeColumn.set_sort_column_id(3);
    refSizeColumn.set_clickable(true);
    refsView.append_column(refSizeColumn);

    let refRenderer = new Gtk.CellRendererText();
    let refColumn = new Gtk.TreeViewColumn({ title: _('Referrer') });
    refColumn.pack_start(refRenderer, true);
    refColumn.add_attribute(refRenderer, 'text', 1);
    refColumn.set_resizable(true);
    refColumn.set_expand(true);
    refColumn.set_min_width(160);
    refColumn.set_sort_column_id(1);
    refColumn.set_clickable(true);
    refRenderer.set_property('ellipsize', 3);
    refsView.append_column(refColumn);

    let refIconRenderer = new Gtk.CellRendererText();
    let refIconColumn = new Gtk.TreeViewColumn({ title: _('Icon') });
    refIconColumn.pack_start(refIconRenderer, false);
    refIconColumn.add_attribute(refIconRenderer, 'text', 2);
    refIconColumn.set_min_width(110);
    refIconColumn.set_resizable(true);
    refIconColumn.set_sort_column_id(2);
    refIconColumn.set_clickable(true);
    refsView.append_column(refIconColumn);

    let refContextRenderer = new Gtk.CellRendererText();
    let refContextColumn = new Gtk.TreeViewColumn({ title: _('Context') });
    refContextColumn.pack_start(refContextRenderer, false);
    refContextColumn.add_attribute(refContextRenderer, 'text', 4);
    refContextColumn.set_min_width(90);
    refContextColumn.set_resizable(true);
    refContextColumn.set_sort_column_id(4);
    refContextColumn.set_clickable(true);
    refsView.append_column(refContextColumn);

    let refsScroll = new Gtk.ScrolledWindow();
    //refsScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
    refsScroll.add(refsView);
    refsBox.pack_start(refsScroll, true, true, 0);

    mainBox.pack_start(refsBox, true, true, 0);

    // ==================== ОПЕРАЦИИ (внизу, во всю ширину) ====================
    let opsBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5 });

    let masterButton = new Gtk.Button({ label: _('Master file...') });
    masterButton.set_tooltip_text(_('Choose one physical file as the master. All other files and symlinks in this context will be re-pointed to it.'));
    masterButton.connect('clicked', () => this.applyMaster(context));
    opsBox.pack_start(masterButton, false, false, 0);

    let toFilesButton = new Gtk.Button({ label: _('All to files') });
    toFilesButton.set_tooltip_text(_('Replace every symlink in this context with a physical copy of its target.'));
    toFilesButton.connect('clicked', () => this.allToFiles(context));
    opsBox.pack_start(toFilesButton, false, false, 0);

    let unchainButton = new Gtk.Button({ label: _('Unchain') });
    unchainButton.set_tooltip_text(_('For every symlink that points to another symlink, re-target it directly to the final physical file.'));
    unchainButton.connect('clicked', () => this.unchain(context));
    opsBox.pack_start(unchainButton, false, false, 0);

    let removeBrokenButton = new Gtk.Button({ label: _('Remove broken') });
    removeBrokenButton.set_tooltip_text(_('Delete symlinks in this context whose target file no longer exists.'));
    removeBrokenButton.connect('clicked', () => this.removeBroken(context));
    opsBox.pack_start(removeBrokenButton, false, false, 0);

    // ==================== ИТОГОВАЯ ВЁРСТКА ====================
    let outerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 5,
        margin: 5
    });

    outerBox.pack_start(mainBox, true, true, 0);
    outerBox.pack_start(opsBox, false, false, 0);

    let tabWidgets = {
        mainBox: outerBox,
        context: context,
        dirs: dirs,
        filesStore: filesStore,
        filesView: filesView,
        refsStore: refsStore,
        refsView: refsView
    };

    // Обработчик выделения в filesView — перезаполняет refsStore
    filesView.get_selection().connect('changed', () => {
        this.updateRefsFromSelection(tabWidgets);
    });

    this.populateTab(tabWidgets);
    return tabWidgets;
}

	// ==================== ЗАПОЛНЕНИЕ ВКЛАДКИ ====================
populateTab(tabWidgets) {
    let filesStore = tabWidgets.filesStore;
    filesStore.clear();

    let files = this.getFilesInContext(tabWidgets.dirs);

    for (let file of files) {
        let iter = filesStore.append();

        let pixbuf = this.loadPreviewPixbuf(
            this.themeDir + '/' + file.path, 32);

        let typeText = file.isSymlink ? _('symlink') : _('file');
        let sizeText = this.getSizeOfFile(file.path);

        let status = 'OK';
        if (file.isSymlink) {
            let resolved = this.resolveSymlink(file.path, file.target);
            let absTarget = this.themeDir + '/' + resolved;
            let targetFile = Gio.File.new_for_path(absTarget);
            if (!targetFile.query_exists(null)) {
                status = _('Broken');
            } else {
                try {
                    let ti = targetFile.query_info('standard::is-symlink',
                        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                    if (ti.get_is_symlink()) status = _('Chain');
                } catch (e) { /* ignore */ }
            }
        }

        filesStore.set(iter, [0, 1, 2, 3, 4, 5],
            [pixbuf, file.path, typeText, file.target || '', status, sizeText]);
    }

    filesStore.set_sort_column_id(1, Gtk.SortType.ASCENDING);
    tabWidgets.refsStore.set_sort_column_id(0, Gtk.SortType.ASCENDING);

    // Начальное состояние: ничего не выделено → правая показывает все ссылки
    this.updateRefsFromSelection(tabWidgets);
}

	// ==================== ОБНОВЛЕНИЕ ОБРАТНЫХ ИЗ ВЫДЕЛЕНИЯ ====================
updateRefsFromSelection(tabWidgets) {
    let refsStore = tabWidgets.refsStore;
    refsStore.clear();

    if (!this.reverseIndex) return;

    // Собираем все физические файлы вкладки (не симлинки)
    let allPhysical = [];
    for (let [path, _v] of this.icon.realFiles) {
        let dir = GLib.path_get_dirname(path);
        if (tabWidgets.dirs.indexOf(dir) < 0) continue;
        allPhysical.push(path);
    }

    // Какие сейчас выделены?
let sel = tabWidgets.filesView.get_selection();
let model = sel.get_tree_view().get_model();
let paths = sel.get_selected_rows(null)[0];
    let selectedPhysical = [];
    let seen = {};
    for (let i = 0; i < paths.length; i++) {
        let iter = model.get_iter(paths[i]);
        if (!iter) continue;
        let typeText = model.get_value(iter, 2); // type
        // Симлинки не могут быть целью ссылки (мы не строим ссылки на симлинки).
        // Оставляем только физические файлы:
        if (typeText !== _('file')) continue;
        let p = model.get_value(iter, 1);
        if (!seen[p]) { seen[p] = true; selectedPhysical.push(p); }
    }

    let sourceList = selectedPhysical.length > 0 ? selectedPhysical : allPhysical;
    sourceList.sort();

    for (let si = 0; si < sourceList.length; si++) {
        let filePath = sourceList[si];
        let refs = this.reverseIndex.get(filePath) || [];
        let physicalSize = this.getSizeOfFile(filePath);

        for (let ri = 0; ri < refs.length; ri++) {
            let ref = refs[ri];
            let iter = refsStore.append();

            let context = '';
            let refIcon = this.app.icons.find(function(i) { return i.name === ref.iconName; });
            if (refIcon) {
                let refDir = GLib.path_get_dirname(ref.symlinkPath);
                context = refIcon.directories.get(refDir) || '';
            }

            refsStore.set(iter, [0, 1, 2, 3, 4],
                [filePath, ref.symlinkPath, ref.iconName, physicalSize, context]);
        }
    }
}

	// ==================== ИНДЕКС ОБРАТНЫХ ССЫЛОК ====================
	buildReverseIndex() {
		this.reverseIndex = new Map();

		for (let icon of this.app.icons) {
			for (let [symlinkPath, target] of icon.symlinks) {
				try {
					let resolved = this.resolveSymlink(symlinkPath, target);
					if (!this.reverseIndex.has(resolved)) {
						this.reverseIndex.set(resolved, []);
					}
					this.reverseIndex.get(resolved).push({
						symlinkPath: symlinkPath,
						iconName: icon.name
					});
				} catch (e) { /* ignore */ }
			}
		}
	}

	// ==================== УТИЛИТЫ ПУТЕЙ ====================
	resolveSymlink(symlinkPath, target) {
		let dir = GLib.path_get_dirname(symlinkPath);
		let fromFile = Gio.File.new_for_path(this.themeDir + '/' + dir);
		let resolved = fromFile.resolve_relative_path(target);
		let abs = resolved.get_path();
		if (abs.startsWith(this.themeDir + '/')) {
			return abs.substring(this.themeDir.length + 1);
		}
		return abs;
	}

	relativePath(fromDir, toPath) {
		let from = fromDir.split('/').filter(Boolean);
		let to = toPath.split('/').filter(Boolean);
		let common = 0;
		while (common < from.length && common < to.length - 1
			   && from[common] === to[common]) common++;
		let up = new Array(from.length - common).fill('..');
		return up.concat(to.slice(common)).join('/');
	}

	resolveChain(path) {
		let current = path;
		let seen = new Set();
		let maxDepth = 20;

		while (maxDepth-- > 0) {
			if (seen.has(current)) return null;
			seen.add(current);

			let abs = this.themeDir + '/' + current;
			let file = Gio.File.new_for_path(abs);

			try {
				let info = file.query_info('standard::is-symlink',
					Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
				if (!info.get_is_symlink()) return current;

				let targetInfo = file.query_info('standard::symlink-target',
					Gio.FileQueryInfoFlags.NONE, null);
				let target = targetInfo.get_symlink_target();
				if (!target) return null;

				let dir = GLib.path_get_dirname(current);
				let fromFile = Gio.File.new_for_path(this.themeDir + '/' + dir);
				let resolved = fromFile.resolve_relative_path(target);
				let absResolved = resolved.get_path();

				if (absResolved.startsWith(this.themeDir + '/')) {
					current = absResolved.substring(this.themeDir.length + 1);
				} else {
					return absResolved;
				}
			} catch (e) {
				return null;
			}
		}
		return null;
	}

	// ==================== ОПЕРАЦИЯ: МАСТЕР-ФАЙЛ ====================
	applyMaster(context) {
		let tabWidgets = this.tabWidgets.get(context);
		if (!tabWidgets) return;

		let files = this.getFilesInContext(tabWidgets.dirs);
		let realFiles = files.filter(f => !f.isSymlink);

		if (realFiles.length === 0) {
			this.showMessage(_('No physical files in this context. Cannot choose a master.'));
			return;
		}

		// Диалог выбора мастера
		let dialog = new Gtk.Dialog({
			title: _('Choose master file'),
			transient_for: this.window,
			modal: true,
			destroy_with_parent: true
		});
		dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
		dialog.add_button(_('OK'), Gtk.ResponseType.OK);
		dialog.set_default_response(Gtk.ResponseType.OK);

		let content = dialog.get_content_area();
		content.set_spacing(5);
		content.set_margin_start(10);
		content.set_margin_end(10);
		content.set_margin_top(10);
		content.set_margin_bottom(10);

		let label = new Gtk.Label({
			label: _('Choose a file to become the master. Other files in this context will become symlinks to it.'),
			halign: Gtk.Align.START,
			wrap: true
		});
		content.pack_start(label, false, false, 0);

		let scrolled = new Gtk.ScrolledWindow();
		scrolled.set_size_request(400, 220);

		let store = new Gtk.ListStore();
		store.set_column_types([GObject.TYPE_STRING]);

		let view = new Gtk.TreeView({ model: store });
		let renderer = new Gtk.CellRendererText();
		let column = new Gtk.TreeViewColumn({ title: _('File') });
		column.pack_start(renderer, true);
		column.add_attribute(renderer, 'text', 0);
		view.append_column(column);

		for (let file of realFiles) {
			let iter = store.append();
			store.set(iter, [0], [file.path]);
		}

		let selection = view.get_selection();
		selection.set_mode(Gtk.SelectionMode.SINGLE);
		let firstIter = store.get_iter_first();
		if (firstIter) selection.select_iter(firstIter);

		scrolled.add(view);
		content.pack_start(scrolled, true, true, 0);
		dialog.show_all();

		let response = dialog.run();
		let chosenPath = null;
		if (response === Gtk.ResponseType.OK) {
			let [ok, model, iter] = selection.get_selected();
			if (ok) chosenPath = model.get_value(iter, 0);
		}
		dialog.destroy();

		if (!chosenPath) return;

		let affected = 0;
		let errors = [];

		for (let file of files) {
			if (file.path === chosenPath) continue;

			try {
				let absPath = this.themeDir + '/' + file.path;
				let dirOfFile = GLib.path_get_dirname(file.path);
				let relTarget = this.relativePath(dirOfFile, chosenPath);

				// Проверка: не указывает ли уже симлинк на мастера
				if (file.isSymlink) {
					let resolved = this.resolveSymlink(file.path, file.target);
					if (resolved === chosenPath) continue;
				}

				let fileObj = Gio.File.new_for_path(absPath);
				fileObj.delete(null);
				fileObj.make_symbolic_link(relTarget, null);
				affected++;
			} catch (e) {
				errors.push(file.path + ': ' + e.message);
			}
		}

		this.setStatus(formatString(_('Converted %d files to symlinks'), affected));
		if (errors.length > 0) {
			this.showMessage(_('Errors:') + '\n' + errors.join('\n'));
		}

		this.app.refreshIcon(this.iconName);
		this.buildReverseIndex();
		this.refresh();
	}

	// ==================== ОПЕРАЦИЯ: ВСЁ В ФАЙЛЫ ====================
	allToFiles(context) {
		let tabWidgets = this.tabWidgets.get(context);
		if (!tabWidgets) return;

		let files = this.getFilesInContext(tabWidgets.dirs);
		let symlinks = files.filter(f => f.isSymlink);

		if (symlinks.length === 0) {
			this.showMessage(_('No symlinks in this context.'));
			return;
		}

		if (!this.confirmDialog(
			formatString(_('Convert %d symlinks to physical files?'), symlinks.length),
			_('Each symlink will be replaced with a copy of its target file.')
		)) return;

		let affected = 0;
		let errors = [];

		for (let file of symlinks) {
			try {
				let absPath = this.themeDir + '/' + file.path;
				let resolved = this.resolveSymlink(file.path, file.target);
				let absTarget = this.themeDir + '/' + resolved;

				let targetFile = Gio.File.new_for_path(absTarget);
				let symlinkFile = Gio.File.new_for_path(absPath);

				if (!targetFile.query_exists(null)) {
					errors.push(file.path + ': target does not exist');
					continue;
				}

				targetFile.copy(symlinkFile, Gio.FileCopyFlags.OVERWRITE, null, null);
				affected++;
			} catch (e) {
				errors.push(file.path + ': ' + e.message);
			}
		}

		this.setStatus(formatString(_('Converted %d symlinks to files'), affected));
		if (errors.length > 0) {
			this.showMessage(_('Errors:') + '\n' + errors.join('\n'));
		}

		this.app.refreshIcon(this.iconName);
		this.buildReverseIndex();
		this.refresh();
	}

	// ==================== ОПЕРАЦИЯ: РАЗВЕРНУТЬ ЦЕПОЧКИ ====================
	unchain(context) {
		let tabWidgets = this.tabWidgets.get(context);
		if (!tabWidgets) return;

		let files = this.getFilesInContext(tabWidgets.dirs);
		let symlinks = files.filter(f => f.isSymlink);

		let toFix = [];
		for (let file of symlinks) {
			let resolved = this.resolveSymlink(file.path, file.target);
			let finalPath = this.resolveChain(resolved);
			if (finalPath && finalPath !== resolved) {
				toFix.push({ file: file, finalPath: finalPath });
			}
		}

		if (toFix.length === 0) {
			this.showMessage(_('No symlink chains found.'));
			return;
		}

		if (!this.confirmDialog(
			formatString(_('Fix %d symlink chains?'), toFix.length),
			_('Each symlink pointing to another symlink will be re-targeted directly to the final file.')
		)) return;

		let affected = 0;
		let errors = [];

		for (let item of toFix) {
			let file = item.file;
			let finalPath = item.finalPath;
			try {
				let absPath = this.themeDir + '/' + file.path;
				let dirOfFile = GLib.path_get_dirname(file.path);
				let relTarget = this.relativePath(dirOfFile, finalPath);

				let fileObj = Gio.File.new_for_path(absPath);
				fileObj.delete(null);
				fileObj.make_symbolic_link(relTarget, null);
				affected++;
			} catch (e) {
				errors.push(file.path + ': ' + e.message);
			}
		}

		this.setStatus(formatString(_('Fixed %d chains'), affected));
		if (errors.length > 0) {
			this.showMessage(_('Errors:') + '\n' + errors.join('\n'));
		}

		this.app.refreshIcon(this.iconName);
		this.buildReverseIndex();
		this.refresh();
	}

	// ==================== ОПЕРАЦИЯ: УДАЛИТЬ БИТЫЕ ====================
	removeBroken(context) {
		let tabWidgets = this.tabWidgets.get(context);
		if (!tabWidgets) return;

		let files = this.getFilesInContext(tabWidgets.dirs);
		let broken = [];

		for (let file of files) {
			if (!file.isSymlink) continue;
			let resolved = this.resolveSymlink(file.path, file.target);
			let absTarget = this.themeDir + '/' + resolved;
			if (!Gio.File.new_for_path(absTarget).query_exists(null)) {
				broken.push(file);
			}
		}

		if (broken.length === 0) {
			this.showMessage(_('No broken symlinks in this context.'));
			return;
		}

		let listText = broken.map(b => b.path).join('\n');
		if (!this.confirmDialog(
			formatString(_('Delete %d broken symlinks?'), broken.length),
			listText
		)) return;

		let affected = 0;
		let errors = [];

		for (let file of broken) {
			try {
				let abs = this.themeDir + '/' + file.path;
				Gio.File.new_for_path(abs).delete(null);
				affected++;
			} catch (e) {
				errors.push(file.path + ': ' + e.message);
			}
		}

		this.setStatus(formatString(_('Removed %d broken symlinks'), affected));
		if (errors.length > 0) {
			this.showMessage(_('Errors:') + '\n' + errors.join('\n'));
		}

		this.app.refreshIcon(this.iconName);
		this.buildReverseIndex();
		this.refresh();
	}

	// ==================== ДИАЛОГИ ====================
	confirmDialog(text, secondary) {
		let dialog = new Gtk.MessageDialog({
			transient_for: this.window,
			modal: true,
			message_type: Gtk.MessageType.QUESTION,
			buttons: Gtk.ButtonsType.YES_NO,
			text: text,
			secondary_text: secondary
		});
		let response = dialog.run();
		dialog.destroy();
		return response === Gtk.ResponseType.YES;
	}

	showMessage(text) {
		let dialog = new Gtk.MessageDialog({
			transient_for: this.window,
			modal: true,
			message_type: Gtk.MessageType.INFO,
			buttons: Gtk.ButtonsType.OK,
			text: text
		});
		dialog.run();
		dialog.destroy();
	}

	setStatus(msg) {
		this.statusbar.remove_all(this.statusContextId);
		this.statusbar.push(this.statusContextId, msg);
	}
}

// ==================== КЛАСС RecreateSymlinksDialog ====================
class RecreateSymlinksDialog {
    constructor(app) {
        this.app = app;
        this.contextItems = [];   // [{label, context, topDir}]
        this.rows = [];

        this.window = new Gtk.Window({
            title: _('Recreate Symlinks'),
            default_width: 900,
            default_height: 600,
            transient_for: app.window,
            modal: true,
            window_position: Gtk.WindowPosition.CENTER_ON_PARENT
        });

        this.buildUI();
        this.window.show_all();
        this.update();
    }

    buildUI() {
        let mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin: 8
        });

        // ------- Форма -------
        let form = new Gtk.Grid({ row_spacing: 4, column_spacing: 8 });

        form.attach(new Gtk.Label({
            label: _('Physical (master) name:'),
            halign: Gtk.Align.START
        }), 0, 0, 1, 1);

        this.masterEntry = new Gtk.Entry({ hexpand: true });
        this.masterEntry.connect('changed', () => this.update());
        form.attach(this.masterEntry, 1, 0, 2, 1);

        form.attach(new Gtk.Label({
            label: _('Symlink name:'),
            halign: Gtk.Align.START
        }), 0, 1, 1, 1);

        this.symlinkEntry = new Gtk.Entry({ hexpand: true });
        this.symlinkEntry.connect('changed', () => this.update());
        form.attach(this.symlinkEntry, 1, 1, 2, 1);

        this.sameDirCheck = new Gtk.CheckButton({
            label: _('In the same directory as master')
        });
        this.sameDirCheck.set_active(true);
        this.sameDirCheck.set_tooltip_text(_(
            'If checked, each symlink will be created next to the master file of the same size. ' +
            'If unchecked, choose a different context below.'));
        this.sameDirCheck.connect('toggled', () => this.update());
        form.attach(this.sameDirCheck, 0, 2, 3, 1);

        form.attach(new Gtk.Label({
            label: _('Target context:'),
            halign: Gtk.Align.START
        }), 0, 3, 1, 1);

        this.contextCombo = new Gtk.ComboBoxText({ hexpand: true });
        this.contextCombo.connect('changed', () => this.update());
        form.attach(this.contextCombo, 1, 3, 2, 1);

        mainBox.pack_start(form, false, false, 0);

        // ------- Превью -------
        mainBox.pack_start(new Gtk.Label({
            label: '<b>' + _('Preview') + '</b>',
            use_markup: true,
            halign: Gtk.Align.START
        }), false, false, 0);

        this.store = new Gtk.ListStore();
        this.store.set_column_types([
            GObject.TYPE_STRING, // master path
            GObject.TYPE_STRING, // symlink path
            GObject.TYPE_STRING  // status
        ]);

        let view = new Gtk.TreeView({ model: this.store, headers_clickable: true });

        let r1 = new Gtk.CellRendererText(); r1.set_property('ellipsize', 3);
        let c1 = new Gtk.TreeViewColumn({ title: _('Physical file') });
        c1.pack_start(r1, true);
        c1.add_attribute(r1, 'text', 0);
        c1.set_expand(true);
        c1.set_resizable(true);
        c1.set_min_width(240);
        view.append_column(c1);

        let r2 = new Gtk.CellRendererText(); r2.set_property('ellipsize', 3);
        let c2 = new Gtk.TreeViewColumn({ title: _('Symlink to create') });
        c2.pack_start(r2, true);
        c2.add_attribute(r2, 'text', 1);
        c2.set_expand(true);
        c2.set_resizable(true);
        c2.set_min_width(240);
        view.append_column(c2);

        let r3 = new Gtk.CellRendererText();
        let c3 = new Gtk.TreeViewColumn({ title: _('Status') });
        c3.pack_start(r3, false);
        c3.add_attribute(r3, 'text', 2);
        c3.set_min_width(110);
        view.append_column(c3);

        let scroll = new Gtk.ScrolledWindow();
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
        scroll.add(view);
        mainBox.pack_start(scroll, true, true, 0);

        // ------- Кнопки -------
        let btnBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5 });
        btnBox.pack_start(new Gtk.Label({ label: '' }), true, true, 0);

        this.createBtn = new Gtk.Button({ label: _('Create') });
        this.createBtn.set_sensitive(false);
        this.createBtn.connect('clicked', () => this.onCreate());
        btnBox.pack_start(this.createBtn, false, false, 0);

        let cancelBtn = new Gtk.Button({ label: _('Cancel') });
        cancelBtn.connect('clicked', () => this.window.destroy());
        btnBox.pack_start(cancelBtn, false, false, 0);

        mainBox.pack_start(btnBox, false, false, 0);

        this.window.add(mainBox);
        this.populateContexts();
    }

    populateContexts() {
        // Собираем context → список верхних компонентов пути
        let map = new Map();
        for (let [dirName, info] of this.app.directoryInfo) {
            if (!info.context) continue;
            let top = dirName.split('/')[0];
            if (!map.has(info.context)) map.set(info.context, new Set());
            map.get(info.context).add(top);
        }

        let items = [];
        for (let [context, tops] of map) {
            if (tops.size === 1) {
                items.push({ label: context, context: context, topDir: null });
            } else {
                let sorted = Array.from(tops).sort();
                for (let i = 0; i < sorted.length; i++) {
                    items.push({
                        label: context + ' (' + sorted[i] + ')',
                        context: context,
                        topDir: sorted[i]
                    });
                }
            }
        }
        items.sort(function(a, b) { return a.label.localeCompare(b.label); });

        this.contextItems = items;
        for (let i = 0; i < items.length; i++) {
            this.contextCombo.append_text(items[i].label);
        }
        if (items.length > 0) this.contextCombo.set_active(0);
    }

    findDirectoryByContextAndSize(context, size, topDir) {
        let candidates = [];
        for (let [dirName, info] of this.app.directoryInfo) {
            if (info.context !== context) continue;
            if (info.size !== size) continue;
            if (topDir && dirName.split('/')[0] !== topDir) continue;
            candidates.push(dirName);
        }
        // предпочитаем каталог, чей первый компонент совпадает с context (в нижнем регистре)
        let ctxLower = context.toLowerCase();
        for (let i = 0; i < candidates.length; i++) {
            if (candidates[i].split('/')[0].toLowerCase() === ctxLower) return candidates[i];
        }
        return candidates[0] || null;
    }

    update() {
        let masterName = this.masterEntry.get_text().trim();
        let symlinkName = this.symlinkEntry.get_text().trim();
        let sameDir = this.sameDirCheck.get_active();

        this.contextCombo.set_sensitive(!sameDir);

        let activeIdx = this.contextCombo.get_active();
        let ctxItem = (activeIdx >= 0 && activeIdx < this.contextItems.length)
            ? this.contextItems[activeIdx] : null;

        this.rows = [];
        this.store.clear();

        if (!masterName || !symlinkName) {
            this.createBtn.set_sensitive(false);
            return;
        }
        if (masterName === symlinkName) {
            this.createBtn.set_sensitive(false);
            return;
        }

        let masterIcon = null;
        for (let i = 0; i < this.app.icons.length; i++) {
            if (this.app.icons[i].name === masterName) {
                masterIcon = this.app.icons[i];
                break;
            }
        }
        if (!masterIcon) {
            this.createBtn.set_sensitive(false);
            return;
        }

        let entries = [];
        for (let [relPath, _v] of masterIcon.realFiles) {
            entries.push(relPath);
        }
        entries.sort();

        for (let i = 0; i < entries.length; i++) {
            let relPath = entries[i];
            let dirName = GLib.path_get_dirname(relPath);
            let fileName = GLib.path_get_basename(relPath);
            let dot = fileName.lastIndexOf('.');
            if (dot < 0) continue;
            let ext = fileName.substring(dot);

            let dirInfo = this.app.directoryInfo.get(dirName);
            if (!dirInfo) continue;
            let size = dirInfo.size;

            let symlinkDir;
            if (sameDir) {
                symlinkDir = dirName;
            } else {
                if (!ctxItem) continue;
                symlinkDir = this.findDirectoryByContextAndSize(
                    ctxItem.context, size, ctxItem.topDir);
                if (!symlinkDir) continue;
            }

            let masterPath  = dirName   + '/' + masterName  + ext;
            let symlinkPath = symlinkDir + '/' + symlinkName + ext;

            // Статус
            let status = 'will create';
            let absSymlink = this.app.themeDir + '/' + symlinkPath;
            let symlinkFile = Gio.File.new_for_path(absSymlink);
            if (symlinkFile.query_exists(null)) {
                try {
                    let info = symlinkFile.query_info(
                        'standard::is-symlink,standard::symlink-target',
                        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                    if (info.get_is_symlink()) {
                        let expected = this.app.relativePath(symlinkDir, masterPath);
                        let actual = info.get_symlink_target();
                        status = (actual === expected) ? 'up-to-date' : 'will overwrite';
                    } else {
                        status = 'will overwrite file';
                    }
                } catch (e) {
                    status = 'exists';
                }
            }

            this.rows.push({
                masterPath: masterPath,
                symlinkPath: symlinkPath,
                symlinkDir: symlinkDir,
                ext: ext,
                size: size
            });

            let iter = this.store.append();
            this.store.set(iter, [0, 1, 2], [masterPath, symlinkPath, status]);
        }

        this.createBtn.set_sensitive(this.rows.length > 0);
    }

    onCreate() {
        if (this.rows.length === 0) return;

        let errors = [];
        let created = 0;

        for (let i = 0; i < this.rows.length; i++) {
            let row = this.rows[i];
            try {
                let absSymlink = this.app.themeDir + '/' + row.symlinkPath;
                let symlinkFile = Gio.File.new_for_path(absSymlink);

                if (symlinkFile.query_exists(null)) {
                    symlinkFile.delete(null);
                }

                let relTarget = this.app.relativePath(row.symlinkDir, row.masterPath);
                symlinkFile.make_symbolic_link(relTarget, null);
                created++;
            } catch (e) {
                errors.push(row.symlinkPath + ': ' + e.message);
            }
        }

        this.app.scanIcons();
        this.app.setStatus(formatString(_('Created %d symlink(s)'), created));

        if (errors.length > 0) {
            let dialog = new Gtk.MessageDialog({
                transient_for: this.window,
                modal: true,
                message_type: Gtk.MessageType.WARNING,
                buttons: Gtk.ButtonsType.OK,
                text: formatString(_('Created %d symlink(s) with %d error(s)'),
                                   created, errors.length),
                secondary_text: errors.join('\n')
            });
            dialog.run();
            dialog.destroy();
        } else {
            this.window.destroy();
        }
    }
}


// ==================== КЛАСС ICONTHEMEEDITOR ====================
class IconThemeEditor {
	constructor(themePath) {
		this.currentPreviewDir = null;
		this.currentSymlink = null;
		this.currentSelectedFile = null;
		this.currentSelectedIsSymlink = false;
		this.symlinkOriginalTarget = null;
		this.symlinkHasChanges = false;
		this.themePath = themePath;
		this.themeDir = '';
		this.icons = [];
		this.filteredIcons = [];
		this.currentIcon = null;
		this.isUpdating = false;
		this.iconSelectTimer = null;
		this.directoryInfo = new Map();
		this.createUI();
		this.loadTheme();
	}

	// ==================== ПАРСИНГ index.theme ====================
	parseIndexTheme() {
		  let result = {
		      directories: [],
		      directoryInfo: new Map()
		  };
		  try {
		      let indexFile = Gio.File.new_for_path(this.themeDir + '/index.theme');
		      let [success, contents] = indexFile.load_contents(null);
		      if (!success) return result;

		      let text = imports.byteArray.toString(contents);
		      let lines = text.split('\n');
		      let currentSection = '';
		      let inDirectoriesSection = false;

		      for (let line of lines) {
		          line = line.trim();
		          if (line === '[Icon Theme]') {
		              inDirectoriesSection = true;
		              currentSection = 'Icon Theme';
		          } else if (line.startsWith('[') && line.endsWith(']')) {
		              currentSection = line.substring(1, line.length - 1);
		              inDirectoriesSection = (line === '[Icon Theme]');
		          } else if (inDirectoriesSection && line.startsWith('Directories=')) {
		              let dirs = line.substring('Directories='.length).split(',');
		              result.directories.push(...dirs.map(d => d.trim()));
		          } else if (currentSection !== '' && line.includes('=')) {
		              let eq = line.indexOf('=');
		              let key = line.substring(0, eq).trim();
		              let value = line.substring(eq + 1).trim();

		              if (!result.directoryInfo.has(currentSection)) {
		                  result.directoryInfo.set(currentSection,
		                      { context: '', size: null, scale: null, type: '' });
		              }
		              let info = result.directoryInfo.get(currentSection);
		              if (key === 'Context') info.context = value;
		              else if (key === 'Size') info.size = parseInt(value) || null;
		              else if (key === 'Scale') info.scale = parseInt(value) || null;
		              else if (key === 'Type') info.type = value;
		          }
		      }
		  } catch (e) { /* ignore */ }
		  return result;
	}

	// ==================== ПОЛУЧАЕМ ВЫБРАННЫЕ СТРОКИ В ФАЙЛАХ ====================

getSelectedFileRows() {
    let result = [];
    let [paths, model] = this.filesTreeView.get_selection().get_selected_rows();
    for (let i = 0; i < paths.length; i++) {
        let iter = model.get_iter(paths[i]);
        if (!iter) continue;
        result.push({
            path: model.get_value(iter, 0),
            target: model.get_value(iter, 1)
        });
    }
    return result;
}

isFileRow(/* row */) {
    return false;
}

updateFileButtonsState() {
    if (!this.currentIcon) {
        this.deleteButton.set_sensitive(false);
        this.convertToSymlinkButton.set_sensitive(false);
        return;
    }

    let rows = this.getSelectedFileRows();
    if (rows.length === 0) {
        this.deleteButton.set_sensitive(false);
        this.convertToSymlinkButton.set_sensitive(false);
        return;
    }

    this.deleteButton.set_sensitive(true);

    let fileLabel = '(' + _('file') + ')';
    let symlinkCount = 0;
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].target !== '' && rows[i].target !== fileLabel) symlinkCount++;
    }

    if (rows.length === 1) {
        this.convertToSymlinkButton.set_sensitive(true);
        // label выставляет onFileSelected
    } else if (symlinkCount === rows.length) {
        this.convertToSymlinkButton.set_sensitive(true);
        this.convertToSymlinkButton.set_label(_('Symlinks → Files'));
    } else {
        this.convertToSymlinkButton.set_sensitive(false);
        this.convertToSymlinkButton.set_label(_('File ↔ Symlink'));
    }
}

relativePath(fromDir, toPath) {
    let from = fromDir.split('/').filter(Boolean);
    let to = toPath.split('/').filter(Boolean);
    let common = 0;
    while (common < from.length && common < to.length - 1
           && from[common] === to[common]) common++;
    let up = new Array(from.length - common).fill('..');
    return up.concat(to.slice(common)).join('/');
}

	// ==================== СОЗДАНИЕ ИНТЕРФЕЙСА ====================
	createUI() {
		this.window = new Gtk.Window({
			title: _('Icon Theme Editor - DisplayName'),
			default_width: 970,
			default_height: 600,
			window_position: Gtk.WindowPosition.CENTER
		});

		this.window.connect('destroy', () => Gtk.main_quit());

		let mainBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 3,
			margin: 3
		});

		let topBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 10
		});

		this.refreshButton = new Gtk.Button({ label: _('Refresh') });
		this.refreshButton.connect('clicked', () => this.loadTheme());
		topBox.pack_start(this.refreshButton, false, false, 0);

		let recreateBtn = new Gtk.Button({ label: _('Recreate Symlinks...') });
		recreateBtn.set_tooltip_text(_(
				'Create symlinks in all sizes of one icon name, pointing to the ' +
				'same-size physical files of another icon name.'));
		recreateBtn.connect('clicked', () => {
				new RecreateSymlinksDialog(this);
		});
		topBox.pack_start(recreateBtn, false, false, 0);

		let filterBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 5
		});

		let filterLabel = new Gtk.Label({
			label: _('Filter:'),
			halign: Gtk.Align.START
		});
		filterBox.pack_start(filterLabel, false, false, 0);

		this.filterEntry = new Gtk.Entry({
			placeholder_text: _('Enter text to filter...'),
			hexpand: true
		});
		this.filterEntry.connect('changed', this.onFilterChanged.bind(this));
		filterBox.pack_start(this.filterEntry, true, true, 0);

		topBox.pack_start(filterBox, true, true, 0);
		mainBox.pack_start(topBox, false, false, 0);

		let contentBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 10,
			hexpand: true,
			vexpand: true
		});

		let leftPane = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 5,
			width_request: 180
		});

		let listScrolled = new Gtk.ScrolledWindow();
		listScrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);

		this.listStore = new Gtk.ListStore();
		this.listStore.set_column_types([
			GObject.TYPE_STRING,
			GObject.TYPE_STRING,
			GObject.TYPE_STRING,
			GObject.TYPE_STRING,
			GObject.TYPE_STRING  // baseName (hidden)
		]);

		this.treeView = new Gtk.TreeView({
			model: this.listStore,
			headers_clickable: true
		});

		let nameRenderer = new Gtk.CellRendererText();
		let nameColumn = new Gtk.TreeViewColumn({ title: _('Icons') });
		nameColumn.pack_start(nameRenderer, true);
		nameColumn.add_attribute(nameRenderer, 'text', 0);
		nameColumn.add_attribute(nameRenderer, 'foreground', 1);
		nameColumn.set_sort_column_id(0);
		nameColumn.set_min_width(80);
		nameColumn.set_expand(true);
		nameColumn.set_resizable(true);
		nameRenderer.set_property('ellipsize', 3);
		nameColumn.connect('clicked', () => {
			this.listStore.set_sort_column_id(0, Gtk.SortType.ASCENDING);
		});
		this.treeView.append_column(nameColumn);

		let contextRenderer = new Gtk.CellRendererText();
		let contextColumn = new Gtk.TreeViewColumn({ title: _('Context') });
		contextColumn.pack_start(contextRenderer, true);
		contextColumn.add_attribute(contextRenderer, 'text', 3);
		contextColumn.set_min_width(110);
		contextColumn.set_sort_column_id(3);
		contextColumn.set_expand(false);
		contextColumn.set_resizable(true);
		contextRenderer.set_property('ellipsize', 3);
		contextColumn.connect('clicked', () => {
			this.listStore.set_sort_column_id(3, Gtk.SortType.ASCENDING);
		});
		this.treeView.append_column(contextColumn);

		let reasonRenderer = new Gtk.CellRendererText();
		let reasonColumn = new Gtk.TreeViewColumn({ title: _('Status') });
		reasonColumn.pack_start(reasonRenderer, true);
		reasonColumn.add_attribute(reasonRenderer, 'text', 2);
		reasonColumn.set_min_width(100);
		reasonColumn.set_sort_column_id(2);
		reasonColumn.set_expand(false);
		reasonColumn.set_resizable(true);
		reasonRenderer.set_property('ellipsize', 3);
		reasonColumn.connect('clicked', () => {
			this.listStore.set_sort_column_id(2, Gtk.SortType.ASCENDING);
		});
		this.treeView.append_column(reasonColumn);

		this.treeView.connect('cursor-changed', this.onIconSelected.bind(this));
		this.treeView.connect('row-activated', this.onIconActivated.bind(this));
		listScrolled.add(this.treeView);

		leftPane.pack_start(listScrolled, true, true, 0);

		contentBox.pack_start(leftPane, true, true, 0);

		let editorBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 10,
			hexpand: false,
			width_request: 500
		});

		let nameBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 5
		});

		let nameStaticLabel = new Gtk.Label({
			label: _('<b>Selected Icon:</b>'),
			use_markup: true,
			halign: Gtk.Align.START
		});
		nameBox.pack_start(nameStaticLabel, false, false, 0);

		this.iconNameLabel = new Gtk.Label({
			label: _('None'),
			halign: Gtk.Align.START,
			selectable: true
		});
		nameBox.pack_start(this.iconNameLabel, false, false, 0);

		editorBox.pack_start(nameBox, false, false, 0);

		this.warningLabel = new Gtk.Label({
			label: '',
			use_markup: true,
			halign: Gtk.Align.START
		});
		editorBox.pack_start(this.warningLabel, false, false, 0);

		let descLabel = new Gtk.Label({
			label: _('<b>DisplayName:</b>'),
			use_markup: true,
			halign: Gtk.Align.START
		});
		editorBox.pack_start(descLabel, false, false, 0);

		this.displayNameEntry = new Gtk.Entry({
			hexpand: true,
			sensitive: false
		});
		editorBox.pack_start(this.displayNameEntry, false, false, 0);

		let editorButtonsBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 10
		});

		this.saveButton = new Gtk.Button({
			label: _('Save'),
			sensitive: false
		});
		this.saveButton.connect('clicked', () => this.saveIconFile());
		editorButtonsBox.pack_start(this.saveButton, false, false, 0);

		this.resetButton = new Gtk.Button({
			label: _('Reset'),
			sensitive: false
		});
		this.resetButton.connect('clicked', () => this.loadCurrentIconFile());
		editorButtonsBox.pack_start(this.resetButton, false, false, 0);

		this.advancedButton = new Gtk.Button({
			label: _('Coordinates...'),
			sensitive: false
		});
		editorButtonsBox.pack_start(this.advancedButton, false, false, 0);

		editorBox.pack_start(editorButtonsBox, false, false, 0);

		this.contextsLabel = new Gtk.Label({
			label: _('<b>Icon Files:</b>'),
			use_markup: true,
			halign: Gtk.Align.START
		});
		editorBox.pack_start(this.contextsLabel, false, false, 0);

		let contextsMainBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 10
		});

		let contextsPreviewBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 10
		});
		contextsPreviewBox.set_size_request(-1, 50);

		let filesScrolled = new Gtk.ScrolledWindow();
		filesScrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);

		this.filesListStore = new Gtk.ListStore();
		this.filesListStore.set_column_types([GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_STRING]);

		this.filesTreeView = new Gtk.TreeView({
			model: this.filesListStore
		});
		this.filesTreeView.get_selection().set_mode(Gtk.SelectionMode.MULTIPLE);
		this.filesTreeView.get_selection().connect('changed', () => this.updateFileButtonsState());

		let filePathRenderer = new Gtk.CellRendererText();
		let filePathColumn = new Gtk.TreeViewColumn({ title: _('File') });
		filePathColumn.pack_start(filePathRenderer, true);
		filePathColumn.add_attribute(filePathRenderer, 'text', 0);
		filePathColumn.set_min_width(120);
		filePathColumn.set_expand(true);
		filePathColumn.set_resizable(true);
		filePathRenderer.set_property('ellipsize', 3);
		this.filesTreeView.append_column(filePathColumn);

		let fileTargetRenderer = new Gtk.CellRendererText();
		let fileTargetColumn = new Gtk.TreeViewColumn({ title: _('Target') });
		fileTargetColumn.pack_start(fileTargetRenderer, true);
		fileTargetColumn.add_attribute(fileTargetRenderer, 'text', 1);
		fileTargetColumn.add_attribute(fileTargetRenderer, 'foreground', 2);
		fileTargetColumn.set_min_width(100);
		fileTargetColumn.set_expand(false);
		fileTargetColumn.set_resizable(true);
		fileTargetRenderer.set_property('ellipsize', 3);
		this.filesTreeView.append_column(fileTargetColumn);

		this.filesTreeView.connect('cursor-changed', this.onFileSelected.bind(this));
		this.filesTreeView.connect('row-activated', this.onFileActivated.bind(this));
		filesScrolled.add(this.filesTreeView);
		contextsPreviewBox.pack_start(filesScrolled, true, true, 0);

		let previewControlBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 3,
			width_request: 120
		});

		this.previewImage = new Gtk.Image();
		this.previewImage.set_size_request(64, 64);
		previewControlBox.pack_start(this.previewImage, false, false, 0);

		this.previewButton = new Gtk.Button({
			label: _('Open in Editor'),
			sensitive: false
		});
		this.previewButton.connect('clicked', this.openImageInEditor.bind(this));
		previewControlBox.pack_start(this.previewButton, false, false, 0);

		this.deleteButton = new Gtk.Button({
			label: _('Delete'),
			sensitive: false
		});
		this.deleteButton.connect('clicked', this.deleteImageFile.bind(this));
		previewControlBox.pack_start(this.deleteButton, false, false, 0);

		this.convertToSymlinkButton = new Gtk.Button({
			label: _('File ↔ Symlink'),
			sensitive: false
		});
		this.convertToSymlinkButton.connect('clicked', this.convertToSymlink.bind(this));
		previewControlBox.pack_start(this.convertToSymlinkButton, false, false, 0);

		let symlinkEditorBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 3,
			hexpand: true
		});

		let targetLabel = new Gtk.Label({
			label: _('Symlink target:'),
			halign: Gtk.Align.START
		});
		symlinkEditorBox.pack_start(targetLabel, false, false, 0);

		let targetEntryBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 3
		});

		this.symlinkTargetEntry = new Gtk.Entry({
			hexpand: true,
			sensitive: false
		});
		this.symlinkTargetEntry.connect('changed', this.onSymlinkTargetChanged.bind(this));
		this.symlinkTargetEntry.connect('key-press-event', this.onSymlinkTargetKeyPress.bind(this));
		targetEntryBox.pack_start(this.symlinkTargetEntry, true, true, 0);

		this.symlinkStatusIcon = new Gtk.Image();
		this.symlinkStatusIcon.set_size_request(16, 16);
		targetEntryBox.pack_start(this.symlinkStatusIcon, false, false, 0);

		symlinkEditorBox.pack_start(targetEntryBox, false, false, 0);

		let symlinkButtonsBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 3
		});

		this.symlinkResetButton = new Gtk.Button({
			label: _('Reset'),
			sensitive: false
		});
		this.symlinkResetButton.connect('clicked', this.resetSymlinkTarget.bind(this));
		symlinkButtonsBox.pack_start(this.symlinkResetButton, false, false, 0);

		this.symlinkSaveButton = new Gtk.Button({
			label: _('Save'),
			sensitive: false
		});
		this.symlinkSaveButton.connect('clicked', this.saveSymlinkTarget.bind(this));
		symlinkButtonsBox.pack_start(this.symlinkSaveButton, false, false, 0);

		symlinkEditorBox.pack_start(symlinkButtonsBox, false, false, 0);
		previewControlBox.pack_start(symlinkEditorBox, false, false, 0);

		previewControlBox.pack_start(new Gtk.Label({ label: '' }), true, true, 0);
		contextsPreviewBox.pack_start(previewControlBox, false, false, 0);
		editorBox.pack_start(contextsPreviewBox, false, false, 0);

		this.filePreviewBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 3,
			margin_top: 5
		});

		this.filePreviewImage = new Gtk.Image();
		this.filePreviewImage.set_size_request(64, 64);
		this.filePreviewBox.pack_start(this.filePreviewImage, false, false, 0);

		this.filePreviewLabel = new Gtk.Label({
			label: '',
			halign: Gtk.Align.START,
			valign: Gtk.Align.START,
			wrap: true,
			width_request: 100
		});
		this.filePreviewBox.pack_start(this.filePreviewLabel, true, true, 10);

		contextsMainBox.pack_start(contextsPreviewBox, false, false, 0);
		contextsMainBox.pack_start(this.filePreviewBox, false, false, 0);
		editorBox.pack_start(contextsMainBox, false, false, 0);

		editorBox.pack_start(new Gtk.Label({ label: '' }), true, true, 0);

		contentBox.pack_start(editorBox, false, false, 0);
		mainBox.pack_start(contentBox, true, true, 0);

		this.statusbar = new Gtk.Statusbar();
		this.statusContextId = this.statusbar.get_context_id('main');
		mainBox.pack_start(this.statusbar, false, false, 0);

		this.window.add(mainBox);
		this.window.show_all();
	}

	// ==================== ОТКРЫТИЕ СВОЙСТВ ====================
	onIconActivated(treeView, path, column) {
		let [success, model, iter] = this.treeView.get_selection().get_selected();
		if (!success || !iter) return;

		let baseName = model.get_value(iter, 4);
		if (!baseName) return;

		this.openIconProperties(baseName);
	}

	openIconProperties(iconName) {
		let win = new IconPropertiesWindow(this, iconName);
	}

	// ==================== ТОЧЕЧНОЕ ОБНОВЛЕНИЕ ЗНАЧКА ====================
refreshIcon(iconName) {
    let iconInfo = this.icons.find(i => i.name === iconName);
    if (!iconInfo) return;

    // Сохраняем список каталогов, где значок был раньше
    let oldDirs = new Set(iconInfo.directories.keys());

    iconInfo.directories.clear();
    iconInfo.directorySizes.clear();
    iconInfo.displayNames.clear();
    iconInfo.symlinks.clear();
    iconInfo.realFiles.clear();
    iconInfo.hasSymlinks = false;
    iconInfo.symlinkOnly = true;

    let parsed = this.parseIndexTheme();
    this.directoryInfo = parsed.directoryInfo;
    let directoryInfo = parsed.directoryInfo;

    let validExtensions = new Set(['.png', '.xpm', '.svg']);
    let foundDirs = new Set();

    // Проходим только по каталогам, где значок был или мог бы быть
    let checkDirs = new Set([...oldDirs, ...parsed.directories]);

    for (let dirName of checkDirs) {
        let dir = Gio.File.new_for_path(this.themeDir + '/' + dirName);
        if (!dir.query_exists(null)) continue;

        let context = directoryInfo.get(dirName)?.context || 'Unknown';
        let dirSize = directoryInfo.get(dirName)?.size ?? null;

        let enumerator;
        try {
            enumerator = dir.enumerate_children(
                'standard::name,standard::type,standard::is-symlink',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) { continue; }

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            let name = info.get_name();
            let dotIdx = name.lastIndexOf('.');
            if (dotIdx < 0) continue;
            let ext = name.substring(dotIdx).toLowerCase();
            if (!validExtensions.has(ext)) continue;
            if (name.substring(0, dotIdx) !== iconName) continue;

            let isSymlink = info.get_is_symlink();
            iconInfo.directories.set(dirName, context);
            iconInfo.directorySizes.set(dirName, dirSize);
            foundDirs.add(dirName);

            let fileRelPath = dirName + '/' + name;
            if (isSymlink) {
                iconInfo.hasSymlinks = true;
                try {
                    let targetInfo = dir.get_child(name).query_info(
                        'standard::symlink-target',
                        Gio.FileQueryInfoFlags.NONE, null);
                    let target = targetInfo.get_symlink_target();
                    if (target) iconInfo.symlinks.set(fileRelPath, target);
                } catch (e) { /* ignore */ }
            } else {
                iconInfo.symlinkOnly = false;
                iconInfo.realFiles.set(fileRelPath, true);
            }

            let iconFilePath = this.themeDir + '/' + dirName + '/' + iconName + '.icon';
            let iconFile = Gio.File.new_for_path(iconFilePath);
            if (iconFile.query_exists(null)) {
                try {
                    let [ok, c] = iconFile.load_contents(null);
                    if (ok) {
                        let dn = this.extractDisplayName(imports.byteArray.toString(c));
                        if (dn) iconInfo.displayNames.add(dn);
                    }
                } catch (e) { /* ignore */ }
            }
        }
        enumerator.close(null);
    }

    this.updateListDisplay();
    this.setStatus(formatString(_('Refreshed: %s'), iconName));
}

	// ==================== ОБНОВЛЕНИЕ ОТОБРАЖЕНИЯ СПИСКА ====================
	updateListDisplay() {
		this.listStore.clear();

		for (let icon of this.filteredIcons) {
			let iter = this.listStore.append();
			let color = 'black';
			let reason = _('OK');
			let contextText = '';

			let contexts = new Set(icon.directories.values());

			if (contexts.size > 1) {
				contextText = _('Multiple');
			} else if (contexts.size === 1) {
				contextText = Array.from(contexts)[0];
			} else {
				contextText = _('None');
			}

			let hasDifferentTargets = false;
			if (icon.symlinks.size > 1) {
				let targets = new Set();
				for (let target of icon.symlinks.values()) {
					let normalizedTarget = this.normalizeSymlinkTarget(target);
					targets.add(normalizedTarget);
				}
				hasDifferentTargets = targets.size > 1;
			}

			if (contexts.size > 1) {
				color = 'red';
				reason = _('Multiple contexts');
			} else if (icon.displayNames.size > 1) {
				color = 'orange';
				reason = _('Different DisplayName');
			} else if (hasDifferentTargets) {
				color = 'magenta';
				reason = _('Different symlink targets');
			} else if (icon.symlinkOnly) {
				color = 'purple';
				reason = _('Symlinks only');
			} else if (icon.hasSymlinks) {
				color = 'blue';
				reason = _('Has symlinks');
			} else if (icon.displayNames.size === 1) {
				reason = 'DisplayName: ' + Array.from(icon.displayNames)[0];
			}

			let displayName = '';
			if (icon.displayNames.size === 1 && contexts.size === 1) {
				displayName = ' - ' + Array.from(icon.displayNames)[0];
			}

			this.listStore.set(iter, [0, 1, 2, 3, 4],
				[icon.name + displayName, color, reason, contextText, icon.name]);
		}

		this.listStore.set_sort_column_id(0, Gtk.SortType.ASCENDING);
	}

	// ==================== ЗАГРУЗКА ТЕМЫ ====================
	loadTheme() {
		if (this.isUpdating) return;
		this.isUpdating = true;

		this.setWindowModified(false);

		if (!this.themePath) {
			this.isUpdating = false;
			return;
		}

		try {
			let file = Gio.File.new_for_path(this.themePath);
			if (!file.query_exists(null)) {
				this.showError(_('Theme file does not exist') + ': ' + this.themePath);
				this.isUpdating = false;
				return;
			}

			let info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
			if (info.get_file_type() === Gio.FileType.DIRECTORY) {
				this.themeDir = file.get_path();
				let indexFile = file.get_child('index.theme');
				if (!indexFile.query_exists(null)) {
					this.showError(_('Directory does not contain index.theme'));
					this.isUpdating = false;
					return;
				}
			} else if (file.get_basename() === 'index.theme') {
				this.themeDir = file.get_parent().get_path();
			} else {
				this.showError(_('Invalid theme file'));
				this.isUpdating = false;
				return;
			}

			this.scanIcons();
			this.onFilterChanged();

			this.currentIcon = null;
			this.iconNameLabel.set_label(_('None'));

			this.displayNameEntry.set_text('');
			this.displayNameEntry.set_sensitive(false);
			this.saveButton.set_sensitive(false);
			this.resetButton.set_sensitive(false);
			this.warningLabel.set_label('');

			this.previewImage.set_from_pixbuf(null);
			this.previewButton.set_sensitive(false);
			this.deleteButton.set_sensitive(false);
			this.convertToSymlinkButton.set_sensitive(false);
			this.filePreviewImage.set_from_pixbuf(null);
			this.filePreviewLabel.set_label('');

			this.symlinkTargetEntry.set_text('');
			this.symlinkTargetEntry.set_sensitive(false);
			this.symlinkResetButton.set_sensitive(false);
			this.symlinkSaveButton.set_sensitive(false);
			this.symlinkStatusIcon.set_from_pixbuf(null);
			this.symlinkStatusIcon.set_tooltip_text('');
			this.currentSelectedFile = null;
			this.currentSelectedIsSymlink = false;
			this.currentSymlink = null;
			this.symlinkOriginalTarget = null;
			this.symlinkHasChanges = false;

			this.filesListStore.clear();

			this.setStatus(formatString(_('Loaded %d icons'), this.icons.length));

		} catch (e) {
			this.showError(_('Error loading theme') + ': ' + e.message);
		}

		this.isUpdating = false;
	}

	// ==================== СКАНИРОВАНИЕ ЗНАЧКОВ ====================
scanIcons() {
    this.icons = [];
    this.listStore.clear();

    // Единственный парсинг index.theme
    let parsed = this.parseIndexTheme();
    let directories = parsed.directories;
    let directoryInfo = parsed.directoryInfo;
    this.directoryInfo = directoryInfo;

    let validExtensions = new Set(['.png', '.xpm', '.svg']);
    let iconMap = new Map();

    for (let dirName of directories) {
        let dir = Gio.File.new_for_path(this.themeDir + '/' + dirName);
        if (!dir.query_exists(null)) continue;

        let context = directoryInfo.get(dirName)?.context || 'Unknown';
        let dirSize = directoryInfo.get(dirName)?.size ?? null;

        let enumerator;
        try {
            enumerator = dir.enumerate_children(
                'standard::name,standard::type,standard::is-symlink',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            continue;
        }

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            let name = info.get_name();
            let type = info.get_file_type();
            let isSymlink = info.get_is_symlink();

            if (type !== Gio.FileType.REGULAR && type !== Gio.FileType.SYMBOLIC_LINK)
                continue;

            let dotIdx = name.lastIndexOf('.');
            if (dotIdx < 0) continue;
            let ext = name.substring(dotIdx).toLowerCase();
            if (!validExtensions.has(ext)) continue;

            let baseName = name.substring(0, dotIdx);

            let iconInfo = iconMap.get(baseName);
            if (!iconInfo) {
                iconInfo = {
                    name: baseName,
                    directories: new Map(),
                    directorySizes: new Map(),
                    displayNames: new Set(),
                    symlinks: new Map(),
                    realFiles: new Map(),
                    hasSymlinks: false,
                    symlinkOnly: true
                };
                iconMap.set(baseName, iconInfo);
            }

            iconInfo.directories.set(dirName, context);
            iconInfo.directorySizes.set(dirName, dirSize);

            let fileRelPath = dirName + '/' + name;

            if (isSymlink) {
                iconInfo.hasSymlinks = true;
                try {
                    let targetInfo = dir.get_child(name).query_info(
                        'standard::symlink-target',
                        Gio.FileQueryInfoFlags.NONE, null);
                    let target = targetInfo.get_symlink_target();
                    if (target) iconInfo.symlinks.set(fileRelPath, target);
                } catch (e) { /* ignore */ }
            } else {
                iconInfo.symlinkOnly = false;
                iconInfo.realFiles.set(fileRelPath, true);
            }

            // .icon файл с DisplayName
            let iconFilePath = this.themeDir + '/' + dirName + '/' + baseName + '.icon';
            let iconFile = Gio.File.new_for_path(iconFilePath);
            if (iconFile.query_exists(null)) {
                try {
                    let [ok, c] = iconFile.load_contents(null);
                    if (ok) {
                        let dn = this.extractDisplayName(imports.byteArray.toString(c));
                        if (dn) iconInfo.displayNames.add(dn);
                    }
                } catch (e) { /* ignore */ }
            }
        }
        enumerator.close(null);
    }

    this.icons = Array.from(iconMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    this.filteredIcons = this.icons;

    this.updateListDisplay();
    this.onFilterChanged();
    this.setStatus(formatString(_('Loaded %d icons'), this.icons.length));
}

	// ==================== ИЗВЛЕЧЕНИЕ DISPLAYNAME ====================
	extractDisplayName(iconText) {
		let lines = iconText.split('\n');
		for (let line of lines) {
			if (line.startsWith('DisplayName=')) {
				return line.substring('DisplayName='.length).trim();
			}
		}
		return null;
	}

	// ==================== ФИЛЬТРАЦИЯ СПИСКА ====================
	onFilterChanged() {
		if (this.isUpdating) return;
		this.isUpdating = true;

		let filterText = this.filterEntry.get_text().toLowerCase();

		if (filterText === '') {
			this.filteredIcons = this.icons;
		} else {
			this.filteredIcons = this.icons.filter(icon =>
				icon.name.toLowerCase().includes(filterText)
			);
		}

		this.updateListDisplay();

		this.currentIcon = null;
		this.iconNameLabel.set_label(_('None'));

		this.displayNameEntry.set_text('');
		this.displayNameEntry.set_sensitive(false);
		this.saveButton.set_sensitive(false);
		this.resetButton.set_sensitive(false);
		this.warningLabel.set_label('');

		this.previewImage.set_from_pixbuf(null);
		this.previewButton.set_sensitive(false);
		this.deleteButton.set_sensitive(false);
		this.convertToSymlinkButton.set_sensitive(false);
		this.filePreviewImage.set_from_pixbuf(null);
		this.filePreviewLabel.set_label('');

		this.symlinkTargetEntry.set_text('');
		this.symlinkTargetEntry.set_sensitive(false);
		this.symlinkResetButton.set_sensitive(false);
		this.symlinkSaveButton.set_sensitive(false);
		this.symlinkStatusIcon.set_from_pixbuf(null);
		this.symlinkStatusIcon.set_tooltip_text('');
		this.currentSelectedFile = null;
		this.currentSelectedIsSymlink = false;
		this.currentSymlink = null;
		this.symlinkOriginalTarget = null;
		this.symlinkHasChanges = false;

		this.filesListStore.clear();

		this.setStatus(formatString(_('Filtered: %d icons shown'), this.filteredIcons.length));

		this.isUpdating = false;
	}

	// ==================== ВЫБОР ЗНАЧКА ====================
	onIconSelected() {
		if (this.isUpdating) return;

		let [success, model, iter] = this.treeView.get_selection().get_selected();
		if (!success || !iter) return;

		let baseName = model.get_value(iter, 4);
		if (!baseName) return;

		if (this.currentIcon && this.currentIcon.name === baseName) {
			return;
		}

		let filterText = this.filterEntry.get_text().trim();
		let hasFilter = filterText !== '';

		if (hasFilter) {
			if (this.iconSelectTimer) {
				GLib.source_remove(this.iconSelectTimer);
				this.iconSelectTimer = null;
			}

			this.iconSelectTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
				this.iconSelectTimer = null;
				this.doIconSelected(baseName);
				return false;
			});
		} else {
			this.doIconSelected(baseName);
		}
	}

	doIconSelected(baseName) {
		this.currentIcon = this.filteredIcons.find(icon => icon.name === baseName);
		if (!this.currentIcon) return;

		this.iconNameLabel.set_label(this.currentIcon.name);

		let contexts = new Set(this.currentIcon.directories.values());
		let canEdit = contexts.size === 1;
		this.displayNameEntry.set_sensitive(canEdit);
		this.saveButton.set_sensitive(canEdit);
		this.resetButton.set_sensitive(canEdit);
		this.advancedButton.set_sensitive(false);

		if (contexts.size > 1) {
			this.warningLabel.set_label('<span color="red">' + _('Icon has different contexts!') + '</span>');
		} else if (this.currentIcon.displayNames.size > 1) {
			this.warningLabel.set_label('<span color="orange">' + _('DisplayName differs between files!') + '</span>');
		} else {
			this.warningLabel.set_label('');
		}

		this.symlinkTargetEntry.set_text('');
		this.symlinkTargetEntry.set_sensitive(false);
		this.symlinkResetButton.set_sensitive(false);
		this.symlinkSaveButton.set_sensitive(false);
		this.symlinkStatusIcon.set_from_pixbuf(null);
		this.symlinkStatusIcon.set_tooltip_text('');
		this.currentSelectedFile = null;
		this.currentSelectedIsSymlink = false;
		this.currentSymlink = null;
		this.symlinkOriginalTarget = null;
		this.symlinkHasChanges = false;

		this.previewImage.set_from_pixbuf(null);
		this.previewButton.set_sensitive(false);
		this.deleteButton.set_sensitive(false);
		this.convertToSymlinkButton.set_sensitive(false);
		this.filePreviewImage.set_from_pixbuf(null);
		this.filePreviewLabel.set_label('');

		this.updateFilesList();
		this.selectFirstFile();
		this.loadCurrentIconFile();
	}

	// ==================== ВЫБОР ПЕРВОГО ФАЙЛА В СПИСКЕ ====================
	selectFirstFile() {
		if (this.isUpdating) return;
		try {
			let iter = this.filesListStore.get_iter_first();
			if (iter) {
				let path = new Gtk.TreePath();
				path.append_index(0);
				this.filesTreeView.set_cursor(path, null, false);
			}
		} catch (e) {
			log('Warning: Could not select first file: ' + e.message);
		}
	}

	// ==================== ОБНОВЛЕНИЕ СПИСКА ФАЙЛОВ ====================
	updateFilesList() {
		this.filesListStore.clear();

		if (!this.currentIcon) return;

		for (let [filePath, exists] of this.currentIcon.realFiles) {
			if (exists) {
				let iter = this.filesListStore.append();
				this.filesListStore.set(iter, [0, 1, 2], [filePath, '(' + _('file') + ')', 'black']);
			}
		}

		for (let [symlinkPath, target] of this.currentIcon.symlinks) {
			let iter = this.filesListStore.append();
			this.filesListStore.set(iter, [0, 1, 2], [symlinkPath, target, 'blue']);
		}
	}

	// ==================== ВЫБОР ФАЙЛА ====================
	onFileSelected() {
		if (this.isUpdating) return;

		let [success, model, iter] = this.filesTreeView.get_selection().get_selected();
		if (!success || !iter || !this.currentIcon) return;

		let filePath = model.get_value(iter, 0);
		let target = model.get_value(iter, 1);
		let isSymlink = target !== '' && target !== '(' + _('file') + ')';

		this.currentSelectedFile = filePath;
		this.currentSelectedIsSymlink = isSymlink;
		this.symlinkHasChanges = false;

		this.previewButton.set_sensitive(true);

		if (isSymlink) {
			this.convertToSymlinkButton.set_label(_('Symlink → File'));
			this.currentSymlink = filePath;
			this.symlinkOriginalTarget = target;

			this.symlinkTargetEntry.set_text(target);
			this.symlinkTargetEntry.set_sensitive(true);
			this.symlinkResetButton.set_sensitive(true);
			this.symlinkSaveButton.set_sensitive(false);

			this.checkSymlinkTarget(target);
		} else {
			this.convertToSymlinkButton.set_label(_('File → Symlink'));
			this.currentSymlink = null;
			this.symlinkOriginalTarget = null;

			this.symlinkTargetEntry.set_text('');
			this.symlinkTargetEntry.set_sensitive(false);
			this.symlinkResetButton.set_sensitive(false);
			this.symlinkSaveButton.set_sensitive(false);
			this.symlinkStatusIcon.set_from_pixbuf(null);
			this.symlinkStatusIcon.set_tooltip_text('');
		}

		let parts = filePath.split('/');
		let dir = parts[0];
		this.currentPreviewDir = dir;

		this.loadFilePreview(this.themeDir + '/' + filePath);
		this.loadPreview(dir, this.currentIcon.name);
		this.updateFileButtonsState();
	}

	// ==================== ДВОЙНОЙ КЛИК ПО ФАЙЛУ (в правом списке) ====================
	onFileActivated(treeView, path, column) {
		if (!this.currentSelectedFile || !this.currentIcon) return;

		let fullPath = this.themeDir + '/' + this.currentSelectedFile;
		let file = Gio.File.new_for_path(fullPath);

		if (!file.query_exists(null)) {
			this.showError('File does not exist: ' + fullPath);
			return;
		}

		this.showFileInManager(fullPath);
	}

	// ==================== ПОКАЗАТЬ ФАЙЛ В ФАЙЛОВОМ МЕНЕДЖЕРЕ ====================
	showFileInManager(filePath) {
		try {
			let file = Gio.File.new_for_path(filePath);

			try {
				let launcher = Gio.AppInfo.create_from_commandline(
					'xdg-open', null, Gio.AppInfoCreateFlags.SUPPORTS_URIS);

				let parentDir = file.get_parent();
				if (parentDir) {
					let args = [parentDir.get_uri()];
					launcher.launch_uris(args, null);

					GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
						this.selectFileViaDBus(filePath);
						return false;
					});
				}
			} catch (e) {
				this.selectFileViaDBus(filePath);
			}
		} catch (e) {
			this.showError('Error opening file manager: ' + e.message);
		}
	}

	selectFileViaDBus(filePath) {
		try {
			let file = Gio.File.new_for_path(filePath);
			let uri = file.get_uri();

			let [success, pid, stdin, stdout, stderr] = GLib.spawn_async_with_pipes(
				null,
				[
					'dbus-send',
					'--session',
					'--print-reply',
					'--dest=org.freedesktop.FileManager1',
					'--type=method_call',
					'/org/freedesktop/FileManager1',
					'org.freedesktop.FileManager1.ShowItems',
					'array:string:' + uri,
					'string:'
				],
				null,
				GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
				null
			);

			if (success) {
				let output = new Gio.DataInputStream({
					base_stream: new Gio.UnixInputStream({ fd: stdout })
				});

				output.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
					try {
						let [line] = source.read_line_finish(result);
						if (line) log('D-Bus response: ' + line);
					} catch (e) { /* ignore */ }
				});
			}
		} catch (e) {
			try {
				let file = Gio.File.new_for_path(filePath);
				let parentDir = file.get_parent();
				if (parentDir) {
					let launcher = Gio.AppInfo.create_from_commandline('xdg-open', null, Gio.AppInfoCreateFlags.NONE);
					launcher.launch([parentDir], null);
				}
			} catch (err) {
				this.showError('Could not open file manager: ' + err.message);
			}
		}
	}

	// ==================== ПРЕОБРАЗОВАНИЕ ФАЙЛА/СИМЛИНКА ====================
convertToSymlink() {
    let rows = this.getSelectedFileRows();
    if (rows.length === 0) return;

    let fileLabel = '(' + _('file') + ')';

    if (rows.length === 1) {
        if (rows[0].target !== '' && rows[0].target !== fileLabel) {
            this.convertToFile();
        } else {
            this.convertSymlinkToFile();
        }
        return;
    }

    // многозаходный режим — только symlinks → files
    let allSymlinks = true;
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].target === '' || rows[i].target === fileLabel) {
            allSymlinks = false;
            break;
        }
    }
    if (!allSymlinks) return;

    let paths = rows.map(function(r) { return r.path; });
    this.convertSymlinksToFiles(paths);
}

convertSymlinksToFiles(paths) {
    let dialog = new Gtk.MessageDialog({
        transient_for: this.window,
        modal: true,
        message_type: Gtk.MessageType.QUESTION,
        buttons: Gtk.ButtonsType.YES_NO,
        text: formatString(_('Convert %d symlink(s) to files?'), paths.length),
        secondary_text: _('Each symlink will be replaced with a copy of its target file.')
    });

    if (dialog.run() === Gtk.ResponseType.YES) {
        let errors = [];
        let converted = 0;

        for (let i = 0; i < paths.length; i++) {
            let p = paths[i];
            try {
                let symlinkPath = this.themeDir + '/' + p;
                let symlinkFile = Gio.File.new_for_path(symlinkPath);
                let target = this.currentIcon.symlinks.get(p);
                if (!target) {
                    errors.push(p + ': no target');
                    continue;
                }

                let symlinkDir = symlinkFile.get_parent();
                let targetFile = symlinkDir.resolve_relative_path(target);
                if (!targetFile.query_exists(null)) {
                    errors.push(p + ': target missing');
                    continue;
                }

                targetFile.copy(symlinkFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                this.currentIcon.symlinks.delete(p);
                this.currentIcon.realFiles.set(p, true);
                converted++;
            } catch (e) {
                errors.push(p + ': ' + e.message);
            }
        }

        this.currentIcon.hasSymlinks = this.currentIcon.symlinks.size > 0;
        this.currentIcon.symlinkOnly =
            this.currentIcon.realFiles.size === 0 && this.currentIcon.symlinks.size > 0;

        this.updateFilesList();
        this.updateListDisplay();
        this.setStatus(formatString(_('Converted %d symlink(s) to file(s)'), converted));
        this.setWindowModified(true);

        if (errors.length > 0) this.showError(errors.join('\n'));
    }

    dialog.destroy();
}

	convertSymlinkToFile() {
		if (!this.currentSelectedFile || !this.currentIcon) return;

		let dialog = new Gtk.Dialog({
			title: _('Convert to symlink'),
			transient_for: this.window,
			modal: true,
			destroy_with_parent: true
		});

		dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
		dialog.add_button(_('OK'), Gtk.ResponseType.OK);
		dialog.set_default_response(Gtk.ResponseType.OK);

		let contentBox = dialog.get_content_area();
		contentBox.set_spacing(3);
		contentBox.set_margin_start(5);
		contentBox.set_margin_end(5);
		contentBox.set_margin_top(5);
		contentBox.set_margin_bottom(5);

		let infoLabel = new Gtk.Label({
			label: formatString(_('File "%s" will be replaced with a symlink. Enter the target path:'), this.currentSelectedFile),
			halign: Gtk.Align.START,
			wrap: true,
			selectable: true
		});
		contentBox.pack_start(infoLabel, false, false, 0);

		let targetEntry = new Gtk.Entry({
			hexpand: true,
			placeholder_text: _('Enter target path...')
		});

		let statusImage = new Gtk.Image();
		statusImage.set_size_request(16, 16);
		statusImage.set_from_icon_name('dialog-warning', Gtk.IconSize.BUTTON);
		statusImage.set_tooltip_text(_('Enter a target path'));

		let entryBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 3
		});
		entryBox.pack_start(targetEntry, true, true, 0);
		entryBox.pack_start(statusImage, false, false, 0);
		contentBox.pack_start(entryBox, false, false, 0);

		let defaultTarget = this.suggestSymlinkTarget(this.currentSelectedFile);
		targetEntry.set_text(defaultTarget);

		let targetCheckFunction = () => {
			let target = targetEntry.get_text().trim();
			if (!target) {
				statusImage.set_from_icon_name('dialog-warning', Gtk.IconSize.BUTTON);
				statusImage.set_tooltip_text(_('Target not specified'));
				dialog.set_response_sensitive(Gtk.ResponseType.OK, false);
				return;
			}

			try {
				let symlinkPath = this.themeDir + '/' + this.currentSelectedFile;
				let symlinkDir = Gio.File.new_for_path(symlinkPath).get_parent();
				let targetFile = symlinkDir.get_child(target);

				if (target.startsWith('./')) {
					targetFile = symlinkDir.get_child(target.substring(2));
				}
				if (target.includes('../')) {
					targetFile = symlinkDir.resolve_relative_path(target);
				}

				if (!targetFile.query_exists(null)) {
					statusImage.set_from_icon_name('dialog-error', Gtk.IconSize.BUTTON);
					statusImage.set_tooltip_text(_('File does not exist'));
					dialog.set_response_sensitive(Gtk.ResponseType.OK, false);
					return;
				}

				let targetInfo = targetFile.query_info('standard::type,standard::is-symlink', Gio.FileQueryInfoFlags.NONE, null);
				let fileType = targetInfo.get_file_type();
				let isSymlink = targetInfo.get_is_symlink();

				if (isSymlink || fileType === Gio.FileType.SYMBOLIC_LINK) {
					statusImage.set_from_icon_name('dialog-warning', Gtk.IconSize.BUTTON);
					statusImage.set_tooltip_text(_('Target is a symlink (indirect reference)'));
					dialog.set_response_sensitive(Gtk.ResponseType.OK, false);
					return;
				} else if (fileType === Gio.FileType.REGULAR) {
					statusImage.set_from_icon_name('dialog-ok', Gtk.IconSize.BUTTON);
					statusImage.set_tooltip_text(_('File exists'));
					dialog.set_response_sensitive(Gtk.ResponseType.OK, true);
				} else {
					statusImage.set_from_icon_name('dialog-warning', Gtk.IconSize.BUTTON);
					statusImage.set_tooltip_text(_('Unknown file type'));
					dialog.set_response_sensitive(Gtk.ResponseType.OK, false);
				}
			} catch (e) {
				statusImage.set_from_icon_name('dialog-error', Gtk.IconSize.BUTTON);
				statusImage.set_tooltip_text(_('Error checking file') + ': ' + e.message);
				dialog.set_response_sensitive(Gtk.ResponseType.OK, false);
			}
		};

		targetEntry.connect('changed', targetCheckFunction);
		targetCheckFunction();

		dialog.show_all();
		let response = dialog.run();

		if (response === Gtk.ResponseType.OK) {
			let target = targetEntry.get_text().trim();
			if (target) {
				try {
					let fullPath = this.themeDir + '/' + this.currentSelectedFile;
					let file = Gio.File.new_for_path(fullPath);

					file.delete(null);
					file.make_symbolic_link(target, null);

					this.currentIcon.realFiles.delete(this.currentSelectedFile);
					this.currentIcon.symlinks.set(this.currentSelectedFile, target);
					this.currentIcon.hasSymlinks = true;

					this.updateFilesList();
					this.setStatus(formatString(_('File converted to symlink: %s → %s'), this.currentSelectedFile, target));
					this.setWindowModified(true);
				} catch (e) {
					this.showError(formatString(_('Error converting to symlink: %s'), e.message));
				}
			}
		}

		dialog.destroy();
	}

	convertToFile() {
		let dialog = new Gtk.MessageDialog({
			transient_for: this.window,
			modal: true,
			message_type: Gtk.MessageType.QUESTION,
			buttons: Gtk.ButtonsType.YES_NO,
			text: _('Convert to file?'),
			secondary_text: formatString(_('Symlink "%s" will be replaced with a copy of the file.'), this.currentSelectedFile)
		});

		if (dialog.run() === Gtk.ResponseType.YES) {
			try {
				let symlinkPath = this.themeDir + '/' + this.currentSelectedFile;
				let symlinkFile = Gio.File.new_for_path(symlinkPath);
				let target = this.currentIcon.symlinks.get(this.currentSelectedFile);

				if (!target) {
					this.showError(_('Symlink target not found'));
					return;
				}

				let symlinkDir = symlinkFile.get_parent();
				let targetFile = symlinkDir.resolve_relative_path(target);

				if (!targetFile.query_exists(null)) {
					this.showError(_('Target file does not exist'));
					return;
				}

				targetFile.copy(symlinkFile, Gio.FileCopyFlags.OVERWRITE, null, null);

				this.currentIcon.symlinks.delete(this.currentSelectedFile);
				this.currentIcon.realFiles.set(this.currentSelectedFile, true);
				this.currentIcon.hasSymlinks = this.currentIcon.symlinks.size > 0;
				this.currentIcon.symlinkOnly = this.currentIcon.realFiles.size === 0 && this.currentIcon.symlinks.size > 0;

				this.updateFilesList();
				this.setStatus(formatString(_('Symlink converted to file: %s'), this.currentSelectedFile));
				this.setWindowModified(true);
			} catch (e) {
				this.showError(formatString(_('Error converting to file: %s'), e.message));
			}
		}

		dialog.destroy();
	}

	// ==================== ПРЕДЛОЖЕНИЕ ЦЕЛИ СИМЛИНКА ====================
	suggestSymlinkTarget(filePath) {
		let parts = filePath.split('/');
		let fileName = parts.pop();

		for (let [otherPath, isReal] of this.currentIcon.realFiles) {
			if (otherPath !== filePath && isReal) {
				let otherParts = otherPath.split('/');
				let otherFileName = otherParts.pop();
				if (otherFileName === fileName) {
					return '../' + otherPath;
				}
			}
		}

		return fileName;
	}

	// ==================== ЗАГРУЗКА ПРЕВЬЮ ЗНАЧКА ====================
	loadPreview(dir, iconName) {
		try {
			let imagePath = null;
			let extensions = ['.png', '.xpm', '.svg'];
			for (let ext of extensions) {
				let testPath = this.themeDir + '/' + dir + '/' + iconName + ext;
				let file = Gio.File.new_for_path(testPath);
				if (file.query_exists(null)) {
					imagePath = testPath;
					break;
				}
			}

			if (!imagePath) {
				this.previewImage.set_from_pixbuf(null);
				return;
			}

			let pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(imagePath, 128, 128);
			this.previewImage.set_from_pixbuf(pixbuf);
		} catch (e) {
			this.previewImage.set_from_pixbuf(null);
		}
	}

	// ==================== ЗАГРУЗКА ПРЕВЬЮ ВЫБРАННОГО ФАЙЛА ====================
	loadFilePreview(filePath) {
		try {
			let file = Gio.File.new_for_path(filePath);

			if (!file.query_exists(null)) {
				this.filePreviewImage.set_from_pixbuf(null);
				this.filePreviewLabel.set_label('');
				return;
			}

			let fileInfo = file.query_info('standard::*,time::*', Gio.FileQueryInfoFlags.NONE, null);
			let isSymlink = fileInfo.get_is_symlink();
			let size = fileInfo.get_size();

			let infoText = '';
			let extension = '';
			let mimeType = '';
			try {
				let contentType = file.query_info('standard::content-type', Gio.FileQueryInfoFlags.NONE, null);
				mimeType = contentType.get_content_type();
			} catch (e) {
				mimeType = 'unknown';
			}

			if (filePath.endsWith('.png')) extension = 'PNG';
			else if (filePath.endsWith('.svg')) extension = 'SVG';
			else if (filePath.endsWith('.xpm')) extension = 'XPM';

			let sizeText = '';
			if (size < 1024) sizeText = size + ' B';
			else if (size < 1024 * 1024) sizeText = (size / 1024).toFixed(1) + ' KB';
			else sizeText = (size / (1024 * 1024)).toFixed(1) + ' MB';

			let modTime = fileInfo.get_modification_date_time();
			let modTimeStr = '';
			if (modTime) modTimeStr = modTime.format('%Y-%m-%d %H:%M:%S');

			let dimensions = '';
			if (extension === 'PNG' || extension === 'XPM') {
				try {
					let pixbuf = GdkPixbuf.Pixbuf.new_from_file(filePath);
					if (pixbuf) {
						dimensions = pixbuf.get_width() + ' × ' + pixbuf.get_height() + ' px';
						pixbuf = null;
					}
				} catch (e) { /* ignore */ }
			}

			infoText = '<b>File:</b> ' + file.get_basename() + '\n';
			if (extension) infoText += '<b>Type:</b> ' + extension + '\n';
			if (dimensions) infoText += '<b>Dimensions:</b> ' + dimensions + '\n';
			infoText += '<b>File size:</b> ' + sizeText + '\n';
			if (modTimeStr) infoText += '<b>Modified:</b> ' + modTimeStr + '\n';

			if (isSymlink) {
				infoText += '\n<b>Symbolic link</b>';
				try {
					let target = fileInfo.get_symlink_target();
					if (target) {
						infoText += '\n<b>Target:</b> ' + target;
						let parent = file.get_parent();
						let targetFile = parent.resolve_relative_path(target);
						if (!targetFile.query_exists(null)) {
							infoText += ' <span color="red">(does not exist)</span>';
						} else {
							infoText += ' <span color="green">(exists)</span>';
						}
					}
				} catch (e) { /* ignore */ }
			}

			this.filePreviewLabel.set_markup(infoText);

			let pixbuf = null;
			try {
				if (extension === 'SVG') {
					this.filePreviewImage.set_from_icon_name('image-x-generic', Gtk.IconSize.LARGE_TOOLBAR);
				} else {
					pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(filePath, 128, 128);
					if (pixbuf) this.filePreviewImage.set_from_pixbuf(pixbuf);
				}
			} catch (e) {
				this.filePreviewImage.set_from_icon_name('image-missing', Gtk.IconSize.LARGE_TOOLBAR);
			}
		} catch (e) {
			log('Error loading file preview: ' + e.message);
			this.filePreviewImage.set_from_pixbuf(null);
			this.filePreviewLabel.set_label('Load error: ' + e.message);
		}
	}

	// ==================== ОТКРЫТИЕ ИЗОБРАЖЕНИЯ В РЕДАКТОРЕ ====================
	openImageInEditor() {
		if (!this.currentPreviewDir || !this.currentIcon) return;

		try {
			let extensions = ['.png', '.xpm', '.svg'];
			for (let ext of extensions) {
				let imagePath = this.themeDir + '/' + this.currentPreviewDir + '/' + this.currentIcon.name + ext;
				let file = Gio.File.new_for_path(imagePath);
				if (file.query_exists(null)) {
					let launcher = Gio.AppInfo.create_from_commandline('xdg-open', null, Gio.AppInfoCreateFlags.NONE);
					launcher.launch([file], null);
					break;
				}
			}
		} catch (e) {
			this.showError(_('Could not open image'));
		}
	}

	// ==================== УДАЛЕНИЕ ФАЙЛА ИЗОБРАЖЕНИЯ ====================
deleteImageFile() {
    let rows = this.getSelectedFileRows();
    if (rows.length === 0) return;

    let fileLabel = '(' + _('file') + ')';
    let symlinkCount = 0;
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].target !== '' && rows[i].target !== fileLabel) symlinkCount++;
    }
    let fileCount = rows.length - symlinkCount;

    let text, secondary;
    if (rows.length === 1) {
        let fileType = symlinkCount === 1 ? _('symlink') : _('file');
        text = formatString(_('Delete %s?'), fileType);
        secondary = formatString(_('Will delete %s "%s". This cannot be undone.'),
                                 fileType, rows[0].path);
    } else {
        text = formatString(_('Delete %d items?'), rows.length);
        secondary = symlinkCount + ' symlink(s), ' + fileCount + ' file(s)';
    }

    let dialog = new Gtk.MessageDialog({
        transient_for: this.window,
        modal: true,
        message_type: Gtk.MessageType.QUESTION,
        buttons: Gtk.ButtonsType.YES_NO,
        text: text,
        secondary_text: secondary
    });

    if (dialog.run() === Gtk.ResponseType.YES) {
        let errors = [];
        let deleted = 0;

        for (let i = 0; i < rows.length; i++) {
            let row = rows[i];
            try {
                let fullPath = this.themeDir + '/' + row.path;
                let file = Gio.File.new_for_path(fullPath);
                if (!file.query_exists(null)) {
                    errors.push(row.path + ': does not exist');
                    continue;
                }
                file.delete(null);

                let isSymlink = row.target !== '' && row.target !== fileLabel;
                if (isSymlink) {
                    this.currentIcon.symlinks.delete(row.path);
                } else {
                    this.currentIcon.realFiles.delete(row.path);
                }
                deleted++;
            } catch (e) {
                errors.push(row.path + ': ' + e.message);
            }
        }

        this.currentIcon.hasSymlinks = this.currentIcon.symlinks.size > 0;
        this.currentIcon.symlinkOnly =
            this.currentIcon.realFiles.size === 0 && this.currentIcon.symlinks.size > 0;

        this.updateFilesList();
        this.updateListDisplay();

        this.previewImage.set_from_pixbuf(null);
        this.previewButton.set_sensitive(false);

        this.setStatus(formatString(_('Deleted %d item(s)'), deleted));
        this.setWindowModified(true);

        if (errors.length > 0) this.showError(errors.join('\n'));
    }

    dialog.destroy();
}

	// ==================== ПРОВЕРКА ЦЕЛИ СИМЛИНКА ====================
	onSymlinkTargetChanged() {
		if (!this.currentSymlink) return;

		let target = this.symlinkTargetEntry.get_text().trim();
		this.symlinkHasChanges = (target !== this.symlinkOriginalTarget);

		if (target) {
			this.checkSymlinkTarget(target);
		} else {
			this.symlinkStatusIcon.set_from_icon_name('dialog-warning', Gtk.IconSize.BUTTON);
			this.symlinkStatusIcon.set_tooltip_text(_('Target not specified'));
			this.symlinkSaveButton.set_sensitive(false);
			this.filePreviewImage.set_from_pixbuf(null);
			this.filePreviewLabel.set_label('');
			this.previewImage.set_from_pixbuf(null);
		}
	}

	checkSymlinkTarget(target) {
		if (!this.currentSymlink) {
			this.symlinkStatusIcon.set_from_pixbuf(null);
			this.symlinkStatusIcon.set_tooltip_text('');
			return;
		}

		if (!target) {
			this.symlinkStatusIcon.set_from_icon_name('dialog-warning', Gtk.IconSize.BUTTON);
			this.symlinkStatusIcon.set_tooltip_text(_('Target not specified'));
			this.updateSymlinkSaveButton();
			return;
		}

		try {
			let symlinkPath = this.themeDir + '/' + this.currentSymlink;
			let symlinkDir = Gio.File.new_for_path(symlinkPath).get_parent();
			let targetFile = symlinkDir.get_child(target);

			if (target.startsWith('./')) targetFile = symlinkDir.get_child(target.substring(2));
			if (target.includes('../')) targetFile = symlinkDir.resolve_relative_path(target);

			if (!targetFile.query_exists(null)) {
				this.symlinkStatusIcon.set_from_icon_name('dialog-error', Gtk.IconSize.BUTTON);
				this.symlinkStatusIcon.set_tooltip_text(_('File does not exist'));
				this.symlinkSaveButton.set_sensitive(false);
				this.filePreviewImage.set_from_pixbuf(null);
				this.filePreviewLabel.set_label('');
				this.previewImage.set_from_pixbuf(null);
				return;
			}

			let targetPath = targetFile.get_path();
			this.loadFilePreview(targetPath);

			if (this.currentIcon) {
				let parts = this.currentSymlink.split('/');
				if (parts.length >= 2) {
					let dir = parts[0];
					this.loadPreview(dir, this.currentIcon.name);
				}
			}

			let targetInfo = targetFile.query_info('standard::type,standard::is-symlink', Gio.FileQueryInfoFlags.NONE, null);
			let fileType = targetInfo.get_file_type();
			let isSymlink = targetInfo.get_is_symlink();

			if (isSymlink || fileType === Gio.FileType.SYMBOLIC_LINK) {
				this.symlinkStatusIcon.set_from_icon_name('dialog-warning', Gtk.IconSize.BUTTON);
				this.symlinkStatusIcon.set_tooltip_text(_('Target is a symlink (indirect reference)'));
				this.symlinkSaveButton.set_sensitive(false);
				return;
			} else if (fileType === Gio.FileType.REGULAR) {
				this.symlinkStatusIcon.set_from_icon_name('dialog-ok', Gtk.IconSize.BUTTON);
				this.symlinkStatusIcon.set_tooltip_text(_('File exists'));
			} else {
				this.symlinkStatusIcon.set_from_icon_name('dialog-warning', Gtk.IconSize.BUTTON);
				this.symlinkStatusIcon.set_tooltip_text(_('Unknown file type'));
				this.symlinkSaveButton.set_sensitive(false);
				return;
			}

			this.updateSymlinkSaveButton();
		} catch (e) {
			this.symlinkStatusIcon.set_from_icon_name('dialog-error', Gtk.IconSize.BUTTON);
			this.symlinkStatusIcon.set_tooltip_text(_('Error checking file') + ': ' + e.message);
			this.symlinkSaveButton.set_sensitive(false);
			this.filePreviewImage.set_from_pixbuf(null);
			this.filePreviewLabel.set_label('');
			this.previewImage.set_from_pixbuf(null);
		}
	}

	updateSymlinkSaveButton() {
		if (!this.currentSymlink || !this.symlinkOriginalTarget) {
			this.symlinkSaveButton.set_sensitive(false);
			return;
		}

		let currentTarget = this.symlinkTargetEntry.get_text().trim();
		let hasChanges = currentTarget !== this.symlinkOriginalTarget;
		let isValid = currentTarget && this.isSymlinkTargetValid(currentTarget);

		this.symlinkSaveButton.set_sensitive(hasChanges && isValid);
	}

	isSymlinkTargetValid(target) {
		if (!target) return false;

		try {
			let symlinkPath = this.themeDir + '/' + this.currentSymlink;
			let symlinkDir = Gio.File.new_for_path(symlinkPath).get_parent();
			let targetFile = symlinkDir.get_child(target);

			if (target.startsWith('./')) targetFile = symlinkDir.get_child(target.substring(2));
			if (target.includes('../')) targetFile = symlinkDir.resolve_relative_path(target);

			if (!targetFile.query_exists(null)) return false;

			let targetInfo = targetFile.query_info('standard::type,standard::is-symlink', Gio.FileQueryInfoFlags.NONE, null);
			let isSymlink = targetInfo.get_is_symlink();
			let fileType = targetInfo.get_file_type();

			if (isSymlink || fileType === Gio.FileType.SYMBOLIC_LINK) return false;
			return fileType === Gio.FileType.REGULAR;
		} catch (e) {
			return false;
		}
	}

	resetSymlinkTarget() {
		if (!this.currentSymlink || !this.currentIcon) return;

		let originalTarget = this.currentIcon.symlinks.get(this.currentSymlink);
		if (originalTarget) {
			this.symlinkTargetEntry.set_text(originalTarget);
			this.checkSymlinkTarget(originalTarget);
		}
	}

	// ==================== СОХРАНЕНИЕ ЦЕЛИ СИМЛИНКА ====================
	saveSymlinkTarget() {
		if (!this.currentSymlink || !this.currentIcon) return;

		let newTarget = this.symlinkTargetEntry.get_text().trim();
		if (!newTarget) {
			this.showError(_('Symlink target cannot be empty'));
			return;
		}

		if (newTarget === this.symlinkOriginalTarget) {
			this.setStatus(_('No changes to save'));
			return;
		}

		let selectedFile = this.currentSelectedFile;

		try {
			let symlinkPath = this.themeDir + '/' + this.currentSymlink;
			let symlinkFile = Gio.File.new_for_path(symlinkPath);

			if (symlinkFile.query_exists(null)) symlinkFile.delete(null);
			symlinkFile.make_symbolic_link(newTarget, null);

			this.currentIcon.symlinks.set(this.currentSymlink, newTarget);
			this.symlinkOriginalTarget = newTarget;
			this.symlinkHasChanges = false;
			this.symlinkSaveButton.set_sensitive(false);

			this.symlinkStatusIcon.set_from_icon_name('dialog-ok', Gtk.IconSize.BUTTON);
			this.symlinkStatusIcon.set_tooltip_text(_('Saved successfully'));

			this.setStatus(_('Symlink target updated'));
			this.setWindowModified(true);

			this.updateListDisplay();

			this.isUpdating = true;
			this.updateFilesList();
			this.isUpdating = false;

			if (selectedFile) {
				GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
					let found = this.selectFileInList(selectedFile);
					if (!found) {
						let iter = this.filesListStore.get_iter_first();
						if (iter) {
							let path = this.filesListStore.get_path(iter);
							this.filesTreeView.set_cursor(path, null, false);
						}
					}
					this.onFileSelected();
					return false;
				});
			}
		} catch (e) {
			this.showError(_('Error saving symlink') + ': ' + e.message);
			this.isUpdating = false;
		}
	}

	selectFileInList(filePath) {
		try {
			let iter = this.filesListStore.get_iter_first();
			let index = 0;
			while (iter) {
				let path = this.filesListStore.get_value(iter, 0);
				if (path === filePath) {
					let treePath = new Gtk.TreePath();
					treePath.append_index(index);
					this.filesTreeView.set_cursor(treePath, null, false);
					return true;
				}
				iter = this.filesListStore.iter_next(iter);
				index++;
			}
		} catch (e) {
			log('Warning: Could not select file "' + filePath + '": ' + e.message);
		}
		return false;
	}

	// ==================== ОБРАБОТКА КЛАВИШ В ПОЛЕ РЕДАКТИРОВАНИЯ СИМЛИНКА ====================
	onSymlinkTargetKeyPress(entry, event) {
		let keyval = event.get_keyval()[1];

		if (keyval === 65293 || keyval === 65421) {
			if (this.symlinkSaveButton.get_sensitive()) this.saveSymlinkTarget();
			return true;
		}

		if (keyval === 65307) {
			this.resetSymlinkTarget();
			this.symlinkTargetEntry.grab_focus();
			this.filesTreeView.grab_focus();
			return true;
		}

		return false;
	}

	// ==================== НОРМАЛИЗАЦИЯ ЦЕЛЕЙ СИМЛИНКОВ ====================
	normalizeSymlinkTarget(target) {
		let withoutExt = target.replace(/\.(png|xpm|svg)$/i, '');
		let normalized = withoutExt.replace(/\/(\d+)(x\d+)?\//g, '/{size}/');
		normalized = normalized.replace(/\/(\d+)(x\d+)?$/, '/{size}');
		normalized = normalized.replace(/\.\.\//g, '');
		return normalized;
	}

	// ==================== УСТАНОВКА ФЛАГА ИЗМЕНЕНИЯ В ЗАГОЛОВКЕ ====================
	setWindowModified(modified) {
		let title = _('Icon Theme Editor - DisplayName');
		if (modified) title += ' *';
		this.window.set_title(title);
	}

	// ==================== ОБНОВЛЕНИЕ СТАТУС-БАРА ====================
	setStatus(message) {
		this.statusbar.remove_all(this.statusContextId);
		this.statusbar.push(this.statusContextId, message);
	}

	// ==================== ЗАГРУЗКА ТЕКУЩЕГО .ICON ФАЙЛА ====================
	loadCurrentIconFile() {
		if (!this.currentIcon) return;

		let contexts = new Set(this.currentIcon.directories.values());
		if (contexts.size !== 1) return;

		let context = Array.from(contexts)[0];
		let directory = Array.from(this.currentIcon.directories.entries())
			.find(([dir, ctx]) => ctx === context)[0];

		let iconFilePath = this.themeDir + '/' + directory + '/' + this.currentIcon.name + '.icon';
		let iconFile = Gio.File.new_for_path(iconFilePath);

		let displayName = '';
		if (iconFile.query_exists(null)) {
			try {
				let [success, contents] = iconFile.load_contents(null);
				if (success) {
					let iconText = imports.byteArray.toString(contents);
					displayName = this.extractDisplayName(iconText) || '';
				}
			} catch (e) { /* ignore */ }
		}

		this.displayNameEntry.set_text(displayName);
	}

	// ==================== СОХРАНЕНИЕ .ICON ФАЙЛА ====================
	saveIconFile() {
		if (!this.currentIcon) return;

		let contexts = new Set(this.currentIcon.directories.values());
		if (contexts.size !== 1) return;

		let context = Array.from(contexts)[0];
		let displayName = this.displayNameEntry.get_text().trim();

		try {
			let iconContent = '';
			if (displayName) iconContent = 'DisplayName=' + displayName + '\n';

			let savedCount = 0;
			for (let [directory, dirContext] of this.currentIcon.directories) {
				if (dirContext === context) {
					let iconFilePath = this.themeDir + '/' + directory + '/' + this.currentIcon.name + '.icon';
					let iconFile = Gio.File.new_for_path(iconFilePath);

					let success = iconFile.replace_contents(
						iconContent, null, false,
						Gio.FileCreateFlags.REPLACE_DESTINATION, null);

					if (success) savedCount++;
				}
			}

			if (savedCount > 0) {
				this.setStatus(formatString(_('DisplayName saved in %d files'), savedCount));
				this.setWindowModified(true);
			} else {
				this.showError(_('Save error'));
			}
		} catch (e) {
			this.showError(_('Error saving') + ': ' + e.message);
		}
	}

	// ==================== ДИАЛОГИ СООБЩЕНИЙ ====================
	showError(message) {
		let dialog = new Gtk.MessageDialog({
			transient_for: this.window,
			modal: true,
			message_type: Gtk.MessageType.ERROR,
			buttons: Gtk.ButtonsType.OK,
			text: message
		});
		dialog.run();
		dialog.destroy();
	}
}

// ==================== ЗАПУСК ПРИЛОЖЕНИЯ ====================
let args = ARGV;
let themePath = null;

if (args.length > 0) {
	themePath = args[0];
} else {
	themePath = GLib.get_current_dir() + '/index.theme';
	let file = Gio.File.new_for_path(themePath);
	if (!file.query_exists(null)) {
		print('Usage: gjs script.js /path/to/index.theme');
		System.exit(1);
	}
}

let app = new IconThemeEditor(themePath);
Gtk.main();