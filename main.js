'use strict';

const { Plugin, TFile, moment } = require('obsidian');

const DAILY_FOLDER = 'daily';
const NOTEBOOK_PATH = 'общее/всё остальное/Блокнот.md';
const TEMPLATE_PATH = 'templates/ежедневная заметка.md';
const TASK_HEADING = '## Задачи на сегодня';
const DEBOUNCE_MS = 1500;

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

function extractDateSuffix(text, now) {
  const patterns = [
    {
      re: /(?:^|[\s,;])(?:(?:до|к|на|в|во)\s+)?(\d{4})-(\d{2})-(\d{2})\s*[.,!;]?\s*$/i,
      build: (match) => makeDate(Number(match[1]), Number(match[2]), Number(match[3])),
    },
    {
      re: /(?:^|[\s,;])(?:(?:до|к|на|в|во)\s+)?(\d{1,2})\.(\d{1,2})\.(\d{4})\s*[.,!;]?\s*$/i,
      build: (match) => makeDate(Number(match[3]), Number(match[2]), Number(match[1])),
    },
    {
      re: /(?:^|[\s,;])(?:(?:до|к|на|в|во)\s+)?(послезавтра|завтра)\s*[.,!;]?\s*$/i,
      build: (match) => addDays(now, match[1].toLowerCase() === 'завтра' ? 1 : 2),
    },
    {
      re: /(?:^|[\s,;])(?:(?:в|во|на)\s+)?(понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресень[ея])\s*[.,!;]?\s*$/i,
      build: (match) => {
        const targetDay = weekdayFromWord(match[1]);
        if (targetDay === null) return null;
        const today = startOfDay(now);
        const delta = (targetDay - today.getDay() + 7) % 7;
        return addDays(today, delta);
      },
    },
  ];

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
    return { date: formatDate(date), text: cleaned };
  }

  return null;
}

function parseTaskLine(line, now) {
  const match = line.match(/^(\s*)[-*]\s+\[ \]\s+(.+?)\s*$/);
  if (!match) return null;
  const parsed = extractDateSuffix(match[2], now);
  if (!parsed) return null;
  return { date: parsed.date, text: parsed.text, line };
}

function insertTask(content, taskLine) {
  const task = taskLine.trim();
  const lines = content.split('\n');
  if (lines.some((line) => line.trim() === task)) return content;

  const headingRe = /^##\s+Задачи на сегодня\s*$/i;
  const headingIndex = lines.findIndex((line) => headingRe.test(line.trim()));

  if (headingIndex === -1) {
    const base = content.replace(/\s+$/, '');
    return `${base ? `${base}\n\n` : ''}${TASK_HEADING}\n\n${task}\n`;
  }

  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) {
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

function isDailySource(path) {
  return /^daily\/[^/]+\.md$/i.test(path);
}

function isSource(path) {
  return isDailySource(path) || path === NOTEBOOK_PATH;
}

function dailyPath(dateString) {
  return `${DAILY_FOLDER}/${dateString}.md`;
}

class DailyTaskMover extends Plugin {
  async onload() {
    this.timers = new Map();
    this.processing = new Set();
    this.lastWritten = new Map();

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && isSource(file.path)) {
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

    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => {
        this.scanAll().catch((error) => console.error('[daily-task-mover]', error));
      }, 3000);
    });
  }

  onunload() {
    for (const { timer } of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }

  schedule(file, now) {
    const previous = this.timers.get(file.path);
    if (previous) window.clearTimeout(previous.timer);
    const timer = window.setTimeout(() => {
      this.timers.delete(file.path);
      this.processFile(file, now).catch((error) => console.error('[daily-task-mover]', error));
    }, DEBOUNCE_MS);
    this.timers.set(file.path, { timer, now });
  }

  async scanAll() {
    const files = this.app.vault.getMarkdownFiles().filter((file) => isSource(file.path));
    for (const file of files) {
      await this.processFile(file, new Date());
    }
  }

  async processFile(file, now) {
    if (this.processing.has(file.path)) return;
    this.processing.add(file.path);

    try {
      const content = await this.app.vault.read(file);
      if (this.lastWritten.get(file.path) === content) return;

      const moves = new Map();
      const inPlace = [];

      for (const line of content.split('\n')) {
        const task = parseTaskLine(line, now);
        if (!task) continue;
        const target = dailyPath(task.date);
        if (target === file.path) {
          inPlace.push(task);
        } else {
          if (!moves.has(target)) moves.set(target, []);
          moves.get(target).push(task);
        }
      }

      if (moves.size === 0 && inPlace.length === 0) return;

      for (const [targetPath, tasks] of moves) {
        await this.appendToTarget(targetPath, tasks);
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

  async appendToTarget(targetPath, tasks) {
    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (content) => {
        let result = content;
        for (const task of tasks) {
          result = insertTask(result, `- [ ] ${task.text}`);
        }
        return result;
      });
      return;
    }

    let content = '';
    const template = this.app.vault.getAbstractFileByPath(TEMPLATE_PATH);
    if (template instanceof TFile) {
      content = this.renderTemplate(await this.app.vault.read(template), tasks[0].date);
    }
    if (!content.trim()) content = `${TASK_HEADING}\n`;
    for (const task of tasks) {
      content = insertTask(content, `- [ ] ${task.text}`);
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
            result = insertTask(result, `- [ ] ${task.text}`);
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
      .replace(/\{\{date(?::([^}]+))?\}\}/gi, (_, format) =>
        date.format(format || 'YYYY-MM-DD')
      )
      .replace(/\{\{time(?::([^}]+))?\}\}/gi, (_, format) =>
        moment().format(format || 'HH:mm')
      );
  }
}

module.exports = DailyTaskMover;
module.exports._test = {
  parseTaskLine,
  extractDateSuffix,
  insertTask,
  removeTaskLine,
  replaceTaskLine,
  isSource,
  dailyPath,
  formatDate,
  addDays,
};
