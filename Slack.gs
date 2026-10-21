/**
 * Slack.gs — every Slack message goes through slackPost_().
 *
 * SLACK_MODE = "live" -> posts with chat.postMessage using SLACK_BOT_TOKEN
 * SLACK_MODE = "mock" -> nothing leaves Google; the message is written to the
 *                        "Notification Log" tab with a placeholder ID, so the
 *                        whole system can be demoed without a Slack workspace.
 * Both modes log to "Notification Log", which doubles as an audit trail.
 */

function slackMode_() {
  return String(prop_('SLACK_MODE', 'mock')).trim().toLowerCase() === 'live' ? 'live' : 'mock';
}

function claimsChannel_() { return prop_('CLAIMS_CHANNEL_ID', '#claims'); }
function escalationChannel_() { return prop_('ESCALATION_CHANNEL_ID', '#claims-escalations'); }
function managerMention_() {
  const id = prop_('MANAGER_SLACK_ID');
  return id ? '<@' + id + '>' : 'Claims Manager';
}

/**
 * Posts a message. Returns { ok, ts, error? }.
 * @param {Object} opts { channel, text, blocks?, threadTs?, broadcast?, event }
 */
function slackPost_(opts) {
  const mode = slackMode_();
  let result;

  if (mode === 'mock') {
    result = { ok: true, ts: 'mock-' + Date.now() + '.' + Math.floor(Math.random() * 1000) };
  } else {
    const token = prop_('SLACK_BOT_TOKEN');
    if (!token) {
      result = { ok: false, ts: '', error: 'SLACK_BOT_TOKEN is not set' };
    } else {
      const payload = { channel: opts.channel, text: opts.text, unfurl_links: false };
      if (opts.blocks) payload.blocks = opts.blocks;
      if (opts.threadTs) payload.thread_ts = opts.threadTs;
      if (opts.threadTs && opts.broadcast) payload.reply_broadcast = true;
      try {
        const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
          method: 'post',
          contentType: 'application/json; charset=utf-8',
          headers: { Authorization: 'Bearer ' + token },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        });
        const body = JSON.parse(res.getContentText());
        result = body.ok ? { ok: true, ts: body.ts } : { ok: false, ts: '', error: body.error };
      } catch (err) {
        result = { ok: false, ts: '', error: String(err) };
      }
    }
  }

  try {
    sheet_(TABS.NOTIF_LOG).appendRow([
      now_(), mode, opts.channel, opts.event || '', opts.text,
      opts.threadTs ? "'" + opts.threadTs : '',
      result.ok ? 'OK ' + result.ts : 'ERROR ' + result.error,
    ]);
  } catch (err) {
    console.error('Could not write Notification Log: ' + err);
  }
  return result;
}

// ---- Block Kit builders ----------------------------------------------------------

function fieldsBlock_(pairs) {
  return {
    type: 'section',
    fields: pairs
      .filter(function (p) { return p[1] !== '' && p[1] !== null && p[1] !== undefined; })
      .map(function (p) { return { type: 'mrkdwn', text: '*' + p[0] + ':*\n' + p[1] }; }),
  };
}
function textBlock_(text) { return { type: 'section', text: { type: 'mrkdwn', text: text } }; }
function contextBlock_(text) { return { type: 'context', elements: [{ type: 'mrkdwn', text: text }] }; }
function headerBlock_(text) { return { type: 'header', text: { type: 'plain_text', text: text, emoji: true } }; }

function truncate_(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** New claim, posted to #claims. */
function newClaimBlocks_(c, autoEscalated) {
  const loadLine = c['Load Number'] + (c['PRO Number'] ? ' / PRO ' + c['PRO Number'] : '');
  const blocks = [
    headerBlock_('📦 New claim ' + c['Claim ID'] + ' · ' + c['Exception Type']),
    fieldsBlock_([
      ['Load', loadLine],
      ['Carrier', c['Carrier']],
      ['Shipper → Consignee', c['Shipper'] + ' → ' + c['Consignee']],
      ['Lane', c['Origin'] + ' → ' + c['Destination']],
      ['Claimed', money_(c['Claimed Amount'])],
      ['Priority', PRIORITY_EMOJI[c['Priority']] + ' ' + c['Priority']],
      ['Delivery date', fmtDay_(c['Delivery Date'])],
      ['Filing deadline', fmtDay_(c['Filing Deadline'])],
    ]),
    textBlock_('*What happened:*\n' + truncate_(c['Description'], 600)),
  ];
  let ctx = 'Reported by ' + (c['Reporter Name'] || c['Reporter Email']) + ' (' + (c['Reporter Role'] || 'n/a') + ')' +
    ' · <' + tabUrl_(TABS.CLAIMS) + '|Open tracker> · React with your emoji to take this claim';
  if (autoEscalated) ctx += '\n🚨 Over ' + money_(RULES.AUTO_ESCALATE_AMOUNT) + ', so it was escalated to the Claims Manager automatically';
  blocks.push(contextBlock_(ctx));
  return blocks;
}

/** Decision, posted as a broadcast reply in the claim's thread. */
function decisionBlocks_(c) {
  const claimed = Number(c['Claimed Amount']) || 0;
  const recovered = Number(c['Amount Recovered']) || 0;
  return [
    textBlock_(DECISION_EMOJI[c['Decision']] + ' *' + c['Claim ID'] + ': ' + c['Decision'] + '*'),
    fieldsBlock_([
      ['Claimed', money_(claimed)],
      ['Recovered', money_(recovered) + ' (' + pct_(recovered, claimed) + ')'],
      ['Carrier', c['Carrier']],
      ['Handled by', mentionOrName_(c['Assigned To'])],
      ['Days to resolve', String(c['Days to Resolve'])],
    ]),
  ];
}

/** Escalation alert for #claims-escalations, mentioning the Claims Manager. */
function escalationBlocks_(c, reason) {
  return [
    headerBlock_('🚨 Escalation ' + c['Claim ID'] + ' · ' + money_(c['Claimed Amount'])),
    textBlock_(managerMention_() + ', this claim needs your review.\n*Why:* ' + reason),
    fieldsBlock_([
      ['Carrier', c['Carrier']],
      ['Shipper', c['Shipper']],
      ['Exception', c['Exception Type']],
      ['Priority', PRIORITY_EMOJI[c['Priority']] + ' ' + c['Priority']],
      ['Specialist', mentionOrName_(c['Assigned To'])],
      ['Filing deadline', fmtDay_(c['Filing Deadline'])],
    ]),
    textBlock_('*What happened:*\n' + truncate_(c['Description'], 500)),
    contextBlock_('<' + tabUrl_(TABS.ESCALATIONS) + '|Open Escalations tab> · set Manager Decision there'),
  ];
}

/** Dispute filed, posted to #claims as its own message so a specialist can claim it. */
function disputeBlocks_(d) {
  return [
    headerBlock_('⚖️ Dispute filed ' + d['Claim ID']),
    fieldsBlock_([
      ['Carrier', d['Carrier']],
      ['Original decision', d['Original Decision']],
      ['Claimed', money_(d['Claimed Amount'])],
      ['Recovered so far', money_(d['Original Recovered'])],
    ]),
    contextBlock_('<' + tabUrl_(TABS.DISPUTES) + '|Open Disputes tab> · React with your emoji to take this dispute'),
  ];
}

/** Daily deadline digest for #claims. */
function digestBlocks_(items, anyUrgent) {
  const MAX = 40;
  const blocks = [headerBlock_('🕒 Daily deadline check · ' + plural_(items.length, 'claim') + (items.length === 1 ? ' needs' : ' need') + ' attention')];
  items.slice(0, MAX).forEach(function (it) {
    const c = it.claim;
    blocks.push(textBlock_(
      (it.urgent ? '🔴' : '🟠') + ' *' + c['Claim ID'] + '* · ' + c['Carrier'] + ' · ' + money_(c['Claimed Amount']) +
      ' · ' + (c['Assigned To'] ? mentionOrName_(c['Assigned To']) : '_Unassigned_') + '\n' + it.flags.join(' · ')));
  });
  if (items.length > MAX) blocks.push(contextBlock_('…and ' + (items.length - MAX) + ' more in the tracker'));
  blocks.push(contextBlock_((anyUrgent ? 'cc ' + managerMention_() + ' · 🔴 = urgent · ' : '') +
    '<' + tabUrl_(TABS.CLAIMS) + '|Open tracker>'));
  return blocks;
}
