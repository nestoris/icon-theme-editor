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
    this.iconSelectTimer = null; // Добавить эту строку
    this.createUI();
    this.loadTheme();
}

	// ==================== СОЗДАНИЕ ИНТЕРФЕЙСА ====================
	createUI() {
		this.window = new Gtk.Window({
			title: _('Icon Theme Editor - DisplayName'),
			default_width: 1000,
			default_height: 800,
			window_position: Gtk.WindowPosition.CENTER
		});
		
		this.window.connect('destroy', () => Gtk.main_quit());

		let mainBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 10,
			margin: 10
		});

		let topBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 10
		});

		this.refreshButton = new Gtk.Button({ label: _('Refresh') });
		this.refreshButton.connect('clicked', () => this.loadTheme());
		topBox.pack_start(this.refreshButton, false, false, 0);

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
			width_request: 400
		});

		let listScrolled = new Gtk.ScrolledWindow();
		listScrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
		
		this.listStore = new Gtk.ListStore();
		this.listStore.set_column_types([GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_STRING]);
		
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
		nameColumn.connect('clicked', () => {
			this.listStore.set_sort_column_id(0, Gtk.SortType.ASCENDING);
		});
		this.treeView.append_column(nameColumn);
		
		let contextRenderer = new Gtk.CellRendererText();
		let contextColumn = new Gtk.TreeViewColumn({ title: _('Context') });
		contextColumn.pack_start(contextRenderer, true);
		contextColumn.add_attribute(contextRenderer, 'text', 3);
		contextColumn.set_min_width(100);
		contextColumn.set_sort_column_id(3);
		contextColumn.connect('clicked', () => {
			this.listStore.set_sort_column_id(3, Gtk.SortType.ASCENDING);
		});
		this.treeView.append_column(contextColumn);
		
		let reasonRenderer = new Gtk.CellRendererText();
		let reasonColumn = new Gtk.TreeViewColumn({ title: _('Status') });
		reasonColumn.pack_start(reasonRenderer, true);
		reasonColumn.add_attribute(reasonRenderer, 'text', 2);
		reasonColumn.set_min_width(150);
		reasonColumn.set_sort_column_id(2);
		reasonColumn.connect('clicked', () => {
			this.listStore.set_sort_column_id(2, Gtk.SortType.ASCENDING);
		});
		this.treeView.append_column(reasonColumn);
		
		this.treeView.connect('cursor-changed', this.onIconSelected.bind(this));
		listScrolled.add(this.treeView);
		
		leftPane.pack_start(listScrolled, true, true, 0);
		
		contentBox.pack_start(leftPane, false, false, 0);

		let editorBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 10,
			hexpand: true
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
		contextsPreviewBox.set_size_request(-1, 300);

		let filesScrolled = new Gtk.ScrolledWindow();
		filesScrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
		
		this.filesListStore = new Gtk.ListStore();
		this.filesListStore.set_column_types([GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_STRING]);
		
		this.filesTreeView = new Gtk.TreeView({ 
			model: this.filesListStore
		});
		
		let filePathRenderer = new Gtk.CellRendererText();
		let filePathColumn = new Gtk.TreeViewColumn({ title: _('File') });
		filePathColumn.pack_start(filePathRenderer, true);
		filePathColumn.add_attribute(filePathRenderer, 'text', 0);
		this.filesTreeView.append_column(filePathColumn);
		
		let fileTargetRenderer = new Gtk.CellRendererText();
		let fileTargetColumn = new Gtk.TreeViewColumn({ title: _('Target') });
		fileTargetColumn.pack_start(fileTargetRenderer, true);
		fileTargetColumn.add_attribute(fileTargetRenderer, 'text', 1);
		fileTargetColumn.add_attribute(fileTargetRenderer, 'foreground', 2);
		this.filesTreeView.append_column(fileTargetColumn);
		
		this.filesTreeView.connect('cursor-changed', this.onFileSelected.bind(this));
		this.filesTreeView.connect('row-activated', this.onFileActivated.bind(this));
		filesScrolled.add(this.filesTreeView);
		contextsPreviewBox.pack_start(filesScrolled, true, true, 0);

		let previewControlBox = new Gtk.Box({
			orientation: Gtk.Orientation.VERTICAL,
			spacing: 10,
			width_request: 200
		});

		this.previewImage = new Gtk.Image();
		this.previewImage.set_size_request(128, 128);
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
			spacing: 5
		});

		let targetLabel = new Gtk.Label({ 
			label: _('Symlink target:'),
			halign: Gtk.Align.START
		});
		symlinkEditorBox.pack_start(targetLabel, false, false, 0);

		let targetEntryBox = new Gtk.Box({
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 5
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
			spacing: 5
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
			spacing: 10,
			margin_top: 5
		});

		this.filePreviewImage = new Gtk.Image();
		this.filePreviewImage.set_size_request(128, 128);
		this.filePreviewBox.pack_start(this.filePreviewImage, false, false, 0);

		this.filePreviewLabel = new Gtk.Label({
			label: '',
			halign: Gtk.Align.START,
			valign: Gtk.Align.START,
			wrap: true,
			width_request: 300
		});
		this.filePreviewBox.pack_start(this.filePreviewLabel, true, true, 10);

		contextsMainBox.pack_start(contextsPreviewBox, false, false, 0);
		contextsMainBox.pack_start(this.filePreviewBox, false, false, 0);
		editorBox.pack_start(contextsMainBox, false, false, 0);

		editorBox.pack_start(new Gtk.Label({ label: '' }), true, true, 0);

		contentBox.pack_start(editorBox, true, true, 0);
		mainBox.pack_start(contentBox, true, true, 0);

		this.statusbar = new Gtk.Statusbar();
		this.statusContextId = this.statusbar.get_context_id('main');
		mainBox.pack_start(this.statusbar, false, false, 0);

		this.window.add(mainBox);
		this.window.show_all();
	}

// ==================== НАСТРОЙКА ГОРЯЧИХ КЛАВИШ ====================
setupAccelerators() {
    // Создаём группу акселераторов
    let accelGroup = new Gtk.AccelGroup();
    this.window.add_accel_group(accelGroup);
    
    // Клавиша Delete - удаление файла
    accelGroup.connect(
        Gdk.KEY_Delete,
        Gtk.ModifierType.MOD1_MASK,
        Gtk.AccelFlags.VISIBLE,
        () => {
            if (this.currentSelectedFile && this.currentIcon && this.deleteButton.get_sensitive()) {
                this.deleteImageFile();
            }
            return true;
        }
    );
    
    // Клавиша Delete (альтернативный код) - на всякий случай
    accelGroup.connect(
        65535, // GDK_KEY_Delete
        Gtk.ModifierType.MOD1_MASK,
        Gtk.AccelFlags.VISIBLE,
        () => {
            if (this.currentSelectedFile && this.currentIcon && this.deleteButton.get_sensitive()) {
                this.deleteImageFile();
            }
            return true;
        }
    );
    
    // Ctrl+Delete - тоже удаление (запасной вариант)
    accelGroup.connect(
        Gdk.KEY_Delete,
        Gtk.ModifierType.CONTROL_MASK,
        Gtk.AccelFlags.VISIBLE,
        () => {
            if (this.currentSelectedFile && this.currentIcon && this.deleteButton.get_sensitive()) {
                this.deleteImageFile();
            }
            return true;
        }
    );
}

// ==================== ФИЛЬТРАЦИЯ СПИСКА ====================
onFilterChanged() {
    // Блокируем обновления, чтобы избежать циклических вызовов
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
    
    // Обновляем список иконок
    this.updateListDisplay();
    
    // Сбрасываем текущую выбранную иконку
    this.currentIcon = null;
    this.iconNameLabel.set_label(_('None'));
    
    // Сбрасываем редактор
    this.displayNameEntry.set_text('');
    this.displayNameEntry.set_sensitive(false);
    this.saveButton.set_sensitive(false);
    this.resetButton.set_sensitive(false);
    this.warningLabel.set_label('');
    
    // Сбрасываем превью
    this.previewImage.set_from_pixbuf(null);
    this.previewButton.set_sensitive(false);
    this.deleteButton.set_sensitive(false);
    this.convertToSymlinkButton.set_sensitive(false);
    this.filePreviewImage.set_from_pixbuf(null);
    this.filePreviewLabel.set_label('');
    
    // Сбрасываем редактор симлинков
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
    
    // Очищаем список файлов
    this.filesListStore.clear();
    
    this.setStatus(formatString(_('Filtered: %d icons shown'), this.filteredIcons.length));
    
    this.isUpdating = false;
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
			
			this.listStore.set(iter, [0, 1, 2, 3], [icon.name + displayName, color, reason, contextText]);
		}
		
		this.listStore.set_sort_column_id(0, Gtk.SortType.ASCENDING);
	}

	// ==================== ЗАГРУЗКА ТЕМЫ ====================
loadTheme() {
    // Блокируем обновления, чтобы избежать циклических вызовов
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
        // Применяем фильтр, если в строке что-то написано
        this.onFilterChanged();

        
        // Сбрасываем текущую выбранную иконку
        this.currentIcon = null;
        this.iconNameLabel.set_label(_('None'));
        
        // Сбрасываем редактор
        this.displayNameEntry.set_text('');
        this.displayNameEntry.set_sensitive(false);
        this.saveButton.set_sensitive(false);
        this.resetButton.set_sensitive(false);
        this.warningLabel.set_label('');
        
        // Сбрасываем превью
        this.previewImage.set_from_pixbuf(null);
        this.previewButton.set_sensitive(false);
        this.deleteButton.set_sensitive(false);
        this.convertToSymlinkButton.set_sensitive(false);
        this.filePreviewImage.set_from_pixbuf(null);
        this.filePreviewLabel.set_label('');
        
        // Сбрасываем редактор симлинков
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
        
        // Очищаем список файлов
        this.filesListStore.clear();
        
        this.setStatus(formatString(_('Loaded %d icons'), this.icons.length));
        
    } catch (e) {
        this.showError(_('Error loading theme') + ': ' + e.message);
    }
    
    // Разблокируем обновления
    this.isUpdating = false;
}

	// ==================== СКАНИРОВАНИЕ ЗНАЧКОВ ====================
	scanIcons() {
		this.icons = [];
		this.listStore.clear();

		try {
			let indexFile = Gio.File.new_for_path(this.themeDir + '/index.theme');
			let [success, contents] = indexFile.load_contents(null);
			
			if (!success) {
				this.showError(_('Could not read index.theme'));
				return;
			}

			let text = imports.byteArray.toString(contents);
			let directories = [];
			let directoryContexts = new Map();
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
					directories.push(...dirs.map(d => d.trim()));
				} else if (currentSection !== '' && line.includes('=')) {
					let [key, value] = line.split('=', 2);
					key = key.trim();
					value = value.trim();
					if (key === 'Context') {
						directoryContexts.set(currentSection, value);
					}
				}
			}

			let iconMap = new Map();
			let validExtensions = new Set(['.png', '.xpm', '.svg']);
			
			for (let dirName of directories) {
				let dir = Gio.File.new_for_path(this.themeDir + '/' + dirName);
				if (!dir.query_exists(null)) continue;
				
				let context = directoryContexts.get(dirName) || 'Unknown';
				
				let enumerator = dir.enumerate_children('standard::name,standard::type,standard::is-symlink', 
					Gio.FileQueryInfoFlags.NONE, null);
				
				let info;
				while ((info = enumerator.next_file(null)) !== null) {
					let name = info.get_name();
					let type = info.get_file_type();
					let isSymlink = info.get_is_symlink();
					
					if (type === Gio.FileType.REGULAR || type === Gio.FileType.SYMBOLIC_LINK) {
						let ext = name.substring(name.lastIndexOf('.'));
						if (validExtensions.has(ext.toLowerCase())) {
							let baseName = name.substring(0, name.lastIndexOf('.'));
							
							if (!iconMap.has(baseName)) {
								iconMap.set(baseName, {
									name: baseName,
									directories: new Map(),
									displayNames: new Set(),
									symlinks: new Map(),
									realFiles: new Map(),
									hasSymlinks: false,
									symlinkOnly: true
								});
							}
							
							let iconInfo = iconMap.get(baseName);
							iconInfo.directories.set(dirName, context);
							
							if (isSymlink) {
								iconInfo.hasSymlinks = true;
								try {
									let symlinkFile = dir.get_child(name);
									let targetInfo = symlinkFile.query_info('standard::symlink-target', Gio.FileQueryInfoFlags.NONE, null);
									let symlinkTarget = targetInfo.get_symlink_target();
									if (symlinkTarget) {
										iconInfo.symlinks.set(dirName + '/' + name, symlinkTarget);
									}
								} catch (e) {
									// Игнорируем ошибки чтения симлинков
								}
							} else {
								iconInfo.symlinkOnly = false;
								iconInfo.realFiles.set(dirName + '/' + name, true);
							}
							
							let iconFilePath = this.themeDir + '/' + dirName + '/' + baseName + '.icon';
							let iconFile = Gio.File.new_for_path(iconFilePath);
							if (iconFile.query_exists(null)) {
								let [success, contents] = iconFile.load_contents(null);
								if (success) {
									let iconText = imports.byteArray.toString(contents);
									let displayName = this.extractDisplayName(iconText);
									if (displayName) {
										iconInfo.displayNames.add(displayName);
									}
								}
							}
						}
					}
				}
				enumerator.close(null);
			}

			this.icons = Array.from(iconMap.values()).sort((a, b) => a.name.localeCompare(b.name));
			this.filteredIcons = this.icons;
			
			this.updateListDisplay();
      // Применяем фильтр
      this.onFilterChanged();
			this.setStatus(formatString(_('Loaded %d icons'), this.icons.length));

		} catch (e) {
			this.showError(_('Error scanning') + ': ' + e.message);
		}
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

// ==================== ВЫБОР ЗНАЧКА ====================
onIconSelected() {
    // Если идёт обновление, игнорируем сигнал
    if (this.isUpdating) return;
    
    let [success, model, iter] = this.treeView.get_selection().get_selected();
    if (!success || !iter) return;
    
    let nameWithSuffix = model.get_value(iter, 0);
    let baseName = nameWithSuffix.split(' - ')[0].split(' [')[0];
    
    // Если это та же иконка, ничего не делаем
    if (this.currentIcon && this.currentIcon.name === baseName) {
        return;
    }
    
    // Проверяем, есть ли текст в фильтре
    let filterText = this.filterEntry.get_text().trim();
    let hasFilter = filterText !== '';
    
    if (hasFilter) {
        // Если фильтр активен - используем задержку (debounce)
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
        // Если фильтр пустой - выполняем сразу
        this.doIconSelected(baseName);
    }
}

// ==================== РЕАЛЬНОЕ ВЫПОЛНЕНИЕ ВЫБОРА ЗНАЧКА ====================
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

    // Полный сброс редактора симлинков
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

    // Сброс превью
    this.previewImage.set_from_pixbuf(null);
    this.previewButton.set_sensitive(false);
    this.deleteButton.set_sensitive(false);
    this.convertToSymlinkButton.set_sensitive(false);
    this.filePreviewImage.set_from_pixbuf(null);
    this.filePreviewLabel.set_label('');

    // Обновляем список файлов
    this.updateFilesList();
    
    // Автоматически выбираем первый файл в списке
    this.selectFirstFile();
    
    this.loadCurrentIconFile();
}

// ==================== ОБРАБОТКА КЛАВИШ В ПОЛЕ РЕДАКТИРОВАНИЯ СИМЛИНКА ====================
onSymlinkTargetKeyPress(entry, event) {
    let keyval = event.get_keyval()[1];
    
    // Enter - сохранить
    if (keyval === 65293 || keyval === 65421) { // GDK_KEY_Return или GDK_KEY_KP_Enter
        if (this.symlinkSaveButton.get_sensitive()) {
            this.saveSymlinkTarget();
        }
        return true; // Поглощаем событие
    }
    
    // Escape - сбросить
    if (keyval === 65307) { // GDK_KEY_Escape
        this.resetSymlinkTarget();
        // Снимаем фокус с поля ввода
        this.symlinkTargetEntry.grab_focus();
        // Передаём фocus обратно на дерево файлов
        this.filesTreeView.grab_focus();
        return true;
    }
    
    return false; // Позволяем обработать событие дальше
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
        // Игнорируем ошибки - выводим только в терминал
        log('Warning: Could not select first file: ' + e.message);
    }
}

	// ==================== ВЫБОР ФАЙЛА ====================
	onFileSelected() {
    // Если идёт обновление, игнорируем сигнал
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
		this.deleteButton.set_sensitive(true);
		this.convertToSymlinkButton.set_sensitive(true);
		
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
	}

	// ==================== ДВОЙНОЙ КЛИК ПО ФАЙЛУ ====================
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
					'xdg-open', 
					null, 
					Gio.AppInfoCreateFlags.SUPPORTS_URIS
				);
				
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

	// ==================== ВЫДЕЛИТЬ ФАЙЛ ЧЕРЕЗ D-BUS ====================
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
					base_stream: new Gio.UnixInputStream({fd: stdout})
				});
				
				output.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
					try {
						let [line] = source.read_line_finish(result);
						if (line) {
							log('D-Bus response: ' + line);
						}
					} catch (e) {
						// Игнорируем ошибки чтения
					}
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

	// ==================== ОБНОВЛЕНИЕ СПИСКА ФАЙЛОВ ====================
updateFilesList() {
    // Не вызываем unselect_all()
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

// ==================== ОБНОВЛЕНИЕ СТАТУСА ТЕКУЩЕЙ ИКОНКИ ====================
updateCurrentIconStatus() {
    if (!this.currentIcon) return;
    
    try {
        let iter = this.listStore.get_iter_first();
        while (iter) {
            let nameWithSuffix = this.listStore.get_value(iter, 0);
            let baseName = nameWithSuffix.split(' - ')[0].split(' [')[0];
            if (baseName === this.currentIcon.name) {
                let color = 'black';
                let reason = _('OK');
                let contextText = '';
                
                let contexts = new Set(this.currentIcon.directories.values());
                
                if (contexts.size > 1) {
                    contextText = _('Multiple');
                } else if (contexts.size === 1) {
                    contextText = Array.from(contexts)[0];
                } else {
                    contextText = _('None');
                }
                
                let hasDifferentTargets = false;
                if (this.currentIcon.symlinks.size > 1) {
                    let targets = new Set();
                    for (let target of this.currentIcon.symlinks.values()) {
                        let normalizedTarget = this.normalizeSymlinkTarget(target);
                        targets.add(normalizedTarget);
                    }
                    hasDifferentTargets = targets.size > 1;
                }
                
                if (contexts.size > 1) {
                    color = 'red';
                    reason = _('Multiple contexts');
                } else if (this.currentIcon.displayNames.size > 1) {
                    color = 'orange';
                    reason = _('Different DisplayName');
                } else if (hasDifferentTargets) {
                    color = 'magenta';
                    reason = _('Different symlink targets');
                } else if (this.currentIcon.symlinkOnly) {
                    color = 'purple';
                    reason = _('Symlinks only');
                } else if (this.currentIcon.hasSymlinks) {
                    color = 'blue';
                    reason = _('Has symlinks');
                } else if (this.currentIcon.displayNames.size === 1) {
                    reason = 'DisplayName: ' + Array.from(this.currentIcon.displayNames)[0];
                }
                
                let displayName = '';
                if (this.currentIcon.displayNames.size === 1 && contexts.size === 1) {
                    displayName = ' - ' + Array.from(this.currentIcon.displayNames)[0];
                }
                
                this.listStore.set(iter, [0, 1, 2, 3], 
                    [this.currentIcon.name + displayName, color, reason, contextText]);
                
                return true;
            }
            iter = this.listStore.iter_next(iter);
        }
    } catch (e) {
        log('Warning: Could not update icon status: ' + e.message);
    }
    return false;
}

	// ==================== ПРЕОБРАЗОВАНИЕ ФАЙЛА/СИМЛИНКА ====================
	convertToSymlink() {
		if (!this.currentSelectedFile || !this.currentIcon) return;
		
		if (this.currentSelectedIsSymlink) {
			this.convertToFile();
		} else {
			this.convertSymlinkToFile();
		}
	}

	// ==================== ПРЕОБРАЗОВАНИЕ ФАЙЛА В СИМЛИНК ====================
// ==================== ПРЕОБРАЗОВАНИЕ ФАЙЛА В СИМЛИНК С ДИАЛОГОМ ====================
convertSymlinkToFile() {
    if (!this.currentSelectedFile || !this.currentIcon) return;
    
    // Создаём диалог
    let dialog = new Gtk.Dialog({
        title: _('Convert to symlink'),
        transient_for: this.window,
        modal: true,
        destroy_with_parent: true
    });
    
    // Добавляем кнопки
    dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
    dialog.add_button(_('OK'), Gtk.ResponseType.OK);
    dialog.set_default_response(Gtk.ResponseType.OK);
    
    // Создаём содержимое диалога
    let contentBox = dialog.get_content_area();
    contentBox.set_spacing(10);
    contentBox.set_margin_start(10);
    contentBox.set_margin_end(10);
    contentBox.set_margin_top(10);
    contentBox.set_margin_bottom(10);
    
    // Текст с информацией о файле
    let infoLabel = new Gtk.Label({
        label: formatString(_('File "%s" will be replaced with a symlink. Enter the target path:'), this.currentSelectedFile),
        halign: Gtk.Align.START,
        wrap: true,
        selectable: true
    });
    contentBox.pack_start(infoLabel, false, false, 0);
    
    // Поле ввода цели
    let targetEntry = new Gtk.Entry({
        hexpand: true,
        placeholder_text: _('Enter target path...')
    });
    
    // Индикатор статуса цели
    let statusImage = new Gtk.Image();
    statusImage.set_size_request(16, 16);
    statusImage.set_from_icon_name('dialog-warning', Gtk.IconSize.BUTTON);
    statusImage.set_tooltip_text(_('Enter a target path'));
    
    // Контейнер для поля ввода и индикатора
    let entryBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 5
    });
    entryBox.pack_start(targetEntry, true, true, 0);
    entryBox.pack_start(statusImage, false, false, 0);
    contentBox.pack_start(entryBox, false, false, 0);
    
    // Предлагаем цель по умолчанию
    let defaultTarget = this.suggestSymlinkTarget(this.currentSelectedFile);
    targetEntry.set_text(defaultTarget);
    
// Функция проверки цели
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
        
        // Проверяем тип файла
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
    
    // Подключаем проверку при изменении текста
    targetEntry.connect('changed', targetCheckFunction);
    
    // Изначально проверяем цель
    targetCheckFunction();
    
    // Показываем диалог
    dialog.show_all();
    
    // Обрабатываем ответ
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

	// ==================== ПРЕОБРАЗОВАНИЕ СИМЛИНКА В ФАЙЛ ====================
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
		let dirName = parts.join('/');
		
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
			let fileType = fileInfo.get_file_type();
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
			
			if (filePath.endsWith('.png')) {
				extension = 'PNG';
			} else if (filePath.endsWith('.svg')) {
				extension = 'SVG';
			} else if (filePath.endsWith('.xpm')) {
				extension = 'XPM';
			}
			
			let sizeText = '';
			if (size < 1024) {
				sizeText = size + ' B';
			} else if (size < 1024 * 1024) {
				sizeText = (size / 1024).toFixed(1) + ' KB';
			} else {
				sizeText = (size / (1024 * 1024)).toFixed(1) + ' MB';
			}
			
			let modTime = fileInfo.get_modification_date_time();
			let modTimeStr = '';
			if (modTime) {
				modTimeStr = modTime.format('%Y-%m-%d %H:%M:%S');
			}
			
			let dimensions = '';
			if (extension === 'PNG' || extension === 'XPM') {
				try {
					let pixbuf = GdkPixbuf.Pixbuf.new_from_file(filePath);
					if (pixbuf) {
						dimensions = pixbuf.get_width() + ' × ' + pixbuf.get_height() + ' px';
						pixbuf = null;
					}
				} catch (e) {
					// Could not get dimensions
				}
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
				} catch (e) {
					// Не удалось получить цель симлинка
				}
			}
			
			this.filePreviewLabel.set_markup(infoText);
			
			let pixbuf = null;
			try {
				if (extension === 'SVG') {
					this.filePreviewImage.set_from_icon_name('image-x-generic', Gtk.IconSize.LARGE_TOOLBAR);
				} else {
					pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(filePath, 128, 128);
					if (pixbuf) {
						this.filePreviewImage.set_from_pixbuf(pixbuf);
					}
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
    if (!this.currentSelectedFile || !this.currentIcon) return;
    
    let fileType = this.currentSelectedIsSymlink ? _('symlink') : _('file');
    let dialog = new Gtk.MessageDialog({
        transient_for: this.window,
        modal: true,
        message_type: Gtk.MessageType.QUESTION,
        buttons: Gtk.ButtonsType.YES_NO,
        text: formatString(_('Delete %s?'), fileType),
        secondary_text: formatString(_('Will delete %s "%s". This cannot be undone.'), fileType, this.currentSelectedFile)
    });
    
    if (dialog.run() === Gtk.ResponseType.YES) {
        try {
            let fullPath = this.themeDir + '/' + this.currentSelectedFile;
            let file = Gio.File.new_for_path(fullPath);
            
            if (file.query_exists(null)) {
                file.delete(null);
                
                if (this.currentSelectedIsSymlink) {
                    this.currentIcon.symlinks.delete(this.currentSelectedFile);
                    this.currentIcon.hasSymlinks = this.currentIcon.symlinks.size > 0;
                } else {
                    this.currentIcon.realFiles.delete(this.currentSelectedFile);
                }
                
                this.currentIcon.symlinkOnly = this.currentIcon.realFiles.size === 0 && this.currentIcon.symlinks.size > 0;
                
                // Обновляем список файлов
                this.updateFilesList();
                
                // Сбрасываем превью
                this.previewImage.set_from_pixbuf(null);
                this.previewButton.set_sensitive(false);
                this.deleteButton.set_sensitive(false);
                this.convertToSymlinkButton.set_sensitive(false);
                
                // Обновляем статус текущей иконки в левом списке (без перезагрузки всей темы!)
                this.updateCurrentIconStatus();
                
                this.setStatus(formatString(_('Deleted %s: %s'), fileType, this.currentSelectedFile));
                this.setWindowModified(true);
                
            } else {
                this.showError(_('File does not exist'));
            }
            
        } catch (e) {
            this.showError(_('Error deleting file') + ': ' + e.message);
        }
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

// ==================== ПРОВЕРКА СУЩЕСТВОВАНИЯ ЦЕЛИ ====================
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
        
        if (target.startsWith('./')) {
            targetFile = symlinkDir.get_child(target.substring(2));
        }
        
        if (target.includes('../')) {
            targetFile = symlinkDir.resolve_relative_path(target);
        }
        
        if (!targetFile.query_exists(null)) {
            this.symlinkStatusIcon.set_from_icon_name('dialog-error', Gtk.IconSize.BUTTON);
            this.symlinkStatusIcon.set_tooltip_text(_('File does not exist'));
            this.symlinkSaveButton.set_sensitive(false);
            this.filePreviewImage.set_from_pixbuf(null);
            this.filePreviewLabel.set_label('');
            this.previewImage.set_from_pixbuf(null);
            return;
        }
        
        // Загружаем превью найденного файла
        let targetPath = targetFile.get_path();
        this.loadFilePreview(targetPath);
        
        // Также загружаем основное превью иконки
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
        
        // Проверяем, является ли цель симлинком
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

	// ==================== ОБНОВЛЕНИЕ СОСТОЯНИЯ КНОПКИ SAVE ====================
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

// ==================== ПРОВЕРКА ВАЛИДНОСТИ ЦЕЛИ ====================
isSymlinkTargetValid(target) {
    if (!target) return false;
    
    try {
        let symlinkPath = this.themeDir + '/' + this.currentSymlink;
        let symlinkDir = Gio.File.new_for_path(symlinkPath).get_parent();
        let targetFile = symlinkDir.get_child(target);
        
        if (target.startsWith('./')) {
            targetFile = symlinkDir.get_child(target.substring(2));
        }
        
        if (target.includes('../')) {
            targetFile = symlinkDir.resolve_relative_path(target);
        }
        
        if (!targetFile.query_exists(null)) {
            return false;
        }
        
        // Проверяем, является ли цель симлинком
        let targetInfo = targetFile.query_info('standard::type,standard::is-symlink', Gio.FileQueryInfoFlags.NONE, null);
        let isSymlink = targetInfo.get_is_symlink();
        let fileType = targetInfo.get_file_type();
        
        // Если это симлинк - считаем невалидным
        if (isSymlink || fileType === Gio.FileType.SYMBOLIC_LINK) {
            return false;
        }
        
        return fileType === Gio.FileType.REGULAR;
    } catch (e) {
        return false;
    }
}

	// ==================== СБРОС ЦЕЛИ СИМЛИНКА ====================
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
        
        if (symlinkFile.query_exists(null)) {
            symlinkFile.delete(null);
        }
        symlinkFile.make_symbolic_link(newTarget, null);
        
        this.currentIcon.symlinks.set(this.currentSymlink, newTarget);
        this.symlinkOriginalTarget = newTarget;
        this.symlinkHasChanges = false;
        this.symlinkSaveButton.set_sensitive(false);
        
        this.symlinkStatusIcon.set_from_icon_name('dialog-ok', Gtk.IconSize.BUTTON);
        this.symlinkStatusIcon.set_tooltip_text(_('Saved successfully'));
        
        this.setStatus(_('Symlink target updated'));
        this.setWindowModified(true);
        // Обновляем статус текущей иконки в левом списке
        this.updateCurrentIconStatus();

        
        // Блокируем сигналы во время обновления списка
        this.isUpdating = true;
        this.updateFilesList();
        this.isUpdating = false;
        
        // Восстанавливаем выделение после обновления
        if (selectedFile) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
                let found = this.selectFileInList(selectedFile);
                // Если файл не найден, выбираем первый
                if (!found) {
                    let iter = this.filesListStore.get_iter_first();
                    if (iter) {
                        let path = this.filesListStore.get_path(iter);
                        this.filesTreeView.set_cursor(path, null, false);
                    }
                }
                // Принудительно обновляем панель предпросмотра
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
                // Используем рабочий способ создания TreePath
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
		if (modified) {
			title += ' *';
		}
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
			} catch (e) {
				// Игнорируем ошибки чтения
			}
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
			if (displayName) {
				iconContent = 'DisplayName=' + displayName + '\n';
			}

			let savedCount = 0;
			for (let [directory, dirContext] of this.currentIcon.directories) {
				if (dirContext === context) {
					let iconFilePath = this.themeDir + '/' + directory + '/' + this.currentIcon.name + '.icon';
					let iconFile = Gio.File.new_for_path(iconFilePath);
					
					let success = iconFile.replace_contents(
						iconContent,
						null,
						false,
						Gio.FileCreateFlags.REPLACE_DESTINATION,
						null
					);
					
					if (success) {
						savedCount++;
					}
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