/**
 * Workflows.gs — carrier filing, carrier acknowledgment, escalation, decision
 * and dispute.
 *
 * Every handler is idempotent: it checks what has already happened (a date
 * stamp, a row in a destination tab, a Notification Status tag) before acting,
 * so re-running it by an edit or by "Process pending actions" is safe.
 *
 * The handlers are called by an installable onEdit trigger (private Triggers.gs)
 * that maps each edited column to its handler, e.g.
 *   Filed with Carrier?  -> handleFiled_       Decision / Amount Recovered -> handleDecision_
 *   Escalate?            -> handleEscalation_  Dispute Filed?              -> handleDisputeFiled_
 *   Manager Decision     -> handleManagerDecision_ (Escalations tab)
 *   Dispute Outcome      -> handleDisputeOutcome_  (Disputes tab)
 */

function claimRow_(row) {
  const sh = sheet_(TABS.CLAIMS);
  const map = headerMap_(sh);
  return { sh: sh, map: map, c: readRow_(sh, map, row) };
}

function threadTs_(v) { return v ? String(v) : ''; }

/** Status a claim returns to after an escalation is reviewed. */
function workingStatus_(c) {
  if (c['Date Filed with Carrier']) return STATUS.FILED;
  return c['Assigned To'] ? STATUS.REVIEW : STATUS.NEW;
}

// ---- Filing with the carrier -------------------------------------------------------

/** Filed with Carrier? ticked -> check documents, stamp dates and carrier deadlines. */
function handleFiled_(row) {
  const { sh, map, c } = claimRow_(row);
  if (!c['Claim ID'] || !isChecked_(c['Filed with Carrier?']) || c['Date Filed with Carrier']) return;

  const required = REQUIRED_DOCS[c['Exception Type']] || REQUIRED_DOCS['Other'];
  const missing = required.filter(function (d) { return !isChecked_(c[d + ' Received?']); });
  if (missing.length) {
    sh.getRange(row, col_(map, 'Filed with Carrier?')).setValue(false);
    toast_(c['Claim ID'] + ': can\'t file yet. Missing ' + missing.join(', ') + ' (required for ' + c['Exception Type'] + ').');
    return;
  }

  const filed = now_();
  const late = c['Filing Deadline'] && daysBetween_(c['Filing Deadline'], filed) > 0;
  const ackDue = addDays_(filed, RULES.CARRIER_ACK_DAYS);
  const responseDue = addDays_(filed, RULES.CARRIER_RESPONSE_DAYS);
  const updates = {
    'Date Filed with Carrier': filed,
    'Carrier Ack Due': ackDue,
    'Carrier Response Due': responseDue,
  };
  if (c['Claim Status'] !== STATUS.ESCALATED) updates['Claim Status'] = STATUS.FILED;
  writeCells_(sh, map, row, updates);

  slackPost_({
    channel: claimsChannel_(),
    text: '📨 *' + c['Claim ID'] + ' filed with ' + c['Carrier'] + '*' +
      (c['Carrier Claim Number'] ? ' · carrier claim # ' + c['Carrier Claim Number'] : '') +
      '\nAcknowledgment due ' + fmtDay_(ackDue) + ' · response due ' + fmtDay_(responseDue) +
      (late ? '\n⚠️ Filed after the ' + fmtDay_(c['Filing Deadline']) + ' deadline; the carrier may decline it as late.' : ''),
    threadTs: threadTs_(c['Slack TS']),
    event: 'filed_with_carrier',
  });
}

/** Carrier Acknowledged? ticked -> stamp the date (only after filing). */
function handleCarrierAck_(row) {
  const { sh, map, c } = claimRow_(row);
  if (!c['Claim ID'] || !isChecked_(c['Carrier Acknowledged?']) || c['Carrier Ack Date']) return;
  if (!c['Date Filed with Carrier']) {
    sh.getRange(row, col_(map, 'Carrier Acknowledged?')).setValue(false);
    toast_(c['Claim ID'] + ': file the claim with the carrier first.');
    return;
  }
  const ack = now_();
  writeCells_(sh, map, row, { 'Carrier Ack Date': ack });
  slackPost_({
    channel: claimsChannel_(),
    text: '📬 ' + c['Carrier'] + ' acknowledged ' + c['Claim ID'] + ' after ' +
      plural_(daysBetween_(c['Date Filed with Carrier'], ack), 'day') + '.',
    threadTs: threadTs_(c['Slack TS']),
    event: 'carrier_ack',
  });
}

// ---- Escalation ---------------------------------------------------------------------

/** Escalate? ticked (by a specialist or by intake) -> copy to Escalations, alert the Manager. */
function handleEscalation_(row, reason) {
  const { sh, map, c } = claimRow_(row);
  if (!c['Claim ID'] || !isChecked_(c['Escalate?'])) return;

  const esc = sheet_(TABS.ESCALATIONS);
  const escMap = headerMap_(esc);
  if (findRow_(esc, escMap, 'Claim ID', c['Claim ID']) > 0) return;   // already escalated

  reason = reason || ('Flagged by ' + (c['Assigned To'] || 'a specialist'));
  const when = now_();
  writeCells_(sh, map, row, { 'Date Escalated': when, 'Claim Status': STATUS.ESCALATED });

  esc.appendRow(rowFromObject_(escMap, {
    'Claim ID': c['Claim ID'],
    'Date Escalated': when,
    'Escalation Reason': reason,
    'Carrier': c['Carrier'],
    'Shipper': c['Shipper'],
    'Exception Type': c['Exception Type'],
    'Claimed Amount': c['Claimed Amount'],
    'Priority': c['Priority'],
    'Assigned To': c['Assigned To'],
    'Manager Decision': 'Pending',
  }));
  const escRow = esc.getLastRow();

  const res = slackPost_({
    channel: escalationChannel_(),
    text: '🚨 Escalation ' + c['Claim ID'] + ' (' + money_(c['Claimed Amount']) + ') needs Claims Manager review',
    blocks: escalationBlocks_(c, reason),
    event: 'escalation',
  });
  if (res.ok) writeCells_(esc, escMap, escRow, { 'Slack TS': "'" + res.ts });
}

/** Escalations: Manager Decision changed from Pending -> stamp, hand back, reply in thread. */
function handleManagerDecision_(row) {
  const esc = sheet_(TABS.ESCALATIONS);
  const map = headerMap_(esc);
  const r = readRow_(esc, map, row);
  const decision = String(r['Manager Decision'] || '').trim();
  if (!r['Claim ID'] || !decision || decision === 'Pending' || r['Date Reviewed']) return;

  writeCells_(esc, map, row, { 'Date Reviewed': now_() });

  const claims = sheet_(TABS.CLAIMS);
  const cMap = headerMap_(claims);
  const cRow = findRow_(claims, cMap, 'Claim ID', r['Claim ID']);
  let assignee = r['Assigned To'];
  if (cRow > 0) {
    const c = readRow_(claims, cMap, cRow);
    assignee = c['Assigned To'] || assignee;
    if (c['Claim Status'] === STATUS.ESCALATED) writeCells_(claims, cMap, cRow, { 'Claim Status': workingStatus_(c) });
  }

  slackPost_({
    channel: escalationChannel_(),
    text: '🧭 Manager review for ' + r['Claim ID'] + ': *' + decision + '*' +
      (r['Manager Notes'] ? '\n>' + truncate_(r['Manager Notes'], 500) : '') +
      '\n' + (assignee ? mentionOrName_(assignee) + ', the claim is back with you.' : 'The claim is back in the queue.'),
    threadTs: threadTs_(r['Slack TS']),
    event: 'manager_decision',
  });
}

// ---- Decision -----------------------------------------------------------------------

/**
 * Decision (or Amount Recovered) edited -> validate the amount, stamp, close,
 * post in the claim thread.
 *   Paid in Full       -> Amount Recovered defaults to the claimed amount
 *   Partial Settlement -> Amount Recovered must be entered (between $0 and claimed)
 *   Declined           -> Amount Recovered = 0
 */
function handleDecision_(row) {
  const { sh, map, c } = claimRow_(row);
  const decision = String(c['Decision'] || '').trim();
  if (!c['Claim ID'] || DECISIONS.indexOf(decision) === -1) return;

  const tag = 'decision:' + decision;
  if (hasTag_(c['Notification Status'], tag)) return;   // already announced

  if (!c['Date Filed with Carrier']) {
    sh.getRange(row, col_(map, 'Decision')).setValue('');
    toast_(c['Claim ID'] + ': file the claim with the carrier before recording the carrier\'s decision.');
    return;
  }

  const claimed = Number(c['Claimed Amount']) || 0;
  let recovered;
  if (decision === 'Declined') {
    recovered = 0;
  } else if (decision === 'Paid in Full') {
    recovered = c['Amount Recovered'] === '' ? claimed : parseAmount_(c['Amount Recovered']);
  } else {
    recovered = parseAmount_(c['Amount Recovered']);
    if (!(recovered > 0 && recovered < claimed)) {
      toast_(c['Claim ID'] + ': enter the settlement in Amount Recovered (more than $0, less than ' + money_(claimed) + ').');
      return;   // runs again when Amount Recovered is edited
    }
  }

  const decided = now_();
  const updates = {
    'Amount Recovered': recovered,
    'Date Decided': decided,
    'Days to Resolve': daysBetween_(c['Submitted At'], decided),
    'Final Recovered': recovered,
    'Deadline Flag': '',
  };
  if (c['Claim Status'] !== STATUS.DISPUTE) updates['Claim Status'] = STATUS.CLOSED;
  writeCells_(sh, map, row, updates);
  Object.assign(c, updates);

  const res = slackPost_({
    channel: claimsChannel_(),
    text: DECISION_EMOJI[decision] + ' ' + c['Claim ID'] + ': ' + decision + ', ' + money_(recovered) + ' recovered',
    blocks: decisionBlocks_(c),
    threadTs: threadTs_(c['Slack TS']),
    broadcast: true,
    event: 'decision',
  });
  if (res.ok) writeCells_(sh, map, row, { 'Notification Status': addTag_(c['Notification Status'], tag) });
}

// ---- Dispute ------------------------------------------------------------------------

/** Dispute Filed? ticked -> only for Partial Settlement / Declined; one dispute per claim. */
function handleDisputeFiled_(row) {
  const { sh, map, c } = claimRow_(row);
  if (!c['Claim ID'] || !isChecked_(c['Dispute Filed?'])) return;

  if (DISPUTABLE_DECISIONS.indexOf(c['Decision']) === -1 || !c['Date Decided']) {
    sh.getRange(row, col_(map, 'Dispute Filed?')).setValue(false);
    toast_(c['Claim ID'] + ': only a recorded Partial Settlement or Declined decision can be disputed.');
    return;
  }

  const dis = sheet_(TABS.DISPUTES);
  const dMap = headerMap_(dis);
  if (findRow_(dis, dMap, 'Claim ID', c['Claim ID']) > 0) return;

  const record = {
    'Claim ID': c['Claim ID'],
    'Date Filed': now_(),
    'Carrier': c['Carrier'],
    'Shipper': c['Shipper'],
    'Original Decision': c['Decision'],
    'Claimed Amount': c['Claimed Amount'],
    'Original Recovered': Number(c['Amount Recovered']) || 0,
  };
  dis.appendRow(rowFromObject_(dMap, record));
  const dRow = dis.getLastRow();
  writeCells_(sh, map, row, { 'Claim Status': STATUS.DISPUTE });

  const res = slackPost_({
    channel: claimsChannel_(),
    text: '⚖️ Dispute filed for ' + c['Claim ID'] + ' (' + c['Decision'] + ')',
    blocks: disputeBlocks_(record),
    event: 'dispute_filed',
  });
  if (res.ok) writeCells_(dis, dMap, dRow, { 'Slack TS': "'" + res.ts });
}

/**
 * Disputes: Dispute Outcome set -> stamp, sync totals to Claims, reply in thread.
 *   Reversed -> Additional Recovered defaults to the unpaid balance
 *   Upheld   -> Additional Recovered = 0
 */
function handleDisputeOutcome_(row) {
  const dis = sheet_(TABS.DISPUTES);
  const map = headerMap_(dis);
  const d = readRow_(dis, map, row);
  const outcome = String(d['Dispute Outcome'] || '').trim();
  if (!d['Claim ID'] || DISPUTE_OUTCOMES.indexOf(outcome) === -1 || d['Date Resolved']) return;

  const claimed = Number(d['Claimed Amount']) || 0;
  const original = Number(d['Original Recovered']) || 0;
  let additional = 0;
  if (outcome === 'Reversed') {
    additional = d['Additional Recovered'] === '' ? claimed - original : parseAmount_(d['Additional Recovered']);
    if (!(additional >= 0)) {
      toast_(d['Claim ID'] + ': Additional Recovered must be a positive amount.');
      return;
    }
  }

  const resolved = now_();
  writeCells_(dis, map, row, {
    'Additional Recovered': additional,
    'Date Resolved': resolved,
    'Days to Resolve': daysBetween_(d['Date Filed'], resolved),
  });

  const total = original + additional;
  const claims = sheet_(TABS.CLAIMS);
  const cMap = headerMap_(claims);
  const cRow = findRow_(claims, cMap, 'Claim ID', d['Claim ID']);
  if (cRow > 0) {
    writeCells_(claims, cMap, cRow, { 'Dispute Outcome': outcome, 'Final Recovered': total, 'Claim Status': STATUS.CLOSED });
  }

  const text = outcome === 'Reversed'
    ? '🔓 Dispute for ' + d['Claim ID'] + ' *reversed*: ' + d['Carrier'] + ' paid ' + money_(additional) + ' more. Total recovered ' + money_(total) + ' (' + pct_(total, claimed) + ').'
    : '🔒 Dispute for ' + d['Claim ID'] + ' *upheld*: the ' + d['Original Decision'] + ' decision stands. Total recovered ' + money_(total) + '.';

  slackPost_({
    channel: claimsChannel_(),
    text: text + '\nHandled by ' + mentionOrName_(d['Assigned To']) + ' in ' + plural_(daysBetween_(d['Date Filed'], resolved), 'day') + '.',
    threadTs: threadTs_(d['Slack TS']),
    broadcast: true,
    event: 'dispute_outcome',
  });
}

// ---- Batch processing ----------------------------------------------------------------

/** Menu action: runs every handler over every row (catches edits a trigger missed). */
function processPending() {
  const claims = sheet_(TABS.CLAIMS);
  for (let r = 2; r <= claims.getLastRow(); r++) {
    handleFiled_(r);
    handleCarrierAck_(r);
    handleEscalation_(r);
    handleDecision_(r);
    handleDisputeFiled_(r);
  }
  const esc = sheet_(TABS.ESCALATIONS);
  for (let r = 2; r <= esc.getLastRow(); r++) handleManagerDecision_(r);
  const dis = sheet_(TABS.DISPUTES);
  for (let r = 2; r <= dis.getLastRow(); r++) handleDisputeOutcome_(r);
  toast_('All pending actions processed.');
}
