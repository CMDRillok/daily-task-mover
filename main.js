'use strict';

const {
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  Notice,
  normalizePath,
  moment,
} = require('obsidian');

const DEFAULT_SETTINGS = {
  dailyFolder: 'daily',
  dailyDateFormat: 'YYYY-MM-DD',
  notebookPath: 'общее/всё остальное/Блокнот.md',
  templatePath: 'templates/ежедневная заметка.md',
  taskHeading: '## Задачи на сегодня',
  autoMoveOnEdit: true,
  scanOnStartup: true,
  debounceMs: 1500,
  startupDelayMs: 3000,
  stripDate: true,
  parseIsoDate: true,
  parseDottedDate: true,
  parseRelativeDate: true,
  parseWeekday: true,
};

const WEEKDAY_WORDS = [
  ['понедельник', 1],
  ['вторник', 2],
  ['сред', 3],
  ['четверг', 4],
  ['пятниц', 5],
  ['суббот', 6],
  ['воскресень', 0],
];

function pad2(number) {
  return String(number).padStart(2, '0');
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const result = startOfDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

function makeDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function weekdayFromWord(word) {
  const normalized = word.toLowerCase();
  for (const [stem, day] of WEEKDAY_WORDS) {
    if (normalized.startsWith(stem)) return day;
  }
  return null;
}

function cleanPath(value, allowEmpty = false) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return allowEmpty ? '' : null;
  const normalized = normalizePath(raw).replace(/^\/+|\/+$/g, '');
  if (!normalized) return allowEmpty ? '' : null;
  return normalized;
}

function normalizeFolder(value) {
  return cleanPath(value) || DEFAULT_SETTINGS.dailyFolder;
}

function normalizeDateFormat(value) {
  const format = String(value == null ? '' : value).trim();
  if (!format || format.includes('/') || format.includes('\\')) {
    return DEFAULT_SETTINGS.dailyDateFormat;
  }
  return format;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function headingLevel(heading) {
  const match = String(heading).match(/^(#{1,6})\s+/);
  return match ? match[1].length : 2;
}

function extractDateSuffix(text, now, options = {}) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, options);
  const patterns = [];

  if (settings.parseIsoDate) {
    patterns.push({
      re: /(?:^|[\s,;])(?:(?:до|к|на|в|во)\s+)?(\d{4})-(\d{2})-(\d{2})\s*[.,!;]?\s*$/i,
      build: (match) => makeDate(Number(match[1]), Number(match[2]), Number(match[3])),
    });
  }

  if (settings.parseDottedDate) {
    patterns.push({
      re: /(?:^|[\s,;])(?:(?:до|к|на|в|во)\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})\s*[.,!;]?\s*$/i,
      build: (match) => makeDate(Number(match[3]), Number(match[2]), Number(match[1])),
    });
  }

  if (settings.parseRelativeDate) {
    patterns.push({
      re: /(?:^|[\s,;])(?:(?:до|к|на|в|во)\s+)?(послезавтра|завтра)\s*[.,!;]?\s*$/i,
      build: (match) => addDays(now, match[1].toLowerCase() === 'завтра' ? 1 : 2),
    });
  }

  if (settings.parseWeekday) {
    patterns.push({
      re: /(?:^|[\s,;])(?:(?:в|во|на)\s+)?(понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресень[ея])\s*[.,!;]?\s*$/i,
      build: (match) => {
        const targetDay = weekdayFromWord(match[1]);
        if (targetDay === null) return null;
        const today = startOfDay(now);
        const delta = (targetDay - today.getDay() + 7) % 7;
        return addDays(today, delta);
      },
    });
  }

  for (const pattern of patterns) {
    const match = text.match(pattern.re);
    if (!match) continue;
    const date = pattern.build(match);
    if (!date) continue;
    const cleaned = text
      .slice(0, match.index)
      .replace(/[\s,;]+$/, '')
      .trimEnd();
    if (!cleaned) return null;
    return {
      date: formatDate(date),
      text: settings.stripDate ? cleaned : text.trim(),
    };
  }

  return null;
}

function parseTaskLine(line, now, options = {}) {
  const match = line.match(/^(\s*)[-*]\s+\[ \]\s+(.+?)\s*$/);
  if (!match) return null;
  const parsed = extractDateSuffix(match[2], now, options);
  if (!parsed) return null;
  return { date: parsed.date, text: parsed.text, line };
}

function insertTask(content, taskLine, heading = DEFAULT_SETTINGS.taskHeading) {
  const task = String(taskLine).trim();
  const normalizedHeading =
    String(heading == null ? '' : heading).trim() || DEFAULT_SETTINGS.taskHeading;
  const lines = String(content).split('\n');
  if (lines.some((line) => line.trim() === task)) return content;

  const headingRe = new RegExp(`^${escapeRegExp(normalizedHeading)}\\s*$`, 'i');
  const headingIndex = lines.findIndex((line) => headingRe.test(line.trim()));

  if (headingIndex === -1) {
    const base = String(content).replace(/\s+$/, '');
    return `${base ? `${base}\n\n` : ''}${normalizedHeading}\n\n${task}\n`;
  }

  const nextHeadingRe = new RegExp(`^#{1,${headingLevel(normalizedHeading)}}\\s+`);

  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (nextHeadingRe.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const hasContent = lines
    .slice(headingIndex + 1, sectionEnd)
    .some((line) => line.trim() !== '');

  if (!hasContent) {
    lines.splice(headingIndex + 1, sectionEnd - headingIndex - 1, '', task);
    return lines.join('\n');
  }

  if (lines[headingIndex + 1].trim() !== '') {
    lines.splice(headingIndex + 1, 0, '');
    sectionEnd += 1;
  }

  let insertAt = sectionEnd - 1;
  while (insertAt > headingIndex && lines[insertAt].trim() === '') insertAt--;
  lines.splice(insertAt + 1, 0, task);
  return lines.join('\n');
}

function removeTaskLine(content, originalLine) {
  const lines = content.split('\n');
  const index = lines.findIndex(
    (line) => line === originalLine || line.trim() === originalLine.trim()
  );
  if (index === -1) return null;
  lines.splice(index, 1);
  return lines.join('\n');
}

function replaceTaskLine(content, originalLine, replacementLine) {
  const lines = content.split('\n');
  const index = lines.findIndex(
    (line) => line === originalLine || line.trim() === originalLine.trim()
  );
  if (index === -1) return null;
  lines[index] = replacementLine;
  return lines.join('\n');
}

function isDailySource(path, settings = DEFAULT_SETTINGS) {
  const folder = normalizeFolder(settings.dailyFolder);
  const prefix = `${folder}/`;
  if (!path.startsWith(prefix) || !path.endsWith('.md')) return false;
  const rest = path.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/');
}

function isNotebookSource(path, settings = DEFAULT_SETTINGS) {
  const notebook = cleanPath(settings.notebookPath, true);
  return Boolean(notebook) && path === notebook;
}

function isSource(path, settings = DEFAULT_SETTINGS) {
  return isDailySource(path, settings) || isNotebookSource(path, settings);
}

function dailyPath(dateString, settings = DEFAULT_SETTINGS) {
  const folder = normalizeFolder(settings.dailyFolder);
  const format = normalizeDateFormat(settings.dailyDateFormat);
  const name =
    format === 'YYYY-MM-DD'
      ? dateString
      : moment(dateString, 'YYYY-MM-DD', true).format(format);
  return `${folder}/${name}.md`;
}

function getCoreDailyNotesOptions(app) {
  try {
    const internal = app.internalPlugins;
    if (!internal) return null;
    const plugin = internal.getEnabledPluginById
      ? internal.getEnabledPluginById('daily-notes')
      : internal.plugins &&
          internal.plugins['daily-notes'] &&
          internal.plugins['daily-notes'].enabled
        ? internal.plugins['daily-notes']
        : null;
    if (!plugin) return null;
    const instance = plugin.instance || (plugin.plugin && plugin.plugin.instance);
    const options = (instance && instance.options) || plugin.options;
    if (!options) return null;
    return {
      folder: options.folder,
      format: options.format,
      template: options.template,
    };
  } catch (error) {
    return null;
  }
}

class DailyTaskMover extends Plugin {
  async onload() {
    await this.loadSettings();
    this.timers = new Map();
    this.processing = new Set();
    this.lastWritten = new Map();

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!this.settings.autoMoveOnEdit) return;
        if (file instanceof TFile && isSource(file.path, this.settings)) {
          this.schedule(file, new Date());
        }
      })
    );

    this.addCommand({
      id: 'move-dated-tasks',
      name: 'Перенести задачи с датами',
      callback: () => {
        this.scanAll().catch((error) => console.error('[daily-task-mover]', error));
      },
    });

    this.addSettingTab(new DailyTaskMoverSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.scanOnStartup) return;
      const delay = Math.max(0, Number(this.settings.startupDelayMs) || 0);
      window.setTimeout(() => {
        this.scanAll().catch((error) => console.error('[daily-task-mover]', error));
      }, delay);
    });
  }

  onunload() {
    this.clearTimers();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.clearTimers();
    if (this.lastWritten) this.lastWritten.clear();
  }

  clearTimers() {
    if (!this.timers) return;
    for (const { timer } of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }

  schedule(file, now) {
    const previous = this.timers.get(file.path);
    if (previous) window.clearTimeout(previous.timer);
    const delay = Math.max(0, Number(this.settings.debounceMs) || 0);
    const timer = window.setTimeout(() => {
      this.timers.delete(file.path);
      this.processFile(file, now, Object.assign({}, this.settings)).catch((error) =>
        console.error('[daily-task-mover]', error)
      );
    }, delay);
    this.timers.set(file.path, { timer, now });
  }

  async scanAll() {
    const settings = Object.assign({}, this.settings);
    const files = this.app.vault.getMarkdownFiles().filter((file) => isSource(file.path, settings));
    for (const file of files) {
      await this.processFile(file, new Date(), settings);
    }
  }

  async processFile(file, now, settings = Object.assign({}, this.settings)) {
    if (this.processing.has(file.path)) return;
    this.processing.add(file.path);

    try {
      const content = await this.app.vault.read(file);
      if (this.lastWritten.get(file.path) === content) return;

      const moves = new Map();
      const inPlace = [];

      for (const line of content.split('\n')) {
        const task = parseTaskLine(line, now, settings);
        if (!task) continue;
        const target = dailyPath(task.date, settings);
        if (target === file.path) {
          inPlace.push(task);
        } else {
          if (!moves.has(target)) moves.set(target, []);
          moves.get(target).push(task);
        }
      }

      if (moves.size === 0 && inPlace.length === 0) return;

      for (const [targetPath, tasks] of moves) {
        await this.appendToTarget(targetPath, tasks, settings);
      }

      await this.app.vault.process(file, (current) => {
        let result = current;
        for (const tasks of moves.values()) {
          for (const task of tasks) {
            const updated = removeTaskLine(result, task.line);
            if (updated !== null) result = updated;
          }
        }
        for (const task of inPlace) {
          const updated = replaceTaskLine(result, task.line, `- [ ] ${task.text}`);
          if (updated !== null) result = updated;
        }
        return result;
      });

      this.lastWritten.set(file.path, await this.app.vault.read(file));
    } finally {
      this.processing.delete(file.path);
    }
  }

  async appendToTarget(targetPath, tasks, settings = Object.assign({}, this.settings)) {
    const heading = String(settings.taskHeading || '').trim() || DEFAULT_SETTINGS.taskHeading;
    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (content) => {
        let result = content;
        for (const task of tasks) {
          result = insertTask(result, `- [ ] ${task.text}`, heading);
        }
        return result;
      });
      return;
    }

    let content = '';
    const templatePath = cleanPath(settings.templatePath, true);
    const template = templatePath ? this.app.vault.getAbstractFileByPath(templatePath) : null;
    if (template instanceof TFile) {
      content = this.renderTemplate(await this.app.vault.read(template), tasks[0].date);
    }
    if (!content.trim()) content = `${heading}\n`;
    for (const task of tasks) {
      content = insertTask(content, `- [ ] ${task.text}`, heading);
    }
    if (!content.endsWith('\n')) content += '\n';

    const folder = targetPath.split('/').slice(0, -1).join('/');
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    try {
      await this.app.vault.create(targetPath, content);
    } catch (error) {
      const created = this.app.vault.getAbstractFileByPath(targetPath);
      if (created instanceof TFile) {
        await this.app.vault.process(created, (current) => {
          let result = current;
          for (const task of tasks) {
            result = insertTask(result, `- [ ] ${task.text}`, heading);
          }
          return result;
        });
      } else {
        throw error;
      }
    }
  }

  renderTemplate(content, dateString) {
    const date = moment(dateString, 'YYYY-MM-DD', true);
    return content
      .replace(/\{\{title\}\}/gi, dateString)
      .replace(/\{\{date(?::([^}]+))?\}/gi, (_, format) =>
        date.format(format || 'YYYY-MM-DD')
      )
      .replace(/\{\{time(?::([^}]+))?\}/gi, (_, format) =>
        moment().format(format || 'HH:mm')
      );
  }
}

class DailyTaskMoverSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Daily Task Mover' });

    this.displayPaths(containerEl);
    this.displayBehavior(containerEl);
    this.displayFormats(containerEl);
    this.displayActions(containerEl);
  }

  displayPaths(containerEl) {
    containerEl.createEl('h3', { text: 'Пути' });

    new Setting(containerEl)
      .setName('Папка ежедневных заметок')
      .setDesc('Папка, из которой и в которую переносятся задачи.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.dailyFolder)
          .setValue(this.plugin.settings.dailyFolder)
          .onChange(async (value) => {
            this.plugin.settings.dailyFolder = normalizeFolder(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Формат имени ежедневной заметки')
      .setDesc('Формат moment.js, например YYYY-MM-DD. Без слэшей и вложенных папок.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.dailyDateFormat)
          .setValue(this.plugin.settings.dailyDateFormat)
          .onChange(async (value) => {
            this.plugin.settings.dailyDateFormat = normalizeDateFormat(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Заметка-блокнот')
      .setDesc('Путь к заметке-источнику. Оставьте пустым, чтобы отключить.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.notebookPath)
          .setValue(this.plugin.settings.notebookPath)
          .onChange(async (value) => {
            this.plugin.settings.notebookPath = cleanPath(value, true);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Шаблон новой заметки')
      .setDesc('Путь к шаблону. Пусто — создать заметку только с разделом задач.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.templatePath)
          .setValue(this.plugin.settings.templatePath)
          .onChange(async (value) => {
            this.plugin.settings.templatePath = cleanPath(value, true);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Заголовок раздела задач')
      .setDesc('Например, ## Задачи на сегодня. Поддерживается любой уровень заголовка.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.taskHeading)
          .setValue(this.plugin.settings.taskHeading)
          .onChange(async (value) => {
            const heading = String(value == null ? '' : value).trim();
            if (!heading) {
              new Notice('Заголовок не может быть пустым');
              this.plugin.settings.taskHeading = DEFAULT_SETTINGS.taskHeading;
            } else {
              this.plugin.settings.taskHeading = heading;
            }
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Взять пути из Daily notes')
      .setDesc('Скопировать папку, формат и шаблон из core-плагина Daily notes.')
      .addButton((button) =>
        button.setButtonText('Взять из Daily notes').onClick(async () => {
          const options = getCoreDailyNotesOptions(this.app);
          if (!options) {
            new Notice('Core-плагин Daily notes не включён или настройки недоступны');
            return;
          }

          if (options.folder) {
            this.plugin.settings.dailyFolder = normalizeFolder(options.folder);
          } else {
            this.plugin.settings.dailyFolder = DEFAULT_SETTINGS.dailyFolder;
            new Notice('В Daily notes выбрана корневая папка; используется daily');
          }

          const rawFormat = String(options.format == null ? '' : options.format).trim();
          const format = normalizeDateFormat(rawFormat);
          if (rawFormat && format !== rawFormat) {
            new Notice('Формат с папками не поддерживается; используется YYYY-MM-DD');
          }
          this.plugin.settings.dailyDateFormat = format;

          const template = cleanPath(options.template, true);
          this.plugin.settings.templatePath = template
            ? template.endsWith('.md')
              ? template
              : `${template}.md`
            : '';

          await this.plugin.saveSettings();
          this.display();
          new Notice('Пути взяты из Daily notes');
        })
      );

    new Setting(containerEl)
      .setName('Проверить пути')
      .setDesc('Показать, какие папки и файлы не найдены.')
      .addButton((button) =>
        button.setButtonText('Проверить').onClick(() => this.checkPaths())
      );
  }

  displayBehavior(containerEl) {
    containerEl.createEl('h3', { text: 'Поведение' });

    this.addToggle(
      containerEl,
      'Переносить при изменении заметки',
      'Автоматически переносить задачи после сохранения заметки.',
      'autoMoveOnEdit'
    );

    new Setting(containerEl)
      .setName('Сканировать при запуске')
      .setDesc('Применяется при следующем запуске. Для немедленного запуска используйте кнопку ниже.')
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings.scanOnStartup)).onChange(async (value) => {
          this.plugin.settings.scanOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    this.addNumber(
      containerEl,
      'Задержка после изменения (мс)',
      'Сколько ждать после сохранения заметки перед переносом.',
      'debounceMs',
      0,
      60000,
      DEFAULT_SETTINGS.debounceMs
    );

    this.addNumber(
      containerEl,
      'Задержка стартового скана (мс)',
      'Задержка перед сканированием после запуска Obsidian.',
      'startupDelayMs',
      0,
      60000,
      DEFAULT_SETTINGS.startupDelayMs
    );
  }

  displayFormats(containerEl) {
    containerEl.createEl('h3', { text: 'Распознавание дат' });

    this.addToggle(
      containerEl,
      'Убирать дату из текста задачи',
      'Если выключено, дата останется в тексте перенесённой задачи.',
      'stripDate'
    );

    this.addToggle(
      containerEl,
      'ISO-даты',
      'Например, «купить хлеб 2026-10-25».',
      'parseIsoDate'
    );

    this.addToggle(
      containerEl,
      'Даты DD.MM.YYYY',
      'Например, «купить хлеб 25.10.2026».',
      'parseDottedDate'
    );

    this.addToggle(
      containerEl,
      'Завтра и послезавтра',
      'Например, «купить хлеб завтра».',
      'parseRelativeDate'
    );

    this.addToggle(
      containerEl,
      'Дни недели',
      'Например, «купить хлеб в понедельник».',
      'parseWeekday'
    );
  }

  displayActions(containerEl) {
    containerEl.createEl('h3', { text: 'Действия' });

    new Setting(containerEl)
      .setName('Перенести задачи сейчас')
      .setDesc('Запустить сканирование источников вручную.')
      .addButton((button) =>
        button
          .setButtonText('Перенести')
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.scanAll();
              new Notice('Сканирование завершено');
            } catch (error) {
              console.error('[daily-task-mover]', error);
              new Notice(`Ошибка: ${error && error.message ? error.message : error}`);
            }
          })
      );

    new Setting(containerEl)
      .setName('Сбросить настройки')
      .setDesc('Вернуть значения по умолчанию.')
      .addButton((button) =>
        button
          .setButtonText('Сбросить')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
            await this.plugin.saveSettings();
            this.display();
            new Notice('Настройки сброшены');
          })
      );
  }

  addToggle(containerEl, name, description, key) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings[key])).onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.saveSettings();
        })
      );
  }

  addNumber(containerEl, name, description, key, min, max, fallback) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = String(min);
        text.inputEl.max = String(max);
        text.inputEl.step = '100';
        text.setValue(String(this.plugin.settings[key]));
        text.onChange(async (value) => {
          if (String(value).trim() === '') return;
          this.plugin.settings[key] = clampNumber(value, min, max, fallback);
          await this.plugin.saveSettings();
        });
      });
  }

  checkPaths() {
    const { vault } = this.app;
    const missing = [];

    const folderPath = normalizeFolder(this.plugin.settings.dailyFolder);
    const folder = vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      missing.push(`папка «${folderPath}»`);
    } else if (!(folder instanceof TFolder)) {
      missing.push(`«${folderPath}» не является папкой`);
    }

    const notebookPath = cleanPath(this.plugin.settings.notebookPath, true);
    if (notebookPath) {
      const notebook = vault.getAbstractFileByPath(notebookPath);
      if (!notebook) {
        missing.push(`заметка «${notebookPath}»`);
      } else if (!(notebook instanceof TFile)) {
        missing.push(`«${notebookPath}» не является файлом`);
      }
    }

    const templatePath = cleanPath(this.plugin.settings.templatePath, true);
    if (templatePath) {
      const template = vault.getAbstractFileByPath(templatePath);
      if (!template) {
        missing.push(`шаблон «${templatePath}»`);
      } else if (!(template instanceof TFile)) {
        missing.push(`«${templatePath}» не является файлом`);
      }
    }

    if (missing.length === 0) {
      new Notice('Все пути найдены');
    } else {
      new Notice(`Не найдено: ${missing.join('; ')}`, 10000);
    }
  }
}

module.exports = DailyTaskMover;
module.exports._test = {
  DEFAULT_SETTINGS,
  parseTaskLine,
  extractDateSuffix,
  insertTask,
  removeTaskLine,
  replaceTaskLine,
  isSource,
  isDailySource,
  isNotebookSource,
  dailyPath,
  formatDate,
  addDays,
  normalizeFolder,
  normalizeDateFormat,
  clampNumber,
  headingLevel,
};
