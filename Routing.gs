/**
 * Routing.gs — specialist assignment.
 *
 * Path A: a specialist reacts to a Slack claim (or dispute) message with their
 *         emoji. Slack's Events API sends `reaction_added` to this script's Web
 *         App URL (doPost), which writes the specialist into "Assigned To".
 * Path B: a specialist picks their name in "Assigned To" in the sheet
 *         (Triggers.gs). Both paths stamp "Date Acknowledged" once.
 */

function assignableTabs_() { return [TABS.CLAIMS, TABS.DISPUTES]; }

/** Slack Events API endpoint. Deploy as Web App: execute as Me, access Anyone. */
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return text_('bad request'); }

  // One-time check when the Web App URL is pasted into Slack.
  if (body.type === 'url_verification') return text_(body.challenge);

  // Apps Script cannot read request headers, so Slack's signing-secret check is
  // not possible. The verification token in the body is checked instead.
  const expected = prop_('SLACK_VERIFICATION_TOKEN');
  if (expected && body.token !== expected) return text_('ignored');

  // Slack retries slow responses; skip events already handled.
  const cache = CacheService.getScriptCache();
  if (body.event_id) {
    if (cache.get(body.event_id)) return text_('duplicate');
    cache.put(body.event_id, '1', 600);
  }

  const ev = body.event || {};
  if (body.type === 'event_callback' && ev.type === 'reaction_added' && ev.item && ev.item.type === 'message') {
    try {
      handleReaction_(ev.item.channel, ev.item.ts, ev.reaction);
    } catch (err) {
      console.error('Reaction handling failed: ' + err.stack);
    }
  }
  return text_('ok');
}

function text_(s) {
  return ContentService.createTextOutput(String(s)).setMimeType(ContentService.MimeType.TEXT);
}

/** Matches the emoji to a specialist and the message ts to a claim or dispute row. */
function handleReaction_(channel, ts, emoji) {
  if (channel !== claimsChannel_()) return;
  const specialist = specialistsByEmoji_()[emoji];
  if (!specialist) return;

  const tabs = assignableTabs_();
  for (let i = 0; i < tabs.length; i++) {
    const sh = sheet_(tabs[i]);
    const row = findRow_(sh, headerMap_(sh), 'Slack TS', ts);
    if (row > 0) {
      assignSpecialist_(tabs[i], row, specialist.name);
      return;
    }
  }
}

/** Writes the specialist; Date Acknowledged is stamped only the first time. */
function assignSpecialist_(tabName, row, name) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(tabName);
    const map = headerMap_(sh);
    const r = readRow_(sh, map, row);
    const updates = { 'Assigned To': name };
    if (!r['Date Acknowledged']) updates['Date Acknowledged'] = now_();
    if (tabName === TABS.CLAIMS && r['Claim Status'] === STATUS.NEW) updates['Claim Status'] = STATUS.REVIEW;
    writeCells_(sh, map, row, updates);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menu action for demos without Slack: asks for a Claim ID and an emoji and
 * runs the same code path a real Slack reaction would.
 */
function simulateReaction() {
  const ui = SpreadsheetApp.getUi();
  const idResp = ui.prompt('Simulate emoji reaction', 'Claim ID (e.g. CLM-00001):', ui.ButtonSet.OK_CANCEL);
  if (idResp.getSelectedButton() !== ui.Button.OK) return;
  const emojiResp = ui.prompt('Simulate emoji reaction',
    'Specialist emoji, without colons (one of: ' + Object.keys(specialistsByEmoji_()).join(', ') + '):',
    ui.ButtonSet.OK_CANCEL);
  if (emojiResp.getSelectedButton() !== ui.Button.OK) return;

  const claimId = idResp.getResponseText().trim().toUpperCase();
  const emoji = emojiResp.getResponseText().trim().replace(/^:|:$/g, '');
  if (!specialistsByEmoji_()[emoji]) { ui.alert('"' + emoji + '" is not an active specialist emoji.'); return; }

  // An open dispute takes precedence over the original claim message.
  const disputes = sheet_(TABS.DISPUTES);
  const dMap = headerMap_(disputes);
  const dRow = findRow_(disputes, dMap, 'Claim ID', claimId);
  let ts = '';
  if (dRow > 0 && !readRow_(disputes, dMap, dRow)['Dispute Outcome']) {
    ts = readRow_(disputes, dMap, dRow)['Slack TS'];
  } else {
    const claims = sheet_(TABS.CLAIMS);
    const cMap = headerMap_(claims);
    const cRow = findRow_(claims, cMap, 'Claim ID', claimId);
    if (cRow > 0) ts = readRow_(claims, cMap, cRow)['Slack TS'];
  }
  if (!ts) { ui.alert('No Slack message found for ' + claimId + '. Seeded demo claims have none; assign them in the sheet.'); return; }

  handleReaction_(claimsChannel_(), String(ts), emoji);
  toast_('Simulated :' + emoji + ': on ' + claimId + '.');
}
