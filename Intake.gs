/**
 * Intake.gs — exception report (Google Form) -> triage -> Claims row -> Slack.
 *
 * The form writes raw answers to its own "Form Responses 1" tab, kept as an
 * untouched audit copy. This trigger copies them into the Claims tab in the
 * system's own column order, then applies the triage rules:
 *   - Priority from exception type and claimed amount
 *   - Filing deadline = delivery date + 9 months
 *   - Claims at or above the auto-escalation amount go straight to the Manager
 */

/**
 * Installable "On form submit" trigger. FORM_FIELDS (the form's question titles)
 * comes from the private Config.gs; the form itself is built by the private Setup.gs.
 */
function onFormSubmitHandler(e) {
  const a = formAnswers_(e);
  const get = function (title) { return a[title] === undefined || a[title] === null ? '' : a[title]; };

  const amount = parseAmount_(get(FORM_FIELDS.AMOUNT));
  const delivery = toDate_(get(FORM_FIELDS.DELIVERY));
  const load = String(get(FORM_FIELDS.LOAD)).trim();
  if (!load || !(amount >= 0) || !delivery) {
    console.warn('Form submission skipped: missing load number, amount or delivery date. ' + JSON.stringify(a));
    return;
  }

  createClaim_({
    'Reporter Name': String(get(FORM_FIELDS.REPORTER_NAME)).trim(),
    'Reporter Email': String(get(FORM_FIELDS.REPORTER_EMAIL)).trim().toLowerCase(),
    'Reporter Role': get(FORM_FIELDS.REPORTER_ROLE),
    'Load Number': load.toUpperCase(),
    'PRO Number': String(get(FORM_FIELDS.PRO)).trim().toUpperCase(),
    'Shipper': String(get(FORM_FIELDS.SHIPPER)).trim(),
    'Consignee': String(get(FORM_FIELDS.CONSIGNEE)).trim(),
    'Carrier': get(FORM_FIELDS.CARRIER),
    'Origin': String(get(FORM_FIELDS.ORIGIN)).trim(),
    'Destination': String(get(FORM_FIELDS.DESTINATION)).trim(),
    'Delivery Date': delivery,
    'Exception Type': get(FORM_FIELDS.EXCEPTION) || 'Other',
    'Description': String(get(FORM_FIELDS.DESCRIPTION)).trim(),
    'Claimed Amount': amount,
    'Evidence Link': String(get(FORM_FIELDS.EVIDENCE)).trim(),
  });
}

/**
 * Reads the submitted row from the form's response tab by header, so dates and
 * numbers arrive as real Date/number values regardless of spreadsheet locale.
 * Falls back to e.namedValues.
 */
function formAnswers_(e) {
  const out = {};
  if (e && e.range) {
    const sh = e.range.getSheet();
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const values = sh.getRange(e.range.getRow(), 1, 1, headers.length).getValues()[0];
    headers.forEach(function (h, i) { out[String(h).trim()] = values[i]; });
    return out;
  }
  const nv = (e && e.namedValues) || {};
  Object.keys(nv).forEach(function (k) { out[k] = nv[k][0]; });
  return out;
}

/**
 * Creates a claim row, assigns the next Claim ID, posts to #claims and
 * auto-escalates large claims. Returns the new Claim ID.
 */
function createClaim_(fields) {
  const amount = Number(fields['Claimed Amount']) || 0;
  const type = fields['Exception Type'];
  const autoEscalate = amount >= RULES.AUTO_ESCALATE_AMOUNT;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let claimId, row;
  try {
    const sh = sheet_(TABS.CLAIMS);
    const map = headerMap_(sh);
    claimId = nextClaimId_(sh, map);
    const record = Object.assign({
      'Claim ID': claimId,
      'Submitted At': now_(),
      'Priority': priority_(type, amount),
      'Filing Deadline': addMonths_(fields['Delivery Date'], RULES.FILING_WINDOW_MONTHS),
      'Claim Status': STATUS.NEW,
    }, fields);
    sh.appendRow(rowFromObject_(map, record));
    row = sh.getLastRow();
    addCheckboxes_(TABS.CLAIMS, sh, map, row, {});
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  notifyNewClaim_(row, autoEscalate);

  if (autoEscalate) {
    const sh = sheet_(TABS.CLAIMS);
    const map = headerMap_(sh);
    sh.getRange(row, col_(map, 'Escalate?')).setValue(true);
    handleEscalation_(row, 'Auto: claimed amount is ' + money_(amount) + ' (limit ' + money_(RULES.AUTO_ESCALATE_AMOUNT) + ')');
  }
  return claimId;
}

/** Scans existing IDs and returns the next one, e.g. CLM-00042. */
function nextClaimId_(sh, map) {
  const last = sh.getLastRow();
  let max = 0;
  if (last >= 2) {
    sh.getRange(2, col_(map, 'Claim ID'), last - 1, 1).getValues().forEach(function (r) {
      const m = String(r[0]).match(/^CLM-(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
  }
  return 'CLM-' + String(max + 1).padStart(5, '0');
}

/** Posts the new-claim message once and stores its Slack timestamp. */
function notifyNewClaim_(row, autoEscalated) {
  const sh = sheet_(TABS.CLAIMS);
  const map = headerMap_(sh);
  const c = readRow_(sh, map, row);
  if (hasTag_(c['Notification Status'], 'claim_posted')) return;

  const res = slackPost_({
    channel: claimsChannel_(),
    text: '📦 New claim ' + c['Claim ID'] + ': ' + c['Exception Type'] + ', ' + money_(c['Claimed Amount']) + ' · ' + c['Carrier'],
    blocks: newClaimBlocks_(c, autoEscalated),
    event: 'new_claim',
  });

  if (res.ok) {
    writeCells_(sh, map, row, {
      'Slack TS': "'" + res.ts,
      'Notification Status': addTag_(c['Notification Status'], 'claim_posted'),
    });
  } else {
    writeCells_(sh, map, row, { 'Notification Status': 'Slack error: ' + res.error });
  }
}

/** Menu action: re-posts any claim whose new-claim message never went out. */
function retryFailedNotifications() {
  const sh = sheet_(TABS.CLAIMS);
  const map = headerMap_(sh);
  let count = 0;
  for (let r = 2; r <= sh.getLastRow(); r++) {
    const c = readRow_(sh, map, r);
    if (String(c['Notification Status']).indexOf('Slack error') === 0) {
      writeCells_(sh, map, r, { 'Notification Status': '' });
      notifyNewClaim_(r, false);
      count++;
    }
  }
  toast_('Retried ' + plural_(count, 'notification') + '.');
}
