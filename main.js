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

function normalizeTaskText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function taskKey(task) {
  return `${task.date}\u0000${normalizeTaskText(task.text)}`;
}

function randomIdPart() {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createTaskId(usedIds) {
  for (let i = 0; i < 50; i++) {
    const id = `dtm-${randomIdPart()}`;
    if (!usedIds || !usedIds.has(id)) return id;
  }
  return `dtm-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function extractTaskId(line) {
  const match = String(line).match(/\s+\^(dtm-[A-Za-z0-9_-]+)\s*$/);
  if (!match) return { line, id: null };
  return {
    line: String(line).slice(0, match.index).replace(/\s+$/, ''),
    id: match[1],
  };
}

function extractCompletion(line) {
  const match = String(line).match(/\s+(✅\s+\d{4}-\d{2}-\d{2})\s*$/u);
  if (!match) return { line, completion: '' };
  return {
    line: String(line).slice(0, match.index).trimEnd(),
    completion: match[1],
  };
}

function extractCanonicalDate(text) {
  const match = String(text).match(/^(.*?)\s+-\s+(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = makeDate(Number(match[2]), Number(match[3]), Number(match[4]));
  if (!date) return null;
  const cleaned = match[1].trimEnd();
  if (!cleaned) return null;
  return { date: formatDate(date), text: cleaned };
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
    let cleaned = text
      .slice(0, match.index)
      .replace(/[\s,;]+$/, '')
      .trimEnd();
    cleaned = cleaned.replace(/\s+-\s*$/, '').trimEnd();
    if (!cleaned) return null;
    return {
      date: formatDate(date),
      text: cleaned,
    };
  }

  return null;
}

function parseTaskLine(line, now, options = {}) {
  let working = String(line);
  let completion = '';
  let id = null;

  for (let i = 0; i < 2; i++) {
    const withoutCompletion = extractCompletion(working);
    if (withoutCompletion.completion) {
      completion = withoutCompletion.completion;
      working = withoutCompletion.line;
    }
    const withoutId = extractTaskId(working);
    if (withoutId.id) {
      id = withoutId.id;
      working = withoutId.line;
    }
  }

  const match = working.match(/^(\s*)([-*])\s+\[([ xX])\]\s+(.+?)\s*$/);
  if (!match) return null;

  const body = match[4];
  const parsed = extractCanonicalDate(body) || extractDateSuffix(body, now, options);
  if (!parsed) return null;

  return {
    id,
    checked: match[3].toLowerCase() === 'x',
    text: parsed.text.trim(),
    date: parsed.date,
    indent: match[1],
    bullet: match[2],
    completion,
    line,
  };
}

function formatTaskLine(task, idOverride) {
  const id = idOverride || task.id;
  const completion = task.completion ? ` ${task.completion}` : '';
  const line = `${task.indent || ''}${task.bullet || '-'} [${
    task.checked ? 'x' : ' '
  }] ${task.text} - ${task.date}${completion}`;
  return id ? `${line} ^${id}` : line;
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

function lineHasTaskId(line, id) {
  return new RegExp(`(?:^|\\s)\\^${escapeRegExp(id)}\\s*$`).test(line);
}

function findTaskLineIndex(lines, operation, now, settings) {
  if (operation.id) {
    const byId = lines.findIndex((line) => lineHasTaskId(line, operation.id));
    if (byId !== -1) return byId;
  }

  if (operation.oldLine) {
    const oldLine = String(operation.oldLine);
    const trimmed = oldLine.trim();
    const byLine = lines.findIndex(
      (line) => line === oldLine || (trimmed && line.trim() === trimmed)
    );
    if (byLine !== -1) return byLine;
  }

  if (operation.key) {
    for (let i = 0; i < lines.length; i++) {
      const task = parseTaskLine(lines[i], now, settings);
      if (task && taskKey(task) === operation.key) return i;
    }
  }

  return -1;
}

function applyOperations(content, operations, heading, now, settings) {
  let result = content;
  for (const operation of operations) {
    if (operation.type === 'remove') {
      const lines = result.split('\n');
      const index = findTaskLineIndex(lines, operation, now, settings);
      if (index === -1) continue;
      lines.splice(index, 1);
      result = lines.join('\n');
      continue;
    }

    if (operation.type !== 'upsert') continue;
    const lines = result.split('\n');
    const index = findTaskLineIndex(lines, operation, now, settings);
    if (index !== -1) {
      lines[index] = operation.line;
      result = lines.join('\n');
      continue;
    }
    if (operation.insertIfMissing) {
      result = insertTask(result, operation.line, heading);
    }
  }
  return result;
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

function dateFromDailyPath(path, settings = DEFAULT_SETTINGS) {
  const folder = normalizeFolder(settings.dailyFolder);
  const prefix = `${folder}/`;
  if (!String(path).startsWith(prefix) || !String(path).endsWith('.md')) return null;
  const name = String(path).slice(prefix.length, -3);
  if (!name || name.includes('/')) return null;

  const format = normalizeDateFormat(settings.dailyDateFormat);
  if (format === 'YYYY-MM-DD') {
    const match = name.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = makeDate(Number(match[1]), Number(match[2]), Number(match[3]));
    return date ? formatDate(date) : null;
  }

  const parsed = moment(name, format, true);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.format('YYYY-MM-DD');
}

function parseTasks(content, path, now, settings) {
  const tasks = [];
  const lines = String(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const task = parseTaskLine(lines[i], now, settings);
    if (!task) continue;
    task.path = path;
    task.lineIndex = i;
    tasks.push(task);
  }
  return tasks;
}

function addOperation(operations, path, operation) {
  if (!operations.has(path)) operations.set(path, []);
  operations.get(path).push(operation);
}

function findTaskInEntry(entry, id, key) {
  if (!entry) return null;
  if (id) {
    const byId = entry.tasks.find((task) => task.id === id);
    if (byId) return byId;
  }
  if (key) {
    return entry.tasks.find((task) => taskKey(task) === key) || null;
  }
  return null;
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
    this.lastWritten = new Map();
    this.queue = Promise.resolve();

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!this.settings.autoMoveOnEdit) return;
        if (file instanceof TFile && isSource(file.path, this.settings)) {
          this.schedule(file);
        }
      })
    );

    this.addCommand({
      id: 'move-dated-tasks',
      name: 'Синхронизировать задачи с датами',
      callback: () => {
        this.scanAll().catch((error) => console.error('[daily-task-mover]', error));
      },
    });

    this.addSettingTab(new DailyTaskMoverSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.scanOnStartup) return;
      const delay = Math.max(0, Number(this.settings.startupDelayMs) || 0);
      this.startupTimer = window.setTimeout(() => {
        this.startupTimer = null;
        this.scanAll().catch((error) => console.error('[daily-task-mover]', error));
      }, delay);
    });
  }

  onunload() {
    this.clearTimers();
    if (this.startupTimer) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.syncState =
      data.syncState && typeof data.syncState === 'object' ? data.syncState : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    delete this.settings.syncState;
    delete this.settings.stripDate;
  }

  async saveSettings() {
    await this.saveData(Object.assign({}, this.settings, { syncState: this.syncState }));
    this.clearTimers();
    if (this.lastWritten) this.lastWritten.clear();
  }

  async saveSyncState() {
    await this.saveData(Object.assign({}, this.settings, { syncState: this.syncState }));
  }

  clearTimers() {
    if (!this.timers) return;
    for (const { timer } of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }

  enqueue(callback) {
    const run = this.queue.then(
      () => callback(),
      () => callback()
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  schedule(file) {
    const previous = this.timers.get(file.path);
    if (previous) window.clearTimeout(previous.timer);
    const delay = Math.max(0, Number(this.settings.debounceMs) || 0);
    const path = file.path;
    const timer = window.setTimeout(() => {
      this.timers.delete(path);
      this.enqueue(() =>
        this.processSource(path, new Date(), Object.assign({}, this.settings))
      ).catch((error) => console.error('[daily-task-mover]', error));
    }, delay);
    this.timers.set(path, { timer });
  }

  async scanAll() {
    if (this.startupTimer) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    const settings = Object.assign({}, this.settings);
    await this.enqueue(() => this.reconcileAll(new Date(), settings));
  }

  async processSource(path, now, settings) {
    if (isNotebookSource(path, settings)) {
      await this.syncNotebook(now, settings);
      return;
    }
    if (isDailySource(path, settings)) {
      await this.syncDaily(path, now, settings);
    }
  }

  async readEntry(file, path, kind, now, settings) {
    const content = await this.app.vault.read(file);
    return {
      path,
      kind,
      file,
      content,
      mtime: Number(file.stat && file.stat.mtime) || 0,
      tasks: parseTasks(content, path, now, settings),
    };
  }

  async readPath(path, now, settings, cache) {
    if (cache && cache.has(path)) return cache.get(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      if (cache) cache.set(path, null);
      return null;
    }
    const entry = await this.readEntry(file, path, 'daily', now, settings);
    if (cache) cache.set(path, entry);
    return entry;
  }

  prepareEntries(entries, now, settings) {
    const usedIds = new Set();
    for (const entry of entries) {
      for (const task of entry.tasks) {
        if (task.id) usedIds.add(task.id);
      }
    }

    const notebookEntry = entries.find((entry) => entry.kind === 'notebook') || null;
    const notebookTasks = notebookEntry ? notebookEntry.tasks : [];
    const seenNotebookIds = new Set();
    for (const task of notebookTasks) {
      if (!task.id || seenNotebookIds.has(task.id)) {
        task.id = createTaskId(usedIds);
      }
      seenNotebookIds.add(task.id);
      usedIds.add(task.id);
    }

    const notebookById = new Map();
    const notebookByKey = new Map();
    for (const task of notebookTasks) {
      notebookById.set(task.id, task);
      const key = taskKey(task);
      if (!notebookByKey.has(key)) notebookByKey.set(key, []);
      notebookByKey.get(key).push(task);
    }

    const dailyEntries = entries.filter((entry) => entry.kind === 'daily');
    const pairedNotebookIds = new Set();
    for (const entry of dailyEntries) {
      for (const task of entry.tasks) {
        if (task.id && notebookById.has(task.id)) {
          pairedNotebookIds.add(task.id);
        }
      }
    }

    for (const entry of dailyEntries) {
      const seenIds = new Set();
      for (const task of entry.tasks) {
        if (!task.id) {
          const candidates = notebookByKey.get(taskKey(task)) || [];
          const candidate = candidates.find((item) => !pairedNotebookIds.has(item.id));
          if (candidate) {
            task.id = candidate.id;
            pairedNotebookIds.add(candidate.id);
          } else {
            task.id = createTaskId(usedIds);
          }
        } else if (seenIds.has(task.id)) {
          task.id = createTaskId(usedIds);
        }
        seenIds.add(task.id);
        usedIds.add(task.id);
      }
    }

    const operations = new Map();
    for (const entry of entries) {
      for (const task of entry.tasks) {
        const line = formatTaskLine(task);
        if (line !== task.line) {
          addOperation(operations, entry.path, {
            type: 'upsert',
            id: task.id,
            oldLine: task.line,
            line,
            insertIfMissing: false,
          });
          task.line = line;
        }
      }
    }

    const byId = new Map();
    for (const task of notebookTasks) {
      if (!byId.has(task.id)) byId.set(task.id, { notebook: null, daily: [] });
      byId.get(task.id).notebook = task;
    }
    for (const entry of dailyEntries) {
      for (const task of entry.tasks) {
        if (!byId.has(task.id)) byId.set(task.id, { notebook: null, daily: [] });
        byId.get(task.id).daily.push(task);
      }
    }

    return { entries, notebookEntry, notebookTasks, byId, operations };
  }

  resolveConflict(notebookTask, dailyTask, notebookLine, dailyLine, entries, state) {
    if (state && Object.prototype.hasOwnProperty.call(state, 'dailyLine')) {
      const notebookChanged = state.notebookLine !== notebookLine;
      const dailyChanged = state.dailyLine !== dailyLine;
      if (notebookChanged !== dailyChanged) {
        return notebookChanged ? 'notebook' : 'daily';
      }
      if (!notebookChanged && !dailyChanged) return 'notebook';
    }

    const notebookEntry = entries.get(notebookTask.path);
    const dailyEntry = entries.get(dailyTask.path);
    const notebookMtime = notebookEntry ? notebookEntry.mtime : 0;
    const dailyMtime = dailyEntry ? dailyEntry.mtime : 0;
    return dailyMtime > notebookMtime ? 'daily' : 'notebook';
  }

  async reconcileAll(now, settings) {
    const entries = [];
    const notebookPath = cleanPath(settings.notebookPath, true);
    if (notebookPath) {
      const notebookFile = this.app.vault.getAbstractFileByPath(notebookPath);
      if (notebookFile instanceof TFile) {
        entries.push(
          await this.readEntry(notebookFile, notebookPath, 'notebook', now, settings)
        );
      }
    }

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!isDailySource(file.path, settings)) continue;
      entries.push(await this.readEntry(file, file.path, 'daily', now, settings));
    }

    const prepared = this.prepareEntries(entries, now, settings);
    const operations = prepared.operations;
    const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
    const notebookPathForWrite = prepared.notebookEntry
      ? prepared.notebookEntry.path
      : null;
    const states = {};

    for (const notebookTask of prepared.notebookTasks) {
      const group = prepared.byId.get(notebookTask.id);
      const candidates = group ? group.daily : [];
      const targetPath = dailyPath(notebookTask.date, settings);
      const dailyTask =
        candidates.find((task) => task.path === targetPath) || candidates[0] || null;
      const notebookLine = formatTaskLine(notebookTask);

      if (!dailyTask) {
        if (!notebookTask.checked) {
          addOperation(operations, targetPath, {
            type: 'upsert',
            id: notebookTask.id,
            line: notebookLine,
            insertIfMissing: true,
          });
          states[notebookTask.id] = {
            notebookLine,
            dailyLine: notebookLine,
            dailyPath: targetPath,
          };
        } else {
          states[notebookTask.id] = {
            notebookLine,
            dailyLine: null,
            dailyPath: targetPath,
          };
        }
        continue;
      }

      const dailyLine = formatTaskLine(dailyTask);
      let winner = null;
      if (notebookLine !== dailyLine) {
        winner = this.resolveConflict(
          notebookTask,
          dailyTask,
          notebookLine,
          dailyLine,
          entryByPath,
          this.syncState[notebookTask.id]
        );
      }

      const winnerTask = winner === 'daily' ? dailyTask : notebookTask;
      const desiredLine = winner === 'daily' ? dailyLine : notebookLine;
      const desiredPath = dailyPath(winnerTask.date, settings);

      if (dailyTask.path !== desiredPath) {
        addOperation(operations, dailyTask.path, {
          type: 'remove',
          id: dailyTask.id,
          oldLine: dailyTask.line,
        });
        addOperation(operations, desiredPath, {
          type: 'upsert',
          id: dailyTask.id,
          line: desiredLine,
          insertIfMissing: true,
        });
      } else if (dailyLine !== desiredLine) {
        addOperation(operations, dailyTask.path, {
          type: 'upsert',
          id: dailyTask.id,
          oldLine: dailyTask.line,
          line: desiredLine,
          insertIfMissing: false,
        });
      }

      if (notebookPathForWrite && desiredLine !== notebookLine) {
        addOperation(operations, notebookPathForWrite, {
          type: 'upsert',
          id: notebookTask.id,
          oldLine: notebookTask.line,
          line: desiredLine,
          insertIfMissing: false,
        });
      }

      states[notebookTask.id] = {
        notebookLine: desiredLine,
        dailyLine: desiredLine,
        dailyPath: desiredPath,
      };
    }

    for (const group of prepared.byId.values()) {
      if (group.notebook) continue;
      for (const dailyTask of group.daily) {
        const targetPath = dailyPath(dailyTask.date, settings);
        if (dailyTask.path === targetPath) continue;
        addOperation(operations, dailyTask.path, {
          type: 'remove',
          id: dailyTask.id,
          oldLine: dailyTask.line,
        });
        addOperation(operations, targetPath, {
          type: 'upsert',
          id: dailyTask.id,
          line: formatTaskLine(dailyTask),
          insertIfMissing: true,
        });
      }
    }

    await this.applyOperationsMap(operations, settings, now);
    this.syncState = states;
    await this.saveSyncState();
  }

  async syncNotebook(now, settings) {
    const notebookPath = cleanPath(settings.notebookPath, true);
    if (!notebookPath) return;
    const notebookFile = this.app.vault.getAbstractFileByPath(notebookPath);
    if (!(notebookFile instanceof TFile)) return;

    const content = await this.app.vault.read(notebookFile);
    if (this.lastWritten.get(notebookPath) === content) return;

    const notebookEntry = await this.readEntry(
      notebookFile,
      notebookPath,
      'notebook',
      now,
      settings
    );
    const prepared = this.prepareEntries([notebookEntry], now, settings);
    const operations = prepared.operations;
    const cache = new Map([[notebookPath, notebookEntry]]);
    const notebookIds = new Set(notebookEntry.tasks.map((task) => task.id));
    const nextState = Object.assign({}, this.syncState);

    for (const notebookTask of notebookEntry.tasks) {
      const state = nextState[notebookTask.id];
      const targetPath = dailyPath(notebookTask.date, settings);
      const oldPath = state && state.dailyPath ? state.dailyPath : null;
      let dailyEntry = null;
      let dailyTask = null;

      if (oldPath) {
        dailyEntry = await this.readPath(oldPath, now, settings, cache);
        dailyTask = findTaskInEntry(dailyEntry, notebookTask.id, taskKey(notebookTask));
      }

      if (!dailyTask && targetPath !== oldPath) {
        const targetEntry = await this.readPath(targetPath, now, settings, cache);
        const targetTask = findTaskInEntry(
          targetEntry,
          notebookTask.id,
          taskKey(notebookTask)
        );
        if (targetTask) {
          dailyEntry = targetEntry;
          dailyTask = targetTask;
        }
      }

      if (!dailyTask && !oldPath) {
        const targetEntry = await this.readPath(targetPath, now, settings, cache);
        dailyTask = findTaskInEntry(targetEntry, notebookTask.id, taskKey(notebookTask));
        if (dailyTask) dailyEntry = targetEntry;
      }

      const notebookLine = formatTaskLine(notebookTask);

      if (dailyTask) {
        if (!dailyTask.id) dailyTask.id = notebookTask.id;
        const sourcePath = dailyEntry.path;
        if (sourcePath !== targetPath) {
          addOperation(operations, sourcePath, {
            type: 'remove',
            id: notebookTask.id,
            oldLine: dailyTask.line,
          });
          addOperation(operations, targetPath, {
            type: 'upsert',
            id: notebookTask.id,
            line: notebookLine,
            insertIfMissing: true,
          });
        } else {
          addOperation(operations, sourcePath, {
            type: 'upsert',
            id: notebookTask.id,
            oldLine: dailyTask.line,
            line: notebookLine,
            insertIfMissing: false,
          });
        }

        if (oldPath && oldPath !== sourcePath && oldPath !== targetPath) {
          addOperation(operations, oldPath, {
            type: 'remove',
            id: notebookTask.id,
          });
        }

        nextState[notebookTask.id] = {
          notebookLine,
          dailyLine: notebookLine,
          dailyPath: targetPath,
        };
      } else if (!notebookTask.checked) {
        addOperation(operations, targetPath, {
          type: 'upsert',
          id: notebookTask.id,
          line: notebookLine,
          insertIfMissing: true,
        });
        nextState[notebookTask.id] = {
          notebookLine,
          dailyLine: notebookLine,
          dailyPath: targetPath,
        };
      } else {
        nextState[notebookTask.id] = {
          notebookLine,
          dailyLine: null,
          dailyPath: targetPath,
        };
      }
    }

    for (const id of Object.keys(nextState)) {
      if (!notebookIds.has(id)) delete nextState[id];
    }

    await this.applyOperationsMap(operations, settings, now);
    this.syncState = nextState;
    await this.saveSyncState();
  }

  async syncDaily(path, now, settings) {
    const dailyFile = this.app.vault.getAbstractFileByPath(path);
    if (!(dailyFile instanceof TFile)) return;
    const content = await this.app.vault.read(dailyFile);
    if (this.lastWritten.get(path) === content) return;

    const dailyEntry = await this.readEntry(dailyFile, path, 'daily', now, settings);
    const entries = [dailyEntry];
    const notebookPath = cleanPath(settings.notebookPath, true);
    let notebookEntry = null;
    if (notebookPath) {
      const notebookFile = this.app.vault.getAbstractFileByPath(notebookPath);
      if (notebookFile instanceof TFile) {
        notebookEntry = await this.readEntry(
          notebookFile,
          notebookPath,
          'notebook',
          now,
          settings
        );
        entries.unshift(notebookEntry);
      }
    }

    const prepared = this.prepareEntries(entries, now, settings);
    const operations = prepared.operations;
    const notebookTasks = notebookEntry ? notebookEntry.tasks : [];
    const notebookById = new Map(notebookTasks.map((task) => [task.id, task]));
    const notebookIds = new Set(notebookTasks.map((task) => task.id));
    const dailyTasks = dailyEntry.tasks;
    const processedIds = new Set();
    const nextState = Object.assign({}, this.syncState);

    for (const dailyTask of dailyTasks) {
      processedIds.add(dailyTask.id);
      const notebookTask = notebookById.get(dailyTask.id);
      const desiredLine = formatTaskLine(dailyTask);
      const targetPath = dailyPath(dailyTask.date, settings);
      const state = nextState[dailyTask.id];

      if (!notebookTask) {
        if (state) delete nextState[dailyTask.id];
        if (targetPath !== path) {
          addOperation(operations, path, {
            type: 'remove',
            id: dailyTask.id,
            oldLine: dailyTask.line,
          });
          addOperation(operations, targetPath, {
            type: 'upsert',
            id: dailyTask.id,
            line: desiredLine,
            insertIfMissing: true,
          });
        }
        continue;
      }

      addOperation(operations, notebookTask.path, {
        type: 'upsert',
        id: notebookTask.id,
        oldLine: notebookTask.line,
        line: desiredLine,
        insertIfMissing: false,
      });

      if (targetPath !== path) {
        addOperation(operations, path, {
          type: 'remove',
          id: dailyTask.id,
          oldLine: dailyTask.line,
        });
        addOperation(operations, targetPath, {
          type: 'upsert',
          id: dailyTask.id,
          line: desiredLine,
          insertIfMissing: true,
        });
      } else {
        addOperation(operations, path, {
          type: 'upsert',
          id: dailyTask.id,
          oldLine: dailyTask.line,
          line: desiredLine,
          insertIfMissing: false,
        });
      }

      if (state && state.dailyPath && state.dailyPath !== path && state.dailyPath !== targetPath) {
        addOperation(operations, state.dailyPath, {
          type: 'remove',
          id: dailyTask.id,
        });
      }

      nextState[dailyTask.id] = {
        notebookLine: desiredLine,
        dailyLine: desiredLine,
        dailyPath: targetPath,
      };
    }

    const dailyDate = dateFromDailyPath(path, settings);
    if (dailyDate && notebookEntry) {
      for (const notebookTask of notebookTasks) {
        if (notebookTask.checked || processedIds.has(notebookTask.id)) continue;
        if (dailyPath(notebookTask.date, settings) !== path) continue;
        const notebookLine = formatTaskLine(notebookTask);
        addOperation(operations, path, {
          type: 'upsert',
          id: notebookTask.id,
          line: notebookLine,
          insertIfMissing: true,
        });
        nextState[notebookTask.id] = {
          notebookLine,
          dailyLine: notebookLine,
          dailyPath: path,
        };
      }
    }

    for (const id of Object.keys(nextState)) {
      if (!notebookIds.has(id)) delete nextState[id];
    }

    await this.applyOperationsMap(operations, settings, now);
    this.syncState = nextState;
    await this.saveSyncState();
  }

  async applyOperationsMap(operations, settings, now) {
    for (const [path, fileOperations] of operations) {
      if (!fileOperations.length) continue;
      await this.applyOperationsToPath(path, fileOperations, settings, now);
    }
  }

  async applyOperationsToPath(path, operations, settings, now) {
    const heading =
      String(settings.taskHeading || '').trim() || DEFAULT_SETTINGS.taskHeading;
    const existing = this.app.vault.getAbstractFileByPath(path);

    if (existing instanceof TFile) {
      let nextContent = null;
      await this.app.vault.process(existing, (current) => {
        nextContent = applyOperations(current, operations, heading, now, settings);
        return nextContent;
      });
      if (typeof nextContent === 'string') this.lastWritten.set(path, nextContent);
      return;
    }

    const hasInsert = operations.some(
      (operation) => operation.type === 'upsert' && operation.insertIfMissing
    );
    if (!hasInsert) return;

    let content = '';
    const templatePath = cleanPath(settings.templatePath, true);
    const template = templatePath
      ? this.app.vault.getAbstractFileByPath(templatePath)
      : null;
    const dateForTemplate = dateFromDailyPath(path, settings) || formatDate(now);
    if (template instanceof TFile) {
      content = this.renderTemplate(
        await this.app.vault.read(template),
        dateForTemplate
      );
    }
    if (!content.trim()) content = `${heading}\n`;
    content = applyOperations(content, operations, heading, now, settings);
    if (!content.endsWith('\n')) content += '\n';

    const folder = path.split('/').slice(0, -1).join('/');
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    try {
      await this.app.vault.create(path, content);
      this.lastWritten.set(path, content);
    } catch (error) {
      const created = this.app.vault.getAbstractFileByPath(path);
      if (!(created instanceof TFile)) throw error;
      let nextContent = null;
      await this.app.vault.process(created, (current) => {
        nextContent = applyOperations(current, operations, heading, now, settings);
        return nextContent;
      });
      if (typeof nextContent === 'string') this.lastWritten.set(path, nextContent);
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
      .setDesc('Папка, из которой и в которую синхронизируются задачи.')
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
      .setDesc('Путь к заметке-источнику. Задачи из неё не удаляются.')
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
      'Синхронизировать при изменении заметки',
      'Автоматически обновлять связанные задачи после сохранения заметки.',
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
      'Сколько ждать после сохранения заметки перед синхронизацией.',
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
    containerEl.createEl('p', {
      text:
        'Каноническая запись: - [ ] текст - 2026-10-25 ^dtm-xxxxxxxx. ' +
        'Относительные даты нормализуются в YYYY-MM-DD.',
    });

    this.addToggle(
      containerEl,
      'ISO-даты',
      'Дополнительно распознавать старые задачи с датой вида 2026-10-25.',
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
      .setName('Синхронизировать задачи сейчас')
      .setDesc('Запустить полную синхронизацию блокнота и ежедневных заметок.')
      .addButton((button) =>
        button
          .setButtonText('Синхронизировать')
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.scanAll();
              new Notice('Синхронизация завершена');
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
            this.plugin.syncState = {};
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
  extractCanonicalDate,
  formatTaskLine,
  taskKey,
  createTaskId,
  applyOperations,
  findTaskInEntry,
  dateFromDailyPath,
  parseTasks,
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
