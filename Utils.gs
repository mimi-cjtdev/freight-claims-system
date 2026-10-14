/**
 * Utils.gs — sheet access, header-based column lookup, dates, money, small helpers.
 *
 * TABS (tab names) and CHECKBOX_COLUMNS come from the private Config.gs (see Rules.gs).
 */

/** Reads a Script Property (secrets and Slack IDs live there, never in code). */
function prop_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v === null || v === '') return fallback === undefined ? '' : fallback;
  return v;
}

/** The bound spreadsheet. Falls back to SPREADSHEET_ID for web-app and trigger contexts. */
function ss_() {
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) { ss = null; }
  if (ss) return ss;
  const id = prop_('SPREADSHEET_ID');
  if (!id) throw new Error('The SPREADSHEET_ID Script Property is not set.');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '".');
  return sh;
}

/** Map of header name -> 1-based column index, read from row 1. */
function headerMap_(sh) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach(function (h, i) { if (h !== '') map[String(h).trim()] = i + 1; });
  return map;
}

function col_(map, header) {
  const c = map[header];
  if (!c) throw new Error('Column "' + header + '" not found. Check the header row.');
  return c;
}

function width_(map) {
  return Math.max.apply(null, Object.keys(map).map(function (k) { return map[k]; }));
}

/** Reads one row as an object keyed by header name. */
function readRow_(sh, map, row) {
  const values = sh.getRange(row, 1, 1, width_(map)).getValues()[0];
  const obj = { _row: row };
  Object.keys(map).forEach(function (k) { obj[k] = values[map[k] - 1]; });
  return obj;
}

/** Writes several { header: value } pairs into one row. */
function writeCells_(sh, map, row, values) {
  Object.keys(values).forEach(function (header) {
    sh.getRange(row, col_(map, header)).setValue(values[header]);
  });
}

/** Builds a full row array in header order from a { header: value } object. */
function rowFromObject_(map, obj) {
  const arr = new Array(width_(map)).fill('');
  Object.keys(obj).forEach(function (k) { if (map[k]) arr[map[k] - 1] = obj[k]; });
  return arr;
}

/** Adds checkboxes to a row's checkbox columns, then sets their values from `values`. */
function addCheckboxes_(tab, sh, map, row, values) {
  (CHECKBOX_COLUMNS[tab] || []).forEach(function (h) {
    const cell = sh.getRange(row, col_(map, h));
    cell.insertCheckboxes();                 // resets the cell to FALSE
    if (values && values[h] === true) cell.setValue(true);
  });
}

/** First data row (>= 2) where `header` equals `value` (string compare), or -1. */
function findRow_(sh, map, header, value) {
  const last = sh.getLastRow();
  const target = String(value).trim();
  if (last < 2 || !target) return -1;
  const vals = sh.getRange(2, col_(map, header), last - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === target) return i + 2;
  }
  return -1;
}

// ---- Dates ---------------------------------------------------------------------

function now_() { return new Date(); }

function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }

function toDate_(v) {
  if (isDate_(v)) return v;
  if (v === '' || v === null || v === undefined) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function startOfDay_(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

function addDays_(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/** Adds calendar months, clamping to month end (Jan 31 + 1 month = Feb 28/29). */
function addMonths_(d, n) {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  const lastDay = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(day, lastDay));
  return x;
}

/** Whole calendar days from a to b (negative if b is before a). */
function daysBetween_(a, b) {
  return Math.round((startOfDay_(b) - startOfDay_(a)) / 86400000);
}

function fmt_(d) { return d ? Utilities.formatDate(new Date(d), TZ, DATETIME_FORMAT) : ''; }
function fmtDay_(d) { return d ? Utilities.formatDate(new Date(d), TZ, DAY_FORMAT) : ''; }

function plural_(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

// ---- Money ---------------------------------------------------------------------

function parseAmount_(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? NaN : n;
}

function money_(n) {
  n = Number(n) || 0;
  const parts = Math.abs(n).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + '$' + parts.join('.');
}

function pct_(part, whole) {
  return whole > 0 ? Math.round(part / whole * 100) + '%' : '—';
}

// ---- Misc ----------------------------------------------------------------------

function isChecked_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

function isEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }

function normalize_(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function tabUrl_(tabName) {
  const ss = ss_();
  return ss.getUrl() + '#gid=' + ss.getSheetByName(tabName).getSheetId();
}

// "Notification Status" holds a " | "-separated list of events already posted
// to Slack (e.g. "claim_posted | decision:Declined"), so posts are never repeated.
function hasTag_(cellValue, tag) { return String(cellValue || '').split(' | ').indexOf(tag) !== -1; }

function addTag_(cellValue, tag) {
  const tags = String(cellValue || '').split(' | ').filter(String);
  if (tags.indexOf(tag) === -1) tags.push(tag);
  return tags.join(' | ');
}

function toast_(msg) {
  try { ss_().toast(msg, COMPANY + ' Claims', 8); } catch (err) { /* no UI in this context */ }
}

// ---- Specialists and carriers ----------------------------------------------------

/** Active specialists keyed by emoji name (without colons). */
function specialistsByEmoji_() {
  const sh = sheet_(TABS.SPECIALISTS);
  const last = sh.getLastRow();
  const out = {};
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 4).getValues().forEach(function (r) {
    const name = String(r[0]).trim();
    const emoji = String(r[1]).trim().replace(/^:|:$/g, '');
    if (name && emoji && isChecked_(r[3])) out[emoji] = { name: name, slackId: String(r[2]).trim() };
  });
  return out;
}

/** "<@U123>" when the specialist has a Slack member ID, otherwise the plain name. */
function mentionOrName_(name) {
  if (!name) return '_Unassigned_';
  const byEmoji = specialistsByEmoji_();
  for (const k in byEmoji) {
    if (normalize_(byEmoji[k].name) === normalize_(name) && byEmoji[k].slackId) return '<@' + byEmoji[k].slackId + '>';
  }
  return name;
}

function activeCarriers_() {
  const sh = sheet_(TABS.CARRIERS);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 4).getValues()
    .filter(function (r) { return String(r[0]).trim() && isChecked_(r[3]); })
    .map(function (r) { return String(r[0]).trim(); });
}

/** Priority from exception type and claimed amount (the triage rule). */
function priority_(type, amount) {
  if (amount >= RULES.AUTO_ESCALATE_AMOUNT) return 'Critical';
  if (amount >= RULES.HIGH_PRIORITY_AMOUNT || type === 'Loss') return 'High';
  if (amount >= RULES.MEDIUM_PRIORITY_AMOUNT) return 'Medium';
  return 'Low';
}
