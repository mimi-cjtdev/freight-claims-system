/**
 * Monitor.gs — the daily deadline monitor, a separate loop from the case flow.
 *
 * Runs every morning on a time trigger (and on demand from the menu). It checks
 * every open claim against four clocks and writes the result to "Deadline Flag":
 *   1. Unassigned       no specialist after 2 days
 *   2. Filing deadline  not filed with the carrier and the 9-month window closes
 *                       within 30 days (urgent within 7 days, or already passed)
 *   3. Ack overdue      filed, but the carrier has not acknowledged within 30 days
 *   4. Response overdue filed, but no carrier decision within 120 days (urgent)
 * Flagged claims are posted to #claims as one digest; the Claims Manager is
 * mentioned when anything is urgent. Clean runs post nothing and only log.
 */

function runDeadlineMonitor() {
  const sh = sheet_(TABS.CLAIMS);
  const map = headerMap_(sh);
  const today = now_();
  const counts = { unassigned: 0, filing: 0, ack: 0, response: 0 };
  const items = [];
  let checked = 0;

  for (let r = 2; r <= sh.getLastRow(); r++) {
    const c = readRow_(sh, map, r);
    if (!c['Claim ID']) continue;

    if (c['Claim Status'] === STATUS.CLOSED || c['Claim Status'] === STATUS.DISPUTE) {
      if (c['Deadline Flag']) writeCells_(sh, map, r, { 'Deadline Flag': '' });
      continue;
    }
    checked++;

    const flags = [];
    let urgent = false;
    const filed = c['Date Filed with Carrier'];

    if (!c['Assigned To'] && c['Submitted At']) {
      const age = daysBetween_(c['Submitted At'], today);
      if (age >= RULES.UNASSIGNED_ALERT_DAYS) { flags.push('Unassigned for ' + plural_(age, 'day')); counts.unassigned++; }
    }

    if (!filed && c['Filing Deadline']) {
      const left = daysBetween_(today, c['Filing Deadline']);
      if (left < 0) {
        flags.push('Filing deadline passed ' + plural_(-left, 'day') + ' ago');
        urgent = true; counts.filing++;
      } else if (left <= RULES.FILING_WARNING_DAYS) {
        flags.push('Filing deadline in ' + plural_(left, 'day') + ' (' + fmtDay_(c['Filing Deadline']) + ')');
        if (left <= RULES.FILING_URGENT_DAYS) urgent = true;
        counts.filing++;
      }
    }

    if (filed && !c['Carrier Ack Date'] && c['Carrier Ack Due']) {
      const over = daysBetween_(c['Carrier Ack Due'], today);
      if (over > 0) { flags.push('Carrier acknowledgment ' + plural_(over, 'day') + ' overdue'); counts.ack++; }
    }

    if (filed && !c['Decision'] && c['Carrier Response Due']) {
      const over = daysBetween_(c['Carrier Response Due'], today);
      if (over > 0) {
        flags.push('Carrier response ' + plural_(over, 'day') + ' past the ' + RULES.CARRIER_RESPONSE_DAYS + '-day limit');
        urgent = true; counts.response++;
      }
    }

    const flagText = flags.join('; ');
    if (flagText !== String(c['Deadline Flag'] || '')) writeCells_(sh, map, r, { 'Deadline Flag': flagText });
    if (flags.length) items.push({ claim: c, flags: flags, urgent: urgent });
  }

  // Urgent first, then by claimed amount.
  items.sort(function (a, b) {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    return (Number(b.claim['Claimed Amount']) || 0) - (Number(a.claim['Claimed Amount']) || 0);
  });

  const anyUrgent = items.some(function (i) { return i.urgent; });
  if (items.length) {
    slackPost_({
      channel: claimsChannel_(),
      text: '🕒 Daily deadline check: ' + plural_(items.length, 'claim') + ' need attention',
      blocks: digestBlocks_(items, anyUrgent),
      event: 'deadline_digest',
    });
  }

  sheet_(TABS.MONITOR_LOG).appendRow([
    today, checked, items.length, counts.unassigned, counts.filing, counts.ack, counts.response,
    items.map(function (i) { return i.claim['Claim ID'] + ': ' + i.flags.join('; '); }).join('\n') || 'All clear',
  ]);
  toast_('Deadline check: ' + checked + ' open, ' + plural_(items.length, 'claim') + ' flagged.');
}
